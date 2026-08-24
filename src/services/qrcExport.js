// QRC Excel export (#7) — produces the customer-master workbook the business
// maintains, with exactly the required columns, one row per ticket:
//   Customer ID (LAN), Customer Name, Contact NO, Email Details, Types of Mail,
//   Date of Response, TAT, Customer Query, Responded to Customer,
//   Application Id, Loan Id, lenders name, forwarded by.

import * as XLSX from "xlsx";
import { query } from "../db.js";
import { config } from "../config.js";
import { TAT } from "./qrc.js";
import { CATEGORIES } from "./classifier.js";

// Fixed column order and headers, matching the requirements document.
export const EXPORT_COLUMNS = [
  "Customer ID (LAN)",
  "Customer Name",
  "Contact NO",
  "Email Details",
  "Types of Mail",
  "Date of Response",
  "TAT",
  "Customer Query",
  "Responded to Customer",
  "Application Id",
  "Loan Id",
  "lenders name",
  "forwarded by",
];

// Q/R/C group code → the qrc.js group key used for the TAT / "Types of Mail".
const GROUP_FROM_QRC = { query: "query", request: "request", complaint: "complaint" };
const GROUP_FROM_CODE = { Q: "query", R: "request", C: "complaint" };
const TYPES_LABEL = { query: "Query", request: "Request", complaint: "Complaint" };

function groupKey(row) {
  if (row.auto_reply_group && GROUP_FROM_QRC[row.auto_reply_group]) return row.auto_reply_group;
  const code = CATEGORIES[row.category]?.group; // Q / R / C
  return GROUP_FROM_CODE[code] || null;
}

const fmtDate = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { timeZone: config.appTimezone }) : "";

/**
 * Build the export rows for a date window (received_at, in the app timezone).
 * @param {{from?: string, to?: string}} opts  inclusive local-date bounds
 * @returns {Promise<object[]>} rows keyed by EXPORT_COLUMNS
 */
export async function buildExportRows({ from, to } = {}) {
  const tz = config.appTimezone;
  const where = [];
  const params = [];
  if (from) {
    params.push(from);
    where.push(`(t.received_at AT TIME ZONE '${tz}')::date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`(t.received_at AT TIME ZONE '${tz}')::date <= $${params.length}::date`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { rows } = await query(
    `SELECT t.id, t.from_email, t.from_name, t.matched_phone, t.query_summary,
            t.category, t.auto_reply_group, t.auto_reply_routed_to,
            t.auto_replied_at, t.received_at,
            c.lan, c.name AS c_name, c.phone AS c_phone,
            c.application_id, c.loan_id, c.lenders_name,
            r.first_response, r.response_body
       FROM tickets t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN LATERAL (
         SELECT MIN(sent_at) AS first_response,
                (ARRAY_AGG(body ORDER BY sent_at))[1] AS response_body
           FROM ticket_replies
          WHERE ticket_id = t.id AND direction = 'outbound'
       ) r ON TRUE
       ${whereSql}
       ORDER BY t.received_at DESC NULLS LAST`,
    params
  );

  return rows.map((row) => {
    const gk = groupKey(row);
    const responseAt = row.auto_replied_at || row.first_response;
    return {
      "Customer ID (LAN)": row.lan || "",
      "Customer Name": row.c_name || row.from_name || "",
      "Contact NO": row.matched_phone || row.c_phone || "",
      "Email Details": row.from_email || "",
      "Types of Mail": gk ? TYPES_LABEL[gk] : "",
      "Date of Response": fmtDate(responseAt),
      TAT: gk ? TAT[gk] : "",
      "Customer Query": row.query_summary || "",
      "Responded to Customer": (row.response_body || "").replace(/\s+/g, " ").trim() || (responseAt ? "Yes" : "No"),
      "Application Id": row.application_id || "",
      "Loan Id": row.loan_id || "",
      "lenders name": row.lenders_name || "",
      "forwarded by": row.auto_reply_routed_to || "",
    };
  });
}

/** Serialize export rows to an .xlsx workbook buffer. */
export function toWorkbookBuffer(rows) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "QRC");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
