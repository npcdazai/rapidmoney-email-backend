// Mail ingestion worker — a separate process (PM2: rapidmoney-mail-worker)
// that drains both queues into tickets:
//   • mail.new — live mail, fast lane, auto-reply allowed (per settings)
//   • mail.old — historical backlog, slow lane, never auto-replies
// Each consumer keeps its own IMAP connection so the backlog drain can't
// starve live mail. On startup it also (re)fills mail.old from the inbox.
import { simpleParser } from "mailparser";
import { createConsumerChannel, QUEUES, closeMq } from "./queue/mq.js";
import { makeImapClient, fetchSourceByUid } from "./queue/imap.js";
import { insertTicket } from "./services/emailPoller.js";
import { loadSettings } from "./settings.js";
import { queueBacklog } from "./queue/backlog.js";
import { pool } from "./db.js";

async function startConsumer(label, queue, { prefetch, allowAutoReply }) {
  const channel = await createConsumerChannel(prefetch);
  const client = makeImapClient();
  await client.connect();

  await channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const { uid } = JSON.parse(msg.content.toString());
      const source = await fetchSourceByUid(client, uid);
      if (source) {
        const parsed = await simpleParser(source);
        await insertTicket(parsed, { uid, allowAutoReply });
      }
      channel.ack(msg);
    } catch (err) {
      // Drop on failure rather than poison-looping; Message-ID dedup makes a
      // later re-queue safe if we ever want to retry.
      console.error(`[worker:${label}] ${err.message}`);
      channel.nack(msg, false, false);
    }
  });

  console.log(`[worker] consuming ${queue} (prefetch ${prefetch}, auto-reply ${allowAutoReply ? "on" : "off"})`);
  return { channel, client };
}

async function main() {
  await loadSettings(); // so the live consumer honors the auto-reply toggle

  await startConsumer("new", QUEUES.NEW, { prefetch: 5, allowAutoReply: true });
  await startConsumer("old", QUEUES.OLD, { prefetch: 3, allowAutoReply: false });

  // Fill the backlog queue in the background (resumable, skips already-ingested).
  queueBacklog().catch((e) => console.error(`[BACKLOG] ${e.message}`));

  console.log("[worker] mail worker up");

  const shutdown = async () => {
    console.log("\n[worker] shutting down...");
    try { await closeMq(); } catch { /* ignore */ }
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[worker FATAL]", e);
  process.exit(1);
});
