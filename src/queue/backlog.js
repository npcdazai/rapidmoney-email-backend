// Old-mail producer. Streams INBOX envelopes (lightweight — no body/attachment
// download), skips messages already ingested (matched by Message-ID, recording
// their source_uid), and enqueues only the rest onto mail.old. Resumable via a
// UID cursor in app_settings, so a restart continues instead of rescanning.
import { getChannel, QUEUES } from "./mq.js";
import { makeImapClient } from "./imap.js";
import { query } from "../db.js";

const norm = (s) => (s || "").replace(/[<>]/g, "").trim();

async function getCursor() {
  const { rows } = await query(
    "SELECT value FROM app_settings WHERE key='mail_old_cursor'"
  );
  return rows.length ? parseInt(rows[0].value, 10) || 0 : 0;
}
async function setCursor(uid) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ('mail_old_cursor', $1)
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`,
    [String(uid)]
  );
}

let running = false;

export async function queueBacklog() {
  if (running) return 0;
  running = true;

  // Map of already-ingested Message-IDs -> ticket id, so we can both skip and
  // backfill source_uid for mail the old script already imported.
  const { rows } = await query(
    "SELECT id, message_id FROM tickets WHERE message_id IS NOT NULL"
  );
  const byMsgId = new Map(rows.map((r) => [norm(r.message_id), r.id]));

  const client = makeImapClient();
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  let queued = 0;
  let skipped = 0;
  let scanned = 0;
  try {
    const cursor = await getCursor();
    const ch = await getChannel();
    // Stream envelopes for every UID above the cursor.
    for await (const msg of client.fetch(
      { uid: `${cursor + 1}:*` },
      { uid: true, envelope: true },
      { uid: true }
    )) {
      const uid = msg.uid;
      if (uid <= cursor) continue;
      scanned++;
      const mid = norm(msg.envelope?.messageId);
      const existingId = mid && byMsgId.get(mid);
      if (existingId) {
        // Already ingested — record its UID and skip re-queuing.
        await query(
          "UPDATE tickets SET source_uid=$1 WHERE id=$2 AND source_uid IS NULL",
          [uid, existingId]
        );
        skipped++;
      } else {
        ch.sendToQueue(QUEUES.OLD, Buffer.from(JSON.stringify({ uid })), {
          persistent: true,
        });
        queued++;
      }
      await setCursor(uid);
      if (scanned % 500 === 0) {
        console.log(`[BACKLOG] scanned ${scanned}, queued ${queued}, skipped ${skipped}`);
      }
    }
  } finally {
    lock.release();
    try { await client.logout(); } catch { /* ignore */ }
    running = false;
  }
  console.log(`[BACKLOG] done — scanned ${scanned}, queued ${queued} to ${QUEUES.OLD}, skipped ${skipped} already-ingested`);
  return queued;
}
