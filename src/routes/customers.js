import { Router } from "express";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { config } from "../config.js";
import { query } from "../db.js";
import { requireModule, activityLog } from "../auth/middleware.js";
import { MAIL_SECTIONS } from "../auth/modules.js";
import { parseWorkbook, parseWorkbookFile, importRows } from "../services/customers.js";
import { buildExportRows, toWorkbookBuffer, EXPORT_COLUMNS } from "../services/qrcExport.js";

export const customersRouter = Router();

customersRouter.use(activityLog);

// GET /api/customers — search/paginate the customer master.
customersRouter.get("/", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = (req.query.search || "").trim();
    const lender = (req.query.lender || "").trim();
    const missing = (req.query.missing || "").trim(); // email|phone|application_id|loan_id

    const params = [];
    const conds = [];
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      conds.push(
        `(lan ILIKE ${p} OR name ILIKE ${p} OR phone ILIKE ${p}
          OR email ILIKE ${p} OR application_id ILIKE ${p} OR loan_id ILIKE ${p})`
      );
    }
    if (lender) {
      params.push(lender);
      conds.push(`lenders_name = $${params.length}`);
    }
    // "Missing" quick filter — rows where a chosen column is empty/absent.
    const MISSING_COLS = { email: "email", phone: "phone", application_id: "application_id", loan_id: "loan_id" };
    if (MISSING_COLS[missing]) {
      const col = MISSING_COLS[missing];
      conds.push(`(${col} IS NULL OR ${col} = '' OR ${col} = 'N/A')`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT id, lan, name, phone, email, application_id, loan_id, lenders_name,
              updated_at, COUNT(*) OVER() AS total_count
         FROM customers ${where}
        ORDER BY updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = rows.length ? Number(rows[0].total_count) : 0;
    res.json({ items: rows.map(({ total_count, ...r }) => r), total, limit, offset });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/customers — clear the ENTIRE customer master. Available to any
// authenticated user (per request); still requires an explicit confirm flag.
// Tickets keep their history (customer_id is set null by the FK on delete).
customersRouter.delete("/", async (req, res, next) => {
  try {
    if (req.query.confirm !== "true")
      return res.status(400).json({ detail: "Pass ?confirm=true to clear all customer data." });
    // Plain DELETE (not TRUNCATE CASCADE) so the tickets FK fires ON DELETE SET
    // NULL — ticket history is preserved, only the customer link is cleared.
    const { rowCount } = await query(`DELETE FROM customers`);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    next(e);
  }
});

// GET /api/customers/export.xlsx?from=&to= — the 13-column QRC workbook (#7).
customersRouter.get("/export.xlsx", requireModule("analytics"), async (req, res, next) => {
  try {
    const rows = await buildExportRows({ from: req.query.from, to: req.query.to });
    const buf = toWorkbookBuffer(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="QRC_Export_${stamp}.xlsx"`);
    res.send(buf);
  } catch (e) {
    next(e);
  }
});

// GET /api/customers/export.json — same rows as JSON (for a UI preview).
customersRouter.get("/export.json", requireModule("analytics"), async (req, res, next) => {
  try {
    const rows = await buildExportRows({ from: req.query.from, to: req.query.to });
    res.json({ columns: EXPORT_COLUMNS, rows });
  } catch (e) {
    next(e);
  }
});

// POST /api/customers/import — import the customer-master sheet (#6).
//
// Two upload modes:
//   • JSON body { data_base64 } or { rows: [...] } — convenient for small files.
//   • Raw binary body (any non-JSON content-type) — the file is streamed to a
//     temp file on disk and parsed from there, so large workbooks never sit in
//     memory as a base64 string. This is the path the UI uses.
customersRouter.post("/import", requireModule("autoreply"), async (req, res, next) => {
  try {
    let records, skipped = 0, headers = [];

    if (req.is("application/json")) {
      if (req.body?.data_base64) {
        ({ records, skipped, headers } = parseWorkbook(Buffer.from(req.body.data_base64, "base64")));
      } else if (Array.isArray(req.body?.rows)) {
        ({ records, skipped, headers } = parseWorkbook(rowsToCsvBuffer(req.body.rows)));
      } else {
        return res.status(422).json({ detail: "Provide data_base64 (xlsx/csv) or rows[]." });
      }
    } else {
      // Stream the raw request body to a temp file, then parse it from disk.
      const tmp = join(tmpdir(), `cust-import-${randomUUID()}`);
      try {
        await new Promise((resolve, reject) => {
          const ws = createWriteStream(tmp);
          req.on("error", reject);
          ws.on("error", reject);
          ws.on("finish", resolve);
          req.pipe(ws);
        });
        ({ records, skipped, headers } = parseWorkbookFile(tmp));
      } finally {
        await unlink(tmp).catch(() => {});
      }
    }

    if (!records.length)
      return res.status(422).json({ detail: "No usable customer rows found.", headers, skipped });
    const { inserted, updated } = await importRows(records);
    res.json({ inserted, updated, skipped, total: records.length, headers });
  } catch (e) {
    next(e);
  }
});

// GET /api/customers/queries — every email query from a customer in the master
// (matched by the stored link or by email), with whether a response was sent.
customersRouter.get("/queries", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = (req.query.search || "").trim();
    const responded = req.query.responded; // "true" | "false" | undefined

    const respExpr =
      `(t.auto_replied OR EXISTS (SELECT 1 FROM ticket_replies r WHERE r.ticket_id = t.id AND r.direction = 'outbound'))`;

    const params = [];
    const conds = [];
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      conds.push(
        `(t.subject ILIKE ${p} OR t.from_email ILIKE ${p} OR t.query_summary ILIKE ${p}
          OR c.name ILIKE ${p} OR c.lan ILIKE ${p})`
      );
    }
    if (responded === "true") conds.push(respExpr);
    if (responded === "false") conds.push(`NOT ${respExpr}`);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT t.id, t.subject, t.from_email, t.from_name, t.received_at, t.status,
              t.query_summary, t.category,
              c.id AS customer_id, c.lan, c.name AS customer_name, c.phone AS customer_phone,
              ${respExpr} AS responded,
              COUNT(*) OVER() AS total_count
         FROM tickets t
         JOIN LATERAL (
           SELECT id, lan, name, phone, email FROM customers
            WHERE id = t.customer_id OR lower(email) = lower(t.from_email)
            LIMIT 1
         ) c ON TRUE
         ${where}
         ORDER BY t.received_at DESC NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = rows.length ? Number(rows[0].total_count) : 0;
    res.json({ items: rows.map(({ total_count, ...r }) => r), total, limit, offset });
  } catch (e) {
    next(e);
  }
});

// GET /api/customers/lenders — distinct lender values (with counts) for the
// table's Lender filter dropdown.
customersRouter.get("/lenders", requireModule(...MAIL_SECTIONS), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT lenders_name AS lender, COUNT(*) AS count
         FROM customers
        WHERE lenders_name IS NOT NULL AND lenders_name <> ''
        GROUP BY lenders_name
        ORDER BY count DESC`
    );
    res.json({ lenders: rows.map((r) => ({ lender: r.lender, count: Number(r.count) })) });
  } catch (e) {
    next(e);
  }
});

// GET /api/customers/:id/tickets — a customer's email correspondence: each
// ticket (their query) plus every reply we sent/received. Matches by the stored
// customer link, and also by email/phone so mail ingested before the master
// existed still shows up.
customersRouter.get("/:id/tickets", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { rows: crows } = await query(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    if (!crows.length) return res.status(404).json({ detail: "Customer not found" });
    const c = crows[0];

    const { rows: tickets } = await query(
      `SELECT id, subject, from_email, from_name, received_at, status, category, priority,
              body, query_summary, matched_phone, auto_replied, reference
         FROM tickets
        WHERE customer_id = $1
           OR ($2::text IS NOT NULL AND lower(from_email) = lower($2))
           OR ($3::text IS NOT NULL AND matched_phone = $3)
        ORDER BY received_at DESC NULLS LAST
        LIMIT 200`,
      [c.id, c.email || null, c.phone || null]
    );

    const byTicket = {};
    if (tickets.length) {
      const { rows: replies } = await query(
        `SELECT ticket_id, direction, from_email, to_email, subject, body, sent_by, sent_at
           FROM ticket_replies WHERE ticket_id = ANY($1) ORDER BY sent_at`,
        [tickets.map((t) => t.id)]
      );
      for (const r of replies) (byTicket[r.ticket_id] ||= []).push(r);
    }

    res.json({
      customer: c,
      tickets: tickets.map((t) => ({ ...t, replies: byTicket[t.id] || [] })),
    });
  } catch (e) {
    next(e);
  }
});

// ── Manual QRC entries (agent-typed rows in the customer modal) ──
const ENTRY_COLS =
  `id, customer_id, complain_date::text AS complain_date, type_of_mail,
   customer_query, response_date::text AS response_date, responded_to_customer,
   created_by, created_at`;

// Light HTML sanitizer for agent-entered rich text — strips executable markup
// and event handlers so stored HTML can't run script when rendered.
function sanitizeHtml(s) {
  if (s == null) return null;
  return String(s)
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|base)\b[^>]*>/gi, "")
    .replace(/ on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/ on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/ on\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "")
    .slice(0, 20000);
}

