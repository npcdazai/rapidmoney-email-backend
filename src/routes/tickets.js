import { Router } from "express";
import { query } from "../db.js";
import { config, slaHoursFor } from "../config.js";
import { sendReply } from "../services/emailSender.js";

export const ticketsRouter = Router();

const VALID_STATUS = [
  "Open",
  "In Progress",
  "Pending Customer",
  "Resolved",
  "Closed",
];
const VALID_CATEGORY = ["Q", "R", "C"];
const VALID_PRIORITY = ["P1", "P2", "P3"];

// GET /api/tickets/stats — dashboard counters
ticketsRouter.get("/stats", async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*)                                              AS total,
        COUNT(*) FILTER (WHERE status = 'Open')               AS open,
        COUNT(*) FILTER (WHERE status = 'In Progress')        AS in_progress,
        COUNT(*) FILTER (WHERE status IN ('Resolved','Closed')) AS resolved,
        COUNT(*) FILTER (WHERE category = 'Q')                AS query,
        COUNT(*) FILTER (WHERE category = 'R')                AS request,
        COUNT(*) FILTER (WHERE category = 'C')                AS complaint,
        COUNT(*) FILTER (WHERE category IS NULL)              AS uncategorized,
        COUNT(*) FILTER (WHERE sla_breached = TRUE
                          AND status NOT IN ('Resolved','Closed')) AS sla_breached
      FROM tickets
    `);
    const r = rows[0];
    // pg returns COUNT as strings — coerce to numbers
    const out = Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, Number(v)])
    );
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// GET /api/tickets/folders — per-folder counts + unread counts for the nav
ticketsRouter.get("/folders", async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*)                                                       AS all_total,
        COUNT(*) FILTER (WHERE status NOT IN ('Resolved','Closed'))    AS inbox_total,
        COUNT(*) FILTER (WHERE status NOT IN ('Resolved','Closed') AND is_read = FALSE) AS inbox_unread,
        COUNT(*) FILTER (WHERE status = 'Open')                        AS open_total,
        COUNT(*) FILTER (WHERE status = 'Open' AND is_read = FALSE)    AS open_unread,
        COUNT(*) FILTER (WHERE status = 'In Progress')                 AS in_progress_total,
        COUNT(*) FILTER (WHERE status = 'Pending Customer')            AS pending_total,
        COUNT(*) FILTER (WHERE status IN ('Resolved','Closed'))        AS resolved_total,
        COUNT(*) FILTER (WHERE flagged = TRUE)                         AS flagged_total,
        COUNT(*) FILTER (WHERE sla_breached = TRUE AND status NOT IN ('Resolved','Closed')) AS breached_total,
        COUNT(*) FILTER (WHERE category = 'Q')                         AS query_total,
        COUNT(*) FILTER (WHERE category = 'R')                         AS request_total,
        COUNT(*) FILTER (WHERE category = 'C')                         AS complaint_total,
        COUNT(*) FILTER (WHERE category IS NULL)                       AS uncategorized_total
      FROM tickets
    `);
    res.json(
      Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]))
    );
  } catch (e) {
    next(e);
  }
});

