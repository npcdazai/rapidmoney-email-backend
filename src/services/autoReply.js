// QRC auto-reply engine — implements the "RapidMoney — QRC email auto-reply
// reference" spec. Classifies each email into Query / Request / Complaint
// (Claude Haiku if a key is set, else keyword rules), then sends the matching
// template and routes an optional internal alert to the owning team.
//
// Safety stack (all still apply): enabled toggle, gmail-only domain allowlist,
// no-reply/loop protection, idempotency, spam skip.
//
// Spec rules enforced:
//   1. confidence < 0.75 → generic acknowledgement + route (never auto-answer)
//   2. account-specific query → acknowledge + route (never reveal data)
//   3. safe + confident query → auto-answer from the knowledge base only
//   4. requests & complaints → always acknowledge + route, never auto-resolve

import { config } from "../config.js";
import { query } from "../db.js";
import { sendReply, sendMail } from "./emailSender.js";
import { isAutoReplyEnabled } from "../settings.js";
import { analyzeQRC } from "./aiClassifier.js";
import {
  SUBCATS,
  classifyQRC,
  makeReference,
  internalAlert,
  TEMPLATES,
  pickTemplate,
} from "./qrc.js";

// Senders we must never auto-reply to (mail-loop / bounce protection).
const NO_REPLY =
  /(no.?reply|do.?not.?reply|mailer-daemon|postmaster|notification|automated|bounce)/i;

const firstName = (name = "", email = "") => {
  const n = (name || "").trim();
  if (n && n !== email) return n.split(/\s+/)[0];
  return "Customer";
};

const CONFIDENCE_FLOOR = 0.75;

/**
 * Decide on and send a QRC auto-reply for a ticket. Returns true if sent.
 *
 * @param {object} ticket  { id, from_email, from_name, subject, body,
 *                           message_id, thread_id, category, received_at }
 * @param {object} opts  { isAutomated, force }
 */
export async function maybeAutoReply(ticket, opts = {}) {
  const { isAutomated = false, force = false } = opts;
  if (!force) {
    if (!isAutoReplyEnabled()) return false;
    if (isAutomated) return false;
    if (ticket.category === "spam") return false;
    const seen = await query(`SELECT auto_replied FROM tickets WHERE id = $1`, [ticket.id]);
    if (seen.rows[0]?.auto_replied) return false;
    // Freshness: don't auto-reply to stale backlog (mail older than the window).
    const recvMs = ticket.received_at ? new Date(ticket.received_at).getTime() : Date.now();
    const ageHours = (Date.now() - recvMs) / 3_600_000;
    if (ageHours > config.autoReplyMaxAgeHours) {
      console.log(
        `[AUTO-REPLY] skipped #${ticket.id} — email is ${ageHours.toFixed(1)}h old (> ${config.autoReplyMaxAgeHours}h window)`
      );
      return false;
    }
  }
  // Loop protection + gmail-only allowlist always apply, even for manual sends.
  if (NO_REPLY.test(ticket.from_email || "")) {
    console.log(`[AUTO-REPLY] skipped #${ticket.id} — no-reply/automated sender`);
    return false;
  }
  // Gmail-only allowlist (skipped in UAT — mail goes to the sink, not customers).
  const domain = (ticket.from_email || "").split("@").pop()?.toLowerCase() || "";
  if (!config.uatRedirectEmail && !config.autoReplyDomains.includes(domain)) {
    console.log(`[AUTO-REPLY] skipped #${ticket.id} — domain "${domain}" not in allowlist`);
    return false;
  }

  // Classify: Claude (Haiku) if available, else keyword rules.
  const qrc = (await analyzeQRC(ticket.subject, ticket.body)) || classifyQRC(ticket.subject, ticket.body);
  const sub = SUBCATS[qrc.subKey] || SUBCATS.general_info;
  const group = sub.group;
  const confident = (qrc.confidence ?? 0.9) >= CONFIDENCE_FLOOR;
  const ref = makeReference(ticket.received_at, ticket.id);

  // Pick the fixed customer template (low confidence → universal catch-all).
  const templateKey = pickTemplate(group, confident);
  const template = TEMPLATES[templateKey];
  const body = template.body;
  const mode = `${templateKey}_ack`;

  try {
    const sent = await sendReply({
      to: ticket.from_email,
      subject: template.subject, // fixed subject from the template
      prefixRe: false,
      body,
      messageId: ticket.message_id,
      threadId: ticket.thread_id,
    });

    await query(
      `INSERT INTO ticket_replies
         (ticket_id, direction, from_email, to_email, subject, body, sent_by)
       VALUES ($1,'outbound',$2,$3,$4,$5,$6)`,
      [ticket.id, config.gmailEmail, ticket.from_email, sent.subject, body, "Auto-Reply"]
    );
    await query(
      `UPDATE tickets
          SET auto_replied = TRUE, reference = $2, auto_replied_at = now(),
              auto_reply_mode = $3, auto_reply_group = $4, auto_reply_subcat = $5,
              auto_reply_routed_to = $6, auto_reply_confidence = $7, updated_at = now()
        WHERE id = $1`,
      [ticket.id, ref, mode, group, qrc.subKey, sub.routedTo, qrc.confidence ?? 0.9]
    );
    await query(
      `INSERT INTO ticket_notes (ticket_id, note, is_internal, created_by) VALUES ($1,$2,TRUE,$3)`,
      [
        ticket.id,
        `QRC auto-reply: ${group}/${qrc.subKey} → ${mode} (ref ${ref}, conf ${(qrc.confidence ?? 0.9).toFixed(2)}). Routed to ${sub.routedTo}.`,
        "System",
      ]
    );

    console.log(`[AUTO-REPLY] #${ticket.id} ${group}/${qrc.subKey} → ${mode} (${ref})`);

    // Optional internal routing alert to the owning team.
    if (config.internalAlertsEnabled) {
      try {
        const alert = internalAlert({
          group,
          subKey: qrc.subKey,
          ref,
          subject: ticket.subject,
          from: ticket.from_email,
          urgency: qrc.urgency || (group === "complaint" ? "high" : "normal"),
          sentiment: qrc.sentiment || (group === "complaint" ? "negative" : "neutral"),
          confidence: qrc.confidence ?? 0.9,
          summary: qrc.summary,
        });
        await sendMail({ to: sub.routedTo, subject: alert.subject, body: alert.body });
      } catch (e) {
        console.error(`[AUTO-REPLY] internal alert failed for #${ticket.id}: ${e.message}`);
      }
    }

    return true;
  } catch (err) {
    console.error(`[AUTO-REPLY] #${ticket.id} failed: ${err.message}`);
    return false;
  }
}
