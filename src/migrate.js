import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, query } from "./db.js";
import { config, slaHoursFor } from "./config.js";

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
];

export async function runMigrations() {
  const schema = await readFile(join(__dirname, "schema.sql"), "utf8");
  await query(schema);
  for (const sql of ALTERS) await query(sql);
  await backfillSla();
  console.log("[MIGRATE] schema ready");
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
