import { ImapFlow } from "imapflow";
import { config } from "../config.js";
import { query } from "../db.js";
import { slaHoursFor } from "../config.js";
import { classify } from "./classifier.js";
import { analyzeEmail } from "./aiClassifier.js";
import { maybeAutoReply } from "./autoReply.js";
import { publish, QUEUES } from "../queue/mq.js";

let timer = null;
let running = false;

/**
 * Read/write the UID high-water mark in app_settings. We track the highest
 * INBOX UID we've ingested rather than relying on the \Seen flag — otherwise
 * any message read directly in Gmail would be skipped forever.
 */
async function getLastUid() {
  const { rows } = await query(
    "SELECT value FROM app_settings WHERE key = 'last_imap_uid'"
  );
  return rows.length ? parseInt(rows[0].value, 10) || 0 : 0;
}
async function setLastUid(uid) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ('last_imap_uid', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [String(uid)]
  );
}

/**
 * Poll the support INBOX for messages newer than the last UID we've seen and
 * publish their UIDs to the mail.new queue (the worker fetches + ingests them).
 * Tracks a UID high-water mark rather than the \Seen flag, so mail read in
 * Gmail is never skipped. The high-water mark only advances after a successful
 * enqueue, so a RabbitMQ outage just retries next cycle.
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
      const lastUid = await getLastUid();

      // First run: set the high-water mark at the current newest message so we
      // don't re-ingest the whole mailbox (history is handled by mail.old).
      if (lastUid === 0) {
        const all = await client.search({ all: true }, { uid: true });
        const maxUid = all && all.length ? Math.max(...all) : 0;
        await setLastUid(maxUid);
        console.log(`[EMAIL] initialized high-water UID = ${maxUid}`);
        return;
      }

      // Messages strictly newer than lastUid. The "N:*" form can return the
      // highest message even when none qualify, so filter defensively.
      const found = await client.search(
        { uid: `${lastUid + 1}:*` },
        { uid: true }
      );
      const fresh = (found || []).filter((u) => u > lastUid).sort((a, b) => a - b);
      if (fresh.length === 0) return;

      // Enqueue first; only advance the high-water mark once all are published.
      for (const uid of fresh) {
        await publish(QUEUES.NEW, { uid });
      }
      const maxUid = fresh[fresh.length - 1];
      await setLastUid(maxUid);
      console.log(`[EMAIL] queued ${fresh.length} new message(s) -> ${QUEUES.NEW} (uid ${lastUid + 1}..${maxUid})`);
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

export async function insertTicket(parsed, opts = {}) {
  const { uid = null, allowAutoReply = true } = opts;
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
        received_at, category, sub_category, sentiment_score, priority, status, sla_due_at, source_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Open',
             $7::timestamptz + ($12 || ' hours')::interval, $13)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING id`,
    [messageId, threadId, fromEmail, fromName, subject, body, receivedAt,
     code, subCategory, sentiment, priority, hours, uid]
  );

  // No row back => duplicate (ON CONFLICT). Only acknowledge genuinely new
  // tickets, so a customer is auto-replied to exactly once.
  if (rows.length === 0) return null;

  // Historical backlog (mail.old) never auto-replies — only live mail does.
  if (allowAutoReply) {
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

  return rows[0].id;
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
