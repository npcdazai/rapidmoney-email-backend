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
import { readFileSync } from "node:fs";
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
  lan: ["lan", "lanno", "lanid", "customerid", "customeridlan", "customerlan", "cust id", "custid", "customercode", "loanaccountnumber", "customerlanid"],
  name: ["name", "customername", "custname", "fullname", "applicantname", "borrowername", "customerfullname"],
  phone: ["phone", "contactno", "contact", "mobile", "mobileno", "mobilenumber", "contactnumber", "phoneno", "phonenumber", "registeredmobile", "registeredmobileno", "registeredmobilenumber", "customermobile", "customercontact", "mobileno"],
  email: ["email", "emaildetails", "emailid", "emailaddress", "mail", "customeremail", "emailidofcustomer", "emailaddressid"],
  application_id: ["applicationid", "appid", "applicationno", "appno", "applicationnumber", "loanapplicationid", "loanapplicationno", "leadid", "lead", "leadno"],
  loan_id: ["loanid", "loanno", "loanaccount", "loanaccountno", "loannumber", "loanaccountnumber", "lenderloannumber", "lenderloanno", "lenderloanid"],
  lenders_name: ["lendersname", "lender", "lendername", "lenders", "nbfc", "nbfcname", "lendingpartner", "lendingpartnername", "partnername", "financer", "financier"],
};

const canon = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Precompute canonical-alias → canonical-column lookup once.
const ALIAS_LOOKUP = (() => {
  const m = {};
  for (const [col, aliases] of Object.entries(HEADER_ALIASES))
    for (const a of aliases) m[canon(a)] = col;
  return m;
})();

// Score a row by how many of its cells look like known column headers.
const headerScore = (row = []) =>
  row.reduce((n, cell) => n + (ALIAS_LOOKUP[canon(String(cell))] ? 1 : 0), 0);

/**
 * Parse a workbook buffer (xlsx/xls/csv) into normalized customer records.
 * The first row is treated as the header row.
 * @returns {{records: object[], skipped: number, headers: string[]}}
 */
export function parseWorkbook(buffer) {
  // `dense: true` stores rows as arrays instead of a cell-address map, which
  // uses far less memory on large sheets.
  return workbookToRecords(XLSX.read(buffer, { type: "buffer", dense: true }));
}

/**
 * Parse a workbook straight from a file on disk. Preferred for large uploads —
 * the request body is streamed to a temp file rather than held in memory.
 * @returns {{records: object[], skipped: number, headers: string[]}}
 */
export function parseWorkbookFile(path) {
  // The xlsx ESM build has no bound fs, so read the bytes ourselves. The upload
  // was already streamed to disk (low memory during transfer); parsing then
  // holds one buffer + the sheet, backed by swap for very large workbooks.
  return workbookToRecords(XLSX.read(readFileSync(path), { type: "buffer", dense: true }));
}

// Pick the first sheet that yields usable rows; fall back to the first sheet's
// headers for diagnostics when none do. Handles workbooks whose data lives on a
// later tab (e.g. "Support" / "Ruloans" / "Sheet2").
function workbookToRecords(wb) {
  let firstHeaders = [];
  let firstDetected = [];
  for (const name of wb.SheetNames || []) {
    const out = sheetToRecords(wb.Sheets[name]);
    if (!firstHeaders.length && out.headers.length) {
      firstHeaders = out.headers;
      firstDetected = out.detectedCols;
    }
    if (out.records.length) return { ...out, sheet: name };
  }
  return { records: [], skipped: 0, headers: firstHeaders, detectedCols: firstDetected };
}

