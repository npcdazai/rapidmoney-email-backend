import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../config.js";
import { query } from "../db.js";
import { slaHoursFor } from "../config.js";

let timer = null;
let running = false;

/**
 * Poll the support mailbox for UNSEEN messages and insert them as tickets.
 * Deduplicated on the Message-ID header, so re-running on the same email
 * is safe.
 */
async function pollOnce() {
  if (running) return; // never overlap a slow poll
  running = true;

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.gmailEmail, pass: config.gmailAppPassword },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const unseen = await client.search({ seen: false });
      if (!unseen || unseen.length === 0) return;

      for (const seq of unseen) {
        const msg = await client.fetchOne(seq, { source: true });
        if (!msg?.source) continue;
        const parsed = await simpleParser(msg.source);
        await insertTicket(parsed);
        // Mark seen so we don't re-ingest it next cycle.
        await client.messageFlagsAdd(seq, ["\\Seen"]);
      }
      console.log(`[EMAIL] processed ${unseen.length} new message(s)`);
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`[EMAIL] poll error: ${err.message}`);
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    running = false;
  }
}

async function insertTicket(parsed) {
  const messageId = parsed.messageId || null;
  const threadId =
    parsed.inReplyTo ||
    (parsed.references && [].concat(parsed.references)[0]) ||
    messageId;
  const fromAddr = parsed.from?.value?.[0] || {};
  const fromEmail = fromAddr.address || "unknown@unknown";
  const fromName = fromAddr.name || fromEmail;
  const subject = parsed.subject || "(no subject)";
  const body = parsed.text || parsed.html || "";
  const receivedAt = parsed.date || new Date();
  const hours = slaHoursFor("P3"); // new tickets default to P3

  await query(
    `INSERT INTO tickets
       (message_id, thread_id, from_email, from_name, subject, body,
        received_at, priority, status, sla_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'P3','Open',
             $7::timestamptz + ($8 || ' hours')::interval)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, threadId, fromEmail, fromName, subject, body, receivedAt, hours]
  );
}

export function startEmailPoller() {
  if (!config.emailPollEnabled) {
    console.log("[EMAIL] poller disabled (EMAIL_POLL_ENABLED=false)");
    return;
  }
  if (!config.gmailAppPassword) {
    console.log("[EMAIL] poller idle — GMAIL_APP_PASSWORD not set");
    return;
  }
  console.log(`[EMAIL] poller every ${config.emailPollInterval}s`);
  pollOnce();
  timer = setInterval(pollOnce, config.emailPollInterval * 1000);
}

export function stopEmailPoller() {
  if (timer) clearInterval(timer);
}
