// Customer master — the reference database imported from the "Customer Master"
// Excel/CSV. Provides:
//   • detectPhones()  — pull 10-digit Indian mobile numbers out of an email
//   • normalizePhone()— reduce any raw number to its canonical 10 digits
//   • matchCustomer() — identify the emailing customer from the master data
//   • parseWorkbook() / importRows() — bulk import the sheet
//
// Implements the QRC Email Automation requirements: 10-digit detection (#4),
// customer master (#6) and customer matching used by the workflow (#10).

import * as XLSX from "xlsx";
import { query } from "../db.js";

// ───────────────────────── 10-digit number detection ─────────────────────────

// A run that looks like an Indian mobile: an optional +91 / 91 / 0 prefix
// followed by a 10-digit number starting 6–9. The (?<!\d) / (?!\d) guards stop
// us from matching a 10-digit window *inside* a longer number (e.g. a 12-digit
// Aadhaar or a transaction reference), which would be a false customer match.
const PHONE_RE = /(?<!\d)(?:\+?91[\s-]?|0)?([6-9]\d{9})(?!\d)/g;

/** Reduce any raw phone string to its canonical 10 digits (or null). */
export function normalizePhone(raw = "") {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10); // drop 91/0 country/trunk prefixes
  return /^[6-9]\d{9}$/.test(last10) ? last10 : null;
}

/**
 * Detect every distinct 10-digit mobile number in an email (subject + body).
 * @returns {string[]} normalized 10-digit numbers, in first-seen order.
 */
export function detectPhones(subject = "", body = "") {
  const text = `${subject}\n${body}`;
  const seen = new Set();
  let m;
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text)) !== null) {
    const p = normalizePhone(m[1]);
    if (p) seen.add(p);
  }
  return [...seen];
}

// ───────────────────────────── Customer matching ─────────────────────────────

/**
 * Identify the emailing customer against the master data. Matching order
 * follows reliability: a detected 10-digit number first (spec #4), then any
 * explicit identifiers, then the sender's email address as a last resort.
 *
 * @param {object} sig  { phones?: string[], lan?, applicationId?, loanId?, email? }
 * @returns {object|null} the matched customers row (with a `_matched_by` tag), or null
 */
