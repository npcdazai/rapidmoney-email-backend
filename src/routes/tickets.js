import { Router } from "express";
import { query } from "../db.js";
import { config, slaHoursFor } from "../config.js";
import { sendReply } from "../services/emailSender.js";
import { maybeAutoReply } from "../services/autoReply.js";
import { CATEGORY_CODES, CATEGORIES, GROUPS } from "../services/classifier.js";
import { reclassify } from "../migrate.js";

export const ticketsRouter = Router();

const VALID_STATUS = [
  "Open",
  "In Progress",
  "Pending Customer",
  "Resolved",
  "Closed",
];
const VALID_CATEGORY = CATEGORY_CODES;
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
        COUNT(*) FILTER (WHERE auto_replied = TRUE)                    AS auto_replied_total,
        COUNT(*) FILTER (WHERE auto_replied = TRUE AND is_read = FALSE) AS auto_replied_unread,
        COUNT(*) FILTER (WHERE category IS NULL)                       AS uncategorized_total
      FROM tickets
    `);
    // per-category counts (+ unread) for the new taxonomy
    const cats = await query(
      `SELECT category, COUNT(*) AS count,
              COUNT(*) FILTER (WHERE is_read = FALSE) AS unread
         FROM tickets WHERE category IS NOT NULL GROUP BY category`
    );
    const out = Object.fromEntries(
      Object.entries(rows[0]).map(([k, v]) => [k, Number(v)])
    );
    for (const code of CATEGORY_CODES) {
      out[`cat_${code}`] = 0;
      out[`cat_${code}_unread`] = 0;
    }
    for (const r of cats.rows) {
      out[`cat_${r.category}`] = Number(r.count);
      out[`cat_${r.category}_unread`] = Number(r.unread);
    }
    // QRC group roll-ups (sum of member categories)
    for (const [g, { codes }] of Object.entries(GROUPS)) {
      out[`grp_${g}_total`] = codes.reduce((s, c) => s + out[`cat_${c}`], 0);
      out[`grp_${g}_unread`] = codes.reduce((s, c) => s + out[`cat_${c}_unread`], 0);
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Time-window definitions. SQL fragments are from this fixed map (not user
// input), so string interpolation below is safe.
const DAY = "date_trunc('day', now())";
const RANGES = {
  today: {
    recv: `received_at >= ${DAY} AND received_at < ${DAY} + interval '1 day'`,
    upd: `updated_at >= ${DAY} AND updated_at < ${DAY} + interval '1 day'`,
    trunc: "hour", fmt: "HH24:00",
    series: `generate_series(${DAY}, ${DAY} + interval '23 hours', interval '1 hour')`,
  },
  yesterday: {
    recv: `received_at >= ${DAY} - interval '1 day' AND received_at < ${DAY}`,
    upd: `updated_at >= ${DAY} - interval '1 day' AND updated_at < ${DAY}`,
    trunc: "hour", fmt: "HH24:00",
    series: `generate_series(${DAY} - interval '1 day', ${DAY} - interval '1 hour', interval '1 hour')`,
  },
  week: {
    recv: `received_at >= ${DAY} - interval '6 days'`,
    upd: `updated_at >= ${DAY} - interval '6 days'`,
    trunc: "day", fmt: "Mon DD",
    series: `generate_series(${DAY} - interval '6 days', ${DAY}, interval '1 day')`,
  },
  month: {
    recv: `received_at >= ${DAY} - interval '29 days'`,
    upd: `updated_at >= ${DAY} - interval '29 days'`,
    trunc: "day", fmt: "Mon DD",
    series: `generate_series(${DAY} - interval '29 days', ${DAY}, interval '1 day')`,
  },
  all: {
    recv: "TRUE", upd: "TRUE",
    trunc: "day", fmt: "Mon DD",
    series: `generate_series(${DAY} - interval '29 days', ${DAY}, interval '1 day')`,
  },
};

// GET /api/tickets/analytics?range=today|yesterday|week|month|all
ticketsRouter.get("/analytics", async (req, res, next) => {
  try {
    const range = RANGES[req.query.range] ? req.query.range : "today";
    const R = RANGES[range];
    const num = (result) =>
      Object.fromEntries(
        Object.entries(result.rows[0]).map(([k, v]) => [k, Number(v)])
      );

    const [kpiRes, frtRes, catRes, statRes, prioRes, dailyRes, sendersRes,
           arRes, arGroupRes, arRouteRes, arSubcatRes] =
      await Promise.all([
        // KPIs scoped to the selected window (received_at, except resolved which uses updated_at)
        query(`
          SELECT
            COUNT(*) FILTER (WHERE ${R.recv})                                   AS total,
            COUNT(*) FILTER (WHERE ${R.recv} AND status = 'Open')               AS open,
            COUNT(*) FILTER (WHERE ${R.upd} AND status IN ('Resolved','Closed')) AS resolved,
            COUNT(*) FILTER (WHERE ${R.recv} AND is_read = FALSE)               AS unread,
            COUNT(*) FILTER (WHERE ${R.recv} AND category = 'complaint')        AS complaints,
            COUNT(*) FILTER (WHERE ${R.recv} AND sla_breached = TRUE AND status NOT IN ('Resolved','Closed')) AS breached
          FROM tickets
        `),
        query(`
          SELECT AVG(EXTRACT(EPOCH FROM (fr.first_sent - tickets.received_at)) / 60.0) AS avg_first_response_mins
          FROM tickets
          JOIN (
            SELECT ticket_id, MIN(sent_at) AS first_sent
            FROM ticket_replies WHERE direction = 'outbound' GROUP BY ticket_id
          ) fr ON fr.ticket_id = tickets.id
          WHERE ${R.recv} AND tickets.received_at IS NOT NULL AND fr.first_sent >= tickets.received_at
        `),
        query(`
          SELECT COALESCE(category, 'U') AS key, COUNT(*) AS count
          FROM tickets WHERE ${R.recv} GROUP BY COALESCE(category, 'U')
        `),
        query(`SELECT status, COUNT(*) AS count FROM tickets WHERE ${R.recv} GROUP BY status`),
        query(`SELECT priority, COUNT(*) AS count FROM tickets WHERE ${R.recv} GROUP BY priority`),
        // received vs resolved per bucket (hour or day) across the window, gaps filled
        query(`
          SELECT to_char(g, '${R.fmt}') AS label,
            (SELECT COUNT(*) FROM tickets WHERE date_trunc('${R.trunc}', received_at) = g) AS received,
            (SELECT COUNT(*) FROM tickets
               WHERE status IN ('Resolved','Closed') AND date_trunc('${R.trunc}', updated_at) = g) AS resolved
          FROM ${R.series} g
          ORDER BY g
        `),
        query(`
          SELECT from_email, MAX(from_name) AS from_name, COUNT(*) AS count,
                 COUNT(*) FILTER (WHERE category = 'complaint') AS complaints
          FROM tickets WHERE ${R.recv}
          GROUP BY from_email ORDER BY count DESC LIMIT 6
        `),
        // auto-reply summary (received in window)
        query(`
          SELECT
            COUNT(*) FILTER (WHERE ${R.recv})                                       AS received,
            COUNT(*) FILTER (WHERE ${R.recv} AND auto_replied)                      AS auto_replied,
            COUNT(*) FILTER (WHERE ${R.recv} AND auto_reply_mode = 'query_auto_answer') AS auto_answered,
            AVG(auto_reply_confidence) FILTER (WHERE ${R.recv} AND auto_replied)    AS avg_confidence
          FROM tickets
        `),
        query(`SELECT auto_reply_group AS k, COUNT(*) AS count FROM tickets
                 WHERE ${R.recv} AND auto_replied AND auto_reply_group IS NOT NULL GROUP BY auto_reply_group`),
        query(`SELECT auto_reply_routed_to AS k, COUNT(*) AS count FROM tickets
                 WHERE ${R.recv} AND auto_replied AND auto_reply_routed_to IS NOT NULL
                 GROUP BY auto_reply_routed_to ORDER BY count DESC`),
        query(`SELECT auto_reply_subcat AS k, COUNT(*) AS count FROM tickets
                 WHERE ${R.recv} AND auto_replied AND auto_reply_subcat IS NOT NULL
                 GROUP BY auto_reply_subcat ORDER BY count DESC LIMIT 8`),
      ]);

    const kpis = num(kpiRes);
    const avgFrt = frtRes.rows[0].avg_first_response_mins;
    kpis.avg_first_response_mins = avgFrt == null ? null : Math.round(Number(avgFrt));
    kpis.resolution_rate = kpis.total ? Math.round((kpis.resolved / kpis.total) * 100) : 0;
    const active = kpis.total - kpis.resolved;
    kpis.sla_compliance = active > 0 ? Math.round((1 - kpis.breached / active) * 100) : 100;

    const catLabel = (k) =>
      k === "U" ? "Uncategorized" : CATEGORIES[k]?.label || k;
    res.json({
      range,
      kpis,
      by_category: catRes.rows.map((r) => ({
        key: r.key,
        label: catLabel(r.key),
        count: Number(r.count),
      })),
      by_status: statRes.rows.map((r) => ({ status: r.status, count: Number(r.count) })),
      by_priority: prioRes.rows.map((r) => ({ priority: r.priority, count: Number(r.count) })),
      daily: dailyRes.rows.map((r) => ({
        label: r.label.trim(),
        received: Number(r.received),
        resolved: Number(r.resolved),
      })),
      top_senders: sendersRes.rows.map((r) => ({
        from_email: r.from_email,
        from_name: r.from_name,
        count: Number(r.count),
        complaints: Number(r.complaints),
      })),
      auto_reply: (() => {
        const a = arRes.rows[0];
        const received = Number(a.received);
        const sent = Number(a.auto_replied);
        const answered = Number(a.auto_answered);
        return {
          received,
          sent,
          auto_answered: answered,
          acknowledged: sent - answered,
          deflection_rate: received ? Math.round((sent / received) * 100) : 0,
          auto_answer_rate: sent ? Math.round((answered / sent) * 100) : 0,
          avg_confidence: a.avg_confidence == null ? null : Number(a.avg_confidence),
          by_group: arGroupRes.rows.map((r) => ({ key: r.k, count: Number(r.count) })),
          by_route: arRouteRes.rows.map((r) => ({ key: r.k, count: Number(r.count) })),
          by_subcat: arSubcatRes.rows.map((r) => ({ key: r.k, count: Number(r.count) })),
        };
      })(),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/tickets/reclassify — re-run the keyword classifier.
// body: { all: true } reclassifies every ticket; default only uncategorized.
ticketsRouter.post("/reclassify", async (req, res, next) => {
  try {
    const n = await reclassify(req.body?.all === true);
    res.json({ reclassified: n });
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
    if (req.query.auto_replied === "true") where.push("auto_replied = TRUE");
    if (req.query.unread === "true") where.push("is_read = FALSE");
    if (req.query.uncategorized === "true") where.push("category IS NULL");
    // QRC group filter → member categories
    if (req.query.group && GROUPS[req.query.group]) {
      params.push(GROUPS[req.query.group].codes);
      where.push(`category = ANY($${params.length})`);
    }

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
              is_read, flagged, auto_replied, created_at,
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
    const { body, html, attachments, sent_by = "Agent" } = req.body;
    const hasText = body && body.trim();
    const hasHtml = html && html.trim();
    if (!hasText && !hasHtml)
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
        html,
        attachments,
        messageId: ticket.message_id,
        threadId: ticket.thread_id,
      });
    } catch (e) {
      return res.status(500).json({ detail: `Email send failed: ${e.message}` });
    }

    const attachCount = Array.isArray(attachments) ? attachments.length : 0;
    const storedBody =
      ((hasText ? body : "(formatted message)") +
        (attachCount ? `\n\n📎 ${attachCount} attachment(s)` : "")).trim();
    const { rows: replyRows } = await query(
      `INSERT INTO ticket_replies
         (ticket_id, direction, from_email, to_email, subject, body, sent_by)
       VALUES ($1,'outbound',$2,$3,$4,$5,$6)
       RETURNING id, to_email, subject, sent_at`,
      [ticket.id, config.gmailEmail, ticket.from_email, sent.subject, storedBody, sent_by]
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

// POST /api/tickets/:id/autoreply — manually trigger the grounded auto-reply
ticketsRouter.post("/:id/autoreply", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM tickets WHERE id = $1`, [req.params.id]);
    if (rows.length === 0)
      return res.status(404).json({ detail: "Ticket not found" });
    const sent = await maybeAutoReply(rows[0], { force: true });
    if (!sent)
      return res.status(422).json({
        detail: "Auto-reply not sent (no-reply/automated sender, or send failed).",
      });
    res.json({ ok: true, ticket_id: rows[0].id });
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