function sheetToRecords(sheet) {
  if (!sheet) return { records: [], skipped: 0, headers: [], detectedCols: [] };
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
  if (!grid.length) return { records: [], skipped: 0, headers: [], detectedCols: [] };

  // Auto-detect the header row: reports often have title/metadata rows on top,
  // so pick the row (within the first 10) that matches the most known columns.
  const scan = Math.min(10, grid.length);
  let headerRow = 0, best = -1;
  for (let r = 0; r < scan; r++) {
    const score = headerScore(grid[r]);
    if (score > best) { best = score; headerRow = r; }
  }

  const headers = (grid[headerRow] || []).map((h) => String(h).trim());
  const hmap = {}; // col index -> canonical column | "extra:<orig>"
  headers.forEach((h, i) => { hmap[i] = ALIAS_LOOKUP[canon(h)] || `extra:${h}`; });
  const detectedCols = [...new Set(Object.values(hmap).filter((v) => !v.startsWith("extra:")))];

  const records = [];
  let skipped = 0;

  for (let r = headerRow + 1; r < grid.length; r++) {
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
  return { records, skipped, headers, detectedCols };
}

const IMPORT_COLS = ["lan", "name", "phone", "email", "application_id", "loan_id", "lenders_name"];
const CHUNK = 2000; // rows per bulk statement (well under Postgres' 65535-param cap)

const extraJson = (rec) =>
  rec.extra && Object.keys(rec.extra).length ? JSON.stringify(rec.extra) : null;

/**
 * Upsert customer records. A record updates an existing customer when it shares
 * a LAN (preferred) or a phone; otherwise it is inserted. Only non-empty
 * incoming fields overwrite existing values, so partial sheets don't wipe data.
 *
 * Batched for large sheets: incoming rows are merged by LAN/phone, routed to
 * INSERT vs UPDATE against a one-time snapshot of existing keys, then written
 * in bulk multi-row statements (~2 orders of magnitude faster than per-row).
 * @returns {{inserted: number, updated: number}}
 */
export async function importRows(records) {
  if (!records.length) return { inserted: 0, updated: 0 };

  // 1) Merge duplicate rows within the import (same LAN, else same phone), so a
  //    single sheet never inserts the same customer twice. Later non-empty wins.
  const byLan = new Map();
  const byPhone = new Map();
  const merged = [];
  const mergeInto = (dst, rec) => {
    for (const c of IMPORT_COLS) if (rec[c] != null && rec[c] !== "") dst[c] = rec[c];
    if (rec.extra && Object.keys(rec.extra).length) dst.extra = { ...(dst.extra || {}), ...rec.extra };
  };
  for (const rec of records) {
    let target =
      (rec.lan && byLan.get(rec.lan)) || (rec.phone && byPhone.get(rec.phone)) || null;
    if (!target) {
      target = { lan: null, name: null, phone: null, email: null, application_id: null, loan_id: null, lenders_name: null, extra: {} };
      merged.push(target);
    }
    mergeInto(target, rec);
    if (target.lan) byLan.set(target.lan, target);
    if (target.phone) byPhone.set(target.phone, target);
  }

  // 2) Snapshot existing keys for just the incoming records (scoped so a single
  //    chunk of a large import doesn't scan the whole table).
  const existLan = new Map();
  const existPhone = new Map();
  {
    const { rows } = await query(
      `SELECT id, lan, phone FROM customers
        WHERE lan = ANY($1::text[]) OR phone = ANY($2::text[])`,
      [[...byLan.keys()], [...byPhone.keys()]]
    );
    for (const r of rows) {
      if (r.lan) existLan.set(r.lan, r.id);
      if (r.phone && !existPhone.has(r.phone)) existPhone.set(r.phone, r.id);
    }
  }
  const inserts = [];
  const updates = [];
  for (const rec of merged) {
    const id =
      (rec.lan && existLan.get(rec.lan)) || (rec.phone && existPhone.get(rec.phone)) || null;
    if (id) updates.push({ id, rec });
    else inserts.push(rec);
  }

  let inserted = 0;
  let updated = 0;

  // 3) Bulk INSERT new rows.
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const slice = inserts.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    slice.forEach((rec, idx) => {
      const b = idx * 8;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8}::jsonb)`);
      params.push(rec.lan, rec.name, rec.phone, rec.email, rec.application_id, rec.loan_id, rec.lenders_name, extraJson(rec));
    });
    await query(
      `INSERT INTO customers (lan, name, phone, email, application_id, loan_id, lenders_name, extra)
       VALUES ${values.join(",")}`,
      params
    );
    inserted += slice.length;
  }

  // 4) Bulk UPDATE existing rows via UPDATE ... FROM (VALUES ...). COALESCE keeps
  //    the current value when the incoming field is empty.
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    slice.forEach(({ id, rec }, idx) => {
      const b = idx * 9;
      values.push(
        `($${b + 1}::int,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::jsonb)`
      );
      params.push(id, rec.lan, rec.name, rec.phone, rec.email, rec.application_id, rec.loan_id, rec.lenders_name, extraJson(rec));
    });
    await query(
      `UPDATE customers c SET
         lan            = COALESCE(v.lan, c.lan),
         name           = COALESCE(v.name, c.name),
         phone          = COALESCE(v.phone, c.phone),
         email          = COALESCE(v.email, c.email),
         application_id = COALESCE(v.application_id, c.application_id),
         loan_id        = COALESCE(v.loan_id, c.loan_id),
         lenders_name   = COALESCE(v.lenders_name, c.lenders_name),
         extra          = COALESCE(v.extra, c.extra),
         updated_at     = now()
       FROM (VALUES ${values.join(",")})
         AS v(id, lan, name, phone, email, application_id, loan_id, lenders_name, extra)
       WHERE c.id = v.id`,
      params
    );
    updated += slice.length;
  }

  return { inserted, updated };
}
