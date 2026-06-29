// One-time backfill: ingest EVERY message in the support INBOX as a ticket,
// not just unread ones. Safe to re-run — insertTicket dedupes on Message-ID
// (ON CONFLICT DO NOTHING). Does NOT mark messages seen, so the steady-state
// poller is unaffected. No auto-replies are sent (AUTO_REPLY_ENABLED gates it).
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "./config.js";
import { insertTicket } from "./services/emailPoller.js";
import { pool } from "./db.js";

const client = new ImapFlow({
  host: config.imapHost,
  port: config.imapPort,
  secure: true,
  auth: { user: config.gmailEmail, pass: config.gmailAppPassword },
  logger: false,
});

let scanned = 0;
let inserted = 0;
let skipped = 0;

await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  const status = await client.status("INBOX", { messages: true });
  console.log(`[BACKFILL] INBOX has ${status.messages} messages — ingesting all`);

  for await (const msg of client.fetch("1:*", { uid: true, source: true, flags: true })) {
    scanned++;
    try {
      const parsed = await simpleParser(msg.source);
      const id = await insertTicket(parsed, { isRead: !!msg.flags?.has("\\Seen") });
      if (id) inserted++;
      else skipped++;
    } catch (e) {
      skipped++;
      console.error(`[BACKFILL] skip msg #${scanned}: ${e.message}`);
    }
    if (scanned % 100 === 0) {
      console.log(`[BACKFILL] scanned ${scanned}, inserted ${inserted}, skipped ${skipped}`);
    }
  }
} finally {
  lock.release();
}

console.log(`[BACKFILL] DONE — scanned ${scanned}, newly inserted ${inserted}, duplicates/skipped ${skipped}`);
await client.logout();
await pool.end();
