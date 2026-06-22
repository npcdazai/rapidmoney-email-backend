import { config } from "../config.js";
import { query } from "../db.js";
import { sendSlaAlert } from "./emailSender.js";

let timer = null;

/**
 * Find tickets whose SLA has elapsed but aren't yet flagged. Mark them
 * breached, force priority to P1, and stamp escalated_at. Supervisor alert
 * emails only fire when SLA_ALERTS_ENABLED=true (paused by default).
 */
async function checkOnce() {
  try {
    const { rows } = await query(
      `UPDATE tickets
          SET sla_breached = TRUE,
              priority     = 'P1',
              escalated_at = now(),
              updated_at   = now()
        WHERE sla_breached = FALSE
          AND sla_due_at IS NOT NULL
          AND sla_due_at <= now()
          AND status NOT IN ('Resolved', 'Closed')
        RETURNING id, from_email, from_name, subject, priority, status, sla_due_at`
    );

    for (const ticket of rows) {
      if (config.slaAlertsEnabled) {
        try {
          await sendSlaAlert(ticket);
          console.log(
            `[SLA] Alert sent for ticket #${ticket.id} to ${config.supervisorEmail}`
          );
        } catch (e) {
          console.error(`[SLA] Alert email failed for ticket #${ticket.id}: ${e.message}`);
        }
      } else {
        console.log(`[SLA] Ticket #${ticket.id} breached (alert email paused)`);
      }
    }
  } catch (err) {
    console.error(`[SLA] monitor error: ${err.message}`);
  }
}

export function startSlaMonitor() {
  console.log(`[SLA] monitor every ${config.slaCheckInterval}s`);
  checkOnce();
  timer = setInterval(checkOnce, config.slaCheckInterval * 1000);
}

export function stopSlaMonitor() {
  if (timer) clearInterval(timer);
}
