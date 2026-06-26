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

// Fetch the raw RFC822 source of a single message by UID.
export async function fetchSourceByUid(client, uid) {
  const lock = await client.getMailboxLock("INBOX");
  try {
    const msg = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
    return msg?.source || null;
  } finally {
    lock.release();
  }
}