export async function matchCustomer({ phones = [], lan, applicationId, loanId, email } = {}) {
  // 1) By any detected 10-digit mobile number.
  for (const phone of phones) {
    const { rows } = await query(`SELECT * FROM customers WHERE phone = $1 LIMIT 1`, [phone]);
    if (rows[0]) return { ...rows[0], _matched_by: "phone", _matched_value: phone };
  }
  // 2) By explicit identifiers if present.
  const byCol = [
    ["lan", lan],
    ["application_id", applicationId],
    ["loan_id", loanId],
  ];
  for (const [col, val] of byCol) {
    if (!val) continue;
    const { rows } = await query(`SELECT * FROM customers WHERE ${col} = $1 LIMIT 1`, [String(val)]);
    if (rows[0]) return { ...rows[0], _matched_by: col, _matched_value: val };
  }
  // 3) By the sender's email address.
  if (email) {
    const { rows } = await query(
      `SELECT * FROM customers WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );
    if (rows[0]) return { ...rows[0], _matched_by: "email", _matched_value: email };
  }
  return null;
}

// ─────────────────────────────── Import (Excel/CSV) ───────────────────────────

// Header aliases → canonical column. Matching is case-insensitive and ignores
// spaces/underscores/punctuation, so "Customer ID (LAN)", "customer_id",
// "LAN" all map to `lan`.
const HEADER_ALIASES = {
  lan: ["lan", "customerid", "customeridlan", "customerlan", "cust id", "custid"],
  name: ["name", "customername", "custname", "fullname"],
  phone: ["phone", "contactno", "contact", "mobile", "mobileno", "contactnumber", "phoneno"],
  email: ["email", "emaildetails", "emailid", "emailaddress", "mail"],
  application_id: ["applicationid", "appid", "applicationno", "appno"],
  loan_id: ["loanid", "loanno", "loanaccount", "loanaccountno"],
  lenders_name: ["lendersname", "lender", "lendername", "lenders", "nbfc", "lendingpartner"],
};

const canon = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

function buildHeaderMap(headers) {
  const map = {}; // sourceIndex -> canonical column (or "extra:<orig>")
  const aliasLookup = {};
  for (const [col, aliases] of Object.entries(HEADER_ALIASES))
    for (const a of aliases) aliasLookup[canon(a)] = col;
  headers.forEach((h, i) => {
    const key = canon(h);
    map[i] = aliasLookup[key] || `extra:${String(h).trim()}`;
  });
  return map;
}

/**
 * Parse a workbook buffer (xlsx/xls/csv) into normalized customer records.
 * The first row is treated as the header row.
 * @returns {{records: object[], skipped: number, headers: string[]}}
 */
export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { records: [], skipped: 0, headers: [] };
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
  if (grid.length < 2) return { records: [], skipped: 0, headers: grid[0] || [] };

  const headers = grid[0].map((h) => String(h).trim());
  const hmap = buildHeaderMap(headers);
  const records = [];
  let skipped = 0;

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const rec = { lan: null, name: null, phone: null, email: null, application_id: null, loan_id: null, lenders_name: null, extra: {} };
    for (let c = 0; c < row.length; c++) {
      const target = hmap[c];
      if (target === undefined) continue;
      const raw = row[c];
      const val = raw === "" || raw == null ? null : String(raw).trim();
      if (target.startsWith("extra:")) {
        if (val != null) rec.extra[target.slice(6)] = val;
      } else if (target === "phone") {
        rec.phone = normalizePhone(val || "");
      } else {
        rec[target] = val;
      }
    }
    // A usable record needs at least one identifier to match on later.
    if (!rec.lan && !rec.phone && !rec.email && !rec.application_id && !rec.loan_id) {
      skipped++;
      continue;
    }
    records.push(rec);
  }
  return { records, skipped, headers };
}

/**
 * Upsert customer records. A record updates an existing customer when it shares
 * a LAN (preferred) or a phone; otherwise it is inserted. Only non-empty
 * incoming fields overwrite existing values, so partial sheets don't wipe data.
 * @returns {{inserted: number, updated: number}}
 */
export async function importRows(records) {
  let inserted = 0,
    updated = 0;
  for (const rec of records) {
    const extra = rec.extra && Object.keys(rec.extra).length ? JSON.stringify(rec.extra) : null;

    // Find an existing row to update (LAN first, then phone).
    let existing = null;
    if (rec.lan) {
      const { rows } = await query(`SELECT id FROM customers WHERE lan = $1 LIMIT 1`, [rec.lan]);
      existing = rows[0] || null;
    }
    if (!existing && rec.phone) {
      const { rows } = await query(`SELECT id FROM customers WHERE phone = $1 LIMIT 1`, [rec.phone]);
      existing = rows[0] || null;
    }

    if (existing) {
      await query(
        `UPDATE customers SET
           lan            = COALESCE($2, lan),
           name           = COALESCE($3, name),
           phone          = COALESCE($4, phone),
           email          = COALESCE($5, email),
           application_id = COALESCE($6, application_id),
           loan_id        = COALESCE($7, loan_id),
           lenders_name   = COALESCE($8, lenders_name),
           extra          = COALESCE($9::jsonb, extra),
           updated_at     = now()
         WHERE id = $1`,
        [existing.id, rec.lan, rec.name, rec.phone, rec.email, rec.application_id, rec.loan_id, rec.lenders_name, extra]
      );
      updated++;
    } else {
      await query(
        `INSERT INTO customers (lan, name, phone, email, application_id, loan_id, lenders_name, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [rec.lan, rec.name, rec.phone, rec.email, rec.application_id, rec.loan_id, rec.lenders_name, extra]
      );
      inserted++;
    }
  }
  return { inserted, updated };
}
