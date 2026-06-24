import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, query } from "./db.js";
import { config, slaHoursFor } from "./config.js";
import { classify } from "./services/classifier.js";
import { seedAuth } from "./auth/seed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Idempotent column adds, mirrors the FastAPI startup migration.
const ALTERS = [
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN DEFAULT FALSE",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sentiment_score DOUBLE PRECISION",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(100)",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT FALSE",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_replied BOOLEAN DEFAULT FALSE",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reference VARCHAR(30)",
  // structured auto-reply outcome (for analytics)
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_reply_mode VARCHAR(30)",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_reply_group VARCHAR(12)",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_reply_subcat VARCHAR(40)",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_reply_routed_to VARCHAR(120)",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_reply_confidence DOUBLE PRECISION",
  "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_replied_at TIMESTAMPTZ",
  // widen category from CHAR(1) to hold the new taxonomy codes
  "ALTER TABLE tickets ALTER COLUMN category TYPE VARCHAR(40)",
];

// Map the legacy Q/R/C codes onto the new taxonomy.
const LEGACY_MAP = [
  ["C", "complaint"],
  ["R", "support"],
  ["Q", "inquiry"],
];

export async function runMigrations() {
  const schema = await readFile(join(__dirname, "schema.sql"), "utf8");
  await query(schema);
  for (const sql of ALTERS) await query(sql);
  for (const [old, code] of LEGACY_MAP) {
    await query(`UPDATE tickets SET category = $1 WHERE category = $2`, [code, old]);
  }
  await backfillSla();
  const n = await reclassify(false); // categorize anything still uncategorized
  if (n) console.log(`[MIGRATE] auto-categorized ${n} uncategorized ticket(s)`);
  await seedAuth();
  console.log("[MIGRATE] schema ready");
}

/**
 * Run the keyword classifier over tickets and set category + priority.
 * @param {boolean} all  true = reclassify every ticket; false = only NULL category.
 * Recalculates sla_due_at to match the assigned priority.
 */
export async function reclassify(all = false) {
  const where = all ? "" : "WHERE category IS NULL";
  const { rows } = await query(
    `SELECT id, subject, body, priority FROM tickets ${where}`
  );
  for (const t of rows) {
    const { code, priority } = classify(t.subject || "", t.body || "");
    const hours = slaHoursFor(priority);
    await query(
      `UPDATE tickets
          SET category = $1, priority = $2,
              sla_due_at = received_at + ($3 || ' hours')::interval,
              updated_at = now()
        WHERE id = $4`,
      [code, priority, hours, t.id]
    );
  }
  return rows.length;
}

// Backfill sla_due_at for tickets missing it; silently mark pre-existing
// breaches without firing supervisor alerts (matches Phase 3 behaviour).
async function backfillSla() {
  const hoursExpr = `
    CASE priority
      WHEN 'P1' THEN ${slaHoursFor("P1")}
      WHEN 'P2' THEN ${slaHoursFor("P2")}
      ELSE ${slaHoursFor("P3")}
    END`;

  const { rowCount: filled } = await query(
    `UPDATE tickets
        SET sla_due_at = received_at + (${hoursExpr} || ' hours')::interval
      WHERE sla_due_at IS NULL AND received_at IS NOT NULL`
  );

  const { rowCount: breached } = await query(
    `UPDATE tickets
        SET sla_breached = TRUE
      WHERE sla_breached = FALSE
        AND sla_due_at IS NOT NULL
        AND sla_due_at <= now()`
  );

  if (filled || breached) {
    console.log(
      `[MIGRATE] backfill: sla_due_at set on ${filled}, silently marked ${breached} breached`
    );
  }
}

// Allow `npm run migrate` standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
