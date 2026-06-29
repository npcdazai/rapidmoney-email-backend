// One-time sync: align tickets.is_read with Gmail's \Seen flag.
// Fetches ONLY flags + envelope (Message-ID) for every INBOX message — no
// bodies — so it's fast even for tens of thousands of messages. Matches tickets
// by Message-ID (brackets normalized on both sides) and flips is_read to match.
import { ImapFlow } from "imapflow";
import { config } from "../src/config.js";
import { query, pool } from "../src/db.js";

const norm = (m) => (m || "").replace(/[<>]/g, "").trim();
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const client = new ImapFlow({
  host: config.imapHost,
  port: config.imapPort,
  secure: true,
  auth: { user: config.gmailEmail, pass: config.gmailAppPassword },
  logger: false,
});

const seen = [];
const unseen = [];

await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  const status = await client.status("INBOX", { messages: true });
  console.log(`[SYNC] INBOX has ${status.messages} messages — reading flags`);
  for await (const msg of client.fetch("1:*", { uid: true, flags: true, envelope: true })) {
    const mid = norm(msg.envelope?.messageId);
    if (!mid) continue;
    (msg.flags?.has("\\Seen") ? seen : unseen).push(mid);
  }
} finally {
  lock.release();
}
await client.logout();
console.log(`[SYNC] Gmail: ${seen.length} read, ${unseen.length} unread`);

let readUpdated = 0, unreadUpdated = 0;
for (const ids of chunk(seen, 5000)) {
  const { rowCount } = await query(
    `UPDATE tickets SET is_read = TRUE WHERE trim(both '<>' from message_id) = ANY($1) AND is_read = FALSE`,
    [ids]
  );
  readUpdated += rowCount;
}
for (const ids of chunk(unseen, 5000)) {
  const { rowCount } = await query(
    `UPDATE tickets SET is_read = FALSE WHERE trim(both '<>' from message_id) = ANY($1) AND is_read = TRUE`,
    [ids]
  );
  unreadUpdated += rowCount;
}
console.log(`[SYNC] DONE — marked ${readUpdated} read, ${unreadUpdated} unread`);
await pool.end();
