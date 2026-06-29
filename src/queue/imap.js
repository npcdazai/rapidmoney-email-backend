// Shared IMAP helpers for queue workers. A worker keeps one persistent
// connection and fetches message sources by UID on demand.
import { ImapFlow } from "imapflow";
import { config } from "../config.js";

export function makeImapClient() {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.gmailEmail, pass: config.gmailAppPassword },
    logger: false,
  });
}

// Fetch the raw RFC822 source + read-state of a single message by UID.
// Returns { source, seen } so the ingester can mirror Gmail's \Seen flag.
export async function fetchSourceByUid(client, uid) {
  const lock = await client.getMailboxLock("INBOX");
  try {
    const msg = await client.fetchOne(uid, { uid: true, source: true, flags: true }, { uid: true });
    if (!msg?.source) return null;
    return { source: msg.source, seen: !!msg.flags?.has("\\Seen") };
  } finally {
    lock.release();
  }
}
