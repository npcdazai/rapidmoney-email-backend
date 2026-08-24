import { Router } from "express";
import { query } from "../db.js";
import { requireModule, activityLog } from "../auth/middleware.js";
import { MAIL_SECTIONS } from "../auth/modules.js";
import { parseWorkbook, importRows } from "../services/customers.js";
import { buildExportRows, toWorkbookBuffer, EXPORT_COLUMNS } from "../services/qrcExport.js";

export const customersRouter = Router();

customersRouter.use(activityLog);

// GET /api/customers — search/paginate the customer master.
customersRouter.get("/", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = (req.query.search || "").trim();
    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where = `WHERE lan ILIKE ${p} OR name ILIKE ${p} OR phone ILIKE ${p}
               OR email ILIKE ${p} OR application_id ILIKE ${p} OR loan_id ILIKE ${p}`;
    }
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
// Body (JSON): { data_base64 } for an .xlsx/.xls/.csv file, or { rows: [...] }.
customersRouter.post("/import", requireModule("autoreply"), async (req, res, next) => {
  try {
    let records, skipped = 0, headers = [];
    if (req.body?.data_base64) {
      const buffer = Buffer.from(req.body.data_base64, "base64");
      ({ records, skipped, headers } = parseWorkbook(buffer));
    } else if (Array.isArray(req.body?.rows)) {
      // Already-parsed rows: run through the same header mapping as a 1-row grid
      // would — expect canonical or aliased keys. Normalize minimally here.
      const buffer = rowsToCsvBuffer(req.body.rows);
      ({ records, skipped, headers } = parseWorkbook(buffer));
    } else {
      return res.status(422).json({ detail: "Provide data_base64 (xlsx/csv) or rows[]." });
    }
    if (!records.length)
      return res.status(422).json({ detail: "No usable customer rows found.", headers, skipped });
    const { inserted, updated } = await importRows(records);
    res.json({ inserted, updated, skipped, total: records.length, headers });
  } catch (e) {
    next(e);
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
