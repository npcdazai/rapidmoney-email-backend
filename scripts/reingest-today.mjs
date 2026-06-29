// Targeted recovery: re-ingest INBOX messages received on/after a given date.
// Uses its own IMAP connection (independent of the worker) and dedupes on
// Message-ID via insertTicket(... ON CONFLICT DO NOTHING). No auto-replies.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../src/config.js";
import { insertTicket } from "../src/services/emailPoller.js";
import { pool } from "../src/db.js";

const SINCE = new Date(process.argv[2] || "2026-06-29T00:00:00Z");

const client = new ImapFlow({
  host: config.imapHost,
  port: config.imapPort,
  secure: true,
  auth: { user: config.gmailEmail, pass: config.gmailAppPassword },
  logger: false,
});

let inserted = 0, skipped = 0, scanned = 0;
await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  const uids = await client.search({ since: SINCE }, { uid: true });
  console.log(`[REINGEST] ${uids.length} message(s) since ${SINCE.toISOString()}`);
  for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
    scanned++;
    try {
      const parsed = await simpleParser(msg.source);
      const id = await insertTicket(parsed);
      if (id) inserted++; else skipped++;
    } catch (e) {
      skipped++;
      console.error(`[REINGEST] skip uid ${msg.uid}: ${e.message}`);
    }
  }
} finally {
  lock.release();
}
console.log(`[REINGEST] DONE — scanned ${scanned}, inserted ${inserted}, duplicates/skipped ${skipped}`);
await client.logout();
await pool.end();
