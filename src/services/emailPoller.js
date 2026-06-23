import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../config.js";
import { query } from "../db.js";
import { slaHoursFor } from "../config.js";
import { classify } from "./classifier.js";
import { analyzeEmail } from "./aiClassifier.js";
import { maybeAutoReply } from "./autoReply.js";

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
  // Detect machine-sent mail (lists, bounces, auto-responders) to avoid loops.
  const hdr = (h) => {
    try {
      return (parsed.headers?.get(h) || "").toString().toLowerCase();
    } catch {
      return "";
    }
  };
  const isAutomated =
    !!hdr("auto-submitted").replace("no", "") ||
    /bulk|list|auto_reply|junk/.test(hdr("precedence")) ||
    !!hdr("list-unsubscribe");
  // Categorize on ingest: Claude if a key is configured, else keyword rules.
  const ai = await analyzeEmail(subject, body);
  let code, priority, subCategory = null, sentiment = null;
  if (ai) {
    code = ai.category;
    priority = ai.priority;
    subCategory = ai.intent; // intent key, reused by the auto-reply
    sentiment = ai.sentiment;
  } else {
    ({ code, priority } = classify(subject, body));
  }
  const hours = slaHoursFor(priority);

  const { rows } = await query(
    `INSERT INTO tickets
       (message_id, thread_id, from_email, from_name, subject, body,
        received_at, category, sub_category, sentiment_score, priority, status, sla_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Open',
             $7::timestamptz + ($12 || ' hours')::interval)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING id`,
    [messageId, threadId, fromEmail, fromName, subject, body, receivedAt,
     code, subCategory, sentiment, priority, hours]
  );

  // No row back => duplicate (ON CONFLICT). Only acknowledge genuinely new
  // tickets, so a customer is auto-replied to exactly once.
  if (rows.length === 0) return;

  await maybeAutoReply(
    {
      id: rows[0].id,
      from_email: fromEmail,
      from_name: fromName,
      subject,
      body,
      message_id: messageId,
      thread_id: threadId,
      category: code,
      sub_category: subCategory,
      priority,
    },
    { isAutomated }
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