// GET /api/tickets — list with filters
ticketsRouter.get("/", async (req, res, next) => {
  try {
    const { category, status, priority, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
    const offset = parseInt(req.query.offset, 10) || 0;

    const where = [];
    const params = [];
    const add = (clause, val) => {
      params.push(val);
      where.push(clause.replace("?", `$${params.length}`));
    };

    if (category) add("category = ?", category);
    if (status) add("status = ?", status);
    if (priority) add("priority = ?", priority);

    // Outlook-style smart folders
    if (req.query.inbox === "true")
      where.push("status NOT IN ('Resolved','Closed')");
    if (req.query.breached === "true")
      where.push("sla_breached = TRUE AND status NOT IN ('Resolved','Closed')");
    if (req.query.flagged === "true") where.push("flagged = TRUE");
    if (req.query.unread === "true") where.push("is_read = FALSE");
    if (req.query.uncategorized === "true") where.push("category IS NULL");

    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where.push(
        `(from_email ILIKE ${p} OR subject ILIKE ${p} OR from_name ILIKE ${p} OR body ILIKE ${p})`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT id, from_email, from_name, subject, received_at,
              category, priority, status, sla_due_at, sla_breached,
              is_read, flagged, created_at,
              LEFT(regexp_replace(COALESCE(body,''), '\\s+', ' ', 'g'), 160) AS snippet
         FROM tickets
         ${whereSql}
         ORDER BY received_at DESC NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// GET /api/tickets/:id — full detail with notes + replies
ticketsRouter.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM tickets WHERE id = $1`, [
      req.params.id,
    ]);
    if (rows.length === 0)
      return res.status(404).json({ detail: "Ticket not found" });

    const ticket = rows[0];
    // Opening a ticket marks it read (Outlook behaviour)
    if (!ticket.is_read) {
      await query(`UPDATE tickets SET is_read = TRUE WHERE id = $1`, [ticket.id]);
      ticket.is_read = true;
    }
    const [{ rows: notes }, { rows: replies }] = await Promise.all([
      query(
        `SELECT id, note, is_internal, created_by, created_at
           FROM ticket_notes WHERE ticket_id = $1 ORDER BY created_at`,
        [ticket.id]
      ),
      query(
        `SELECT id, direction, from_email, to_email, subject, body, sent_by, sent_at
           FROM ticket_replies WHERE ticket_id = $1 ORDER BY sent_at`,
        [ticket.id]
      ),
    ]);
    res.json({ ...ticket, notes, replies });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/tickets/:id/status
ticketsRouter.patch("/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUS.includes(status))
      return res.status(422).json({ detail: `Invalid status: ${status}` });

    const { rows } = await query(
      `UPDATE tickets SET status = $1, updated_at = now()
        WHERE id = $2 RETURNING id, status`,
      [status, req.params.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ detail: "Ticket not found" });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/tickets/:id/read — mark read/unread
ticketsRouter.patch("/:id/read", async (req, res, next) => {
  try {
    const is_read = req.body.is_read !== false; // default true
    const { rows } = await query(
      `UPDATE tickets SET is_read = $1 WHERE id = $2 RETURNING id, is_read`,
      [is_read, req.params.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ detail: "Ticket not found" });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/tickets/:id/flag — flag/unflag for follow-up
ticketsRouter.patch("/:id/flag", async (req, res, next) => {
  try {
    const flagged = req.body.flagged !== false; // default true
    const { rows } = await query(
      `UPDATE tickets SET flagged = $1, updated_at = now()
        WHERE id = $2 RETURNING id, flagged`,
      [flagged, req.params.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ detail: "Ticket not found" });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/tickets/:id/category — set category/sub_category/priority,
// recalculating sla_due_at when priority changes.
ticketsRouter.patch("/:id/category", async (req, res, next) => {
  try {
    const { category, sub_category = null, priority } = req.body;
    if (!VALID_CATEGORY.includes(category))
      return res.status(422).json({ detail: `Invalid category: ${category}` });
    if (priority && !VALID_PRIORITY.includes(priority))
      return res.status(422).json({ detail: `Invalid priority: ${priority}` });

    let sql, params;
    if (priority) {
      const hours = slaHoursFor(priority);
      sql = `UPDATE tickets
                SET category = $1, sub_category = $2, priority = $3,
                    sla_due_at = received_at + ($4 || ' hours')::interval,
                    updated_at = now()
              WHERE id = $5 RETURNING id, category, priority`;
      params = [category, sub_category, priority, hours, req.params.id];
    } else {
      sql = `UPDATE tickets
                SET category = $1, sub_category = $2, updated_at = now()
              WHERE id = $3 RETURNING id, category, priority`;
      params = [category, sub_category, req.params.id];
    }

    const { rows } = await query(sql, params);
    if (rows.length === 0)
      return res.status(404).json({ detail: "Ticket not found" });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/tickets/:id/reply — email the customer + record the reply
ticketsRouter.post("/:id/reply", async (req, res, next) => {
  try {
    const { body, sent_by = "Agent" } = req.body;
    if (!body || !body.trim())
      return res.status(422).json({ detail: "Reply body is required" });

    const { rows } = await query(`SELECT * FROM tickets WHERE id = $1`, [
      req.params.id,
    ]);
    if (rows.length === 0)
      return res.status(404).json({ detail: "Ticket not found" });
    const ticket = rows[0];

    let sent;
    try {
      sent = await sendReply({
        to: ticket.from_email,
        subject: ticket.subject || "(no subject)",
        body,
        messageId: ticket.message_id,
        threadId: ticket.thread_id,
      });
    } catch (e) {
      return res.status(500).json({ detail: `Email send failed: ${e.message}` });
    }

    const { rows: replyRows } = await query(
      `INSERT INTO ticket_replies
         (ticket_id, direction, from_email, to_email, subject, body, sent_by)
       VALUES ($1,'outbound',$2,$3,$4,$5,$6)
       RETURNING id, to_email, subject, sent_at`,
      [ticket.id, config.gmailEmail, ticket.from_email, sent.subject, body, sent_by]
    );

    // Open -> In Progress on first agent reply
    let newStatus = ticket.status;
    if (ticket.status === "Open") {
      await query(
        `UPDATE tickets SET status = 'In Progress', updated_at = now() WHERE id = $1`,
        [ticket.id]
      );
      newStatus = "In Progress";
    }

    res.json({
      id: replyRows[0].id,
      to: replyRows[0].to_email,
      subject: replyRows[0].subject,
      sent_at: replyRows[0].sent_at,
      ticket_status: newStatus,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/tickets/:id/notes — internal note
ticketsRouter.post("/:id/notes", async (req, res, next) => {
  try {
    const { note, is_internal = true, created_by = "Agent" } = req.body;
    if (!note || !note.trim())
      return res.status(422).json({ detail: "Note is required" });

    const exists = await query(`SELECT 1 FROM tickets WHERE id = $1`, [
      req.params.id,
    ]);
    if (exists.rows.length === 0)
      return res.status(404).json({ detail: "Ticket not found" });

    const { rows } = await query(
      `INSERT INTO ticket_notes (ticket_id, note, is_internal, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id, ticket_id, note`,
      [req.params.id, note, is_internal, created_by]
    );
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});