// GET /api/customers/:id/entries — manual entries for a customer.
customersRouter.get("/:id/entries", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${ENTRY_COLS} FROM customer_entries
        WHERE customer_id = $1 ORDER BY complain_date DESC NULLS LAST, id DESC`,
      [req.params.id]
    );
    res.json({ items: rows });
  } catch (e) {
    next(e);
  }
});

// POST /api/customers/:id/entries — add a manual entry.
customersRouter.post("/:id/entries", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { complain_date, type_of_mail, customer_query, response_date, responded_to_customer } = req.body || {};
    const exists = await query(`SELECT 1 FROM customers WHERE id = $1`, [req.params.id]);
    if (!exists.rows.length) return res.status(404).json({ detail: "Customer not found" });
    const by = req.user?.name || req.user?.email || "Agent";
    const { rows } = await query(
      `INSERT INTO customer_entries (customer_id, complain_date, type_of_mail, customer_query, response_date, responded_to_customer, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${ENTRY_COLS}`,
      [req.params.id, complain_date || null, type_of_mail || null, sanitizeHtml(customer_query), response_date || null, sanitizeHtml(responded_to_customer), by]
    );
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/customers/entries/:eid — edit a manual entry.
customersRouter.patch("/entries/:eid", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { complain_date, type_of_mail, customer_query, response_date, responded_to_customer } = req.body || {};
    const { rows } = await query(
      `UPDATE customer_entries
          SET complain_date = $2, type_of_mail = $3, customer_query = $4,
              response_date = $5, responded_to_customer = $6, updated_at = now()
        WHERE id = $1 RETURNING ${ENTRY_COLS}`,
      [req.params.eid, complain_date || null, type_of_mail || null, sanitizeHtml(customer_query), response_date || null, sanitizeHtml(responded_to_customer)]
    );
    if (!rows.length) return res.status(404).json({ detail: "Entry not found" });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/customers/entries/:eid — remove a manual entry.
customersRouter.delete("/entries/:eid", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM customer_entries WHERE id = $1`, [req.params.eid]);
    if (!rowCount) return res.status(404).json({ detail: "Entry not found" });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// GET /api/customers/:id/inbox — live IMAP check: does the support inbox have
// any mail from this customer's email address? Returns recent matches (envelope
// only — subject/date/read-state), most recent first.
customersRouter.get("/:id/inbox", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, email FROM customers WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ detail: "Customer not found" });
    const email = (rows[0].email || "").trim();
    if (!email || email.toLowerCase() === "n/a")
      return res.json({ email: null, count: 0, messages: [] });

    if (!config.gmailAppPassword)
      return res.json({ email, count: 0, messages: [], error: "Mailbox not configured" });

    const client = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: true,
      auth: { user: config.gmailEmail, pass: config.gmailAppPassword },
      logger: false,
    });

    const messages = [];
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        let uids = await client.search({ from: email }, { uid: true });
        uids = (uids || []).sort((a, b) => b - a).slice(0, 25); // newest 25
        if (uids.length) {
          for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
            const env = msg.envelope || {};
            messages.push({
              uid: msg.uid,
              subject: env.subject || "(no subject)",
              date: env.date || null,
              from: env.from?.[0]?.address || "",
              seen: msg.flags ? msg.flags.has("\\Seen") : true,
            });
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }

    messages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    res.json({ email, count: messages.length, messages });
  } catch (e) {
    console.error(`[customers/inbox] ${e.message}`);
    res.json({ email: null, count: 0, messages: [], error: e.message });
  }
});

// GET /api/customers/:id — single customer with any extra source columns.
customersRouter.get("/:id", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ detail: "Customer not found" });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// Serialize an array of plain objects to a CSV buffer so the same xlsx-backed
// header mapping handles both file uploads and JSON row payloads.
function rowsToCsvBuffer(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return Buffer.from(lines.join("\n"), "utf8");
}
