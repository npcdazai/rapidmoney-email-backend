import nodemailer from "nodemailer";
import { config } from "../config.js";

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465, // SSL on 465
      auth: {
        user: config.gmailEmail,
        pass: config.gmailAppPassword,
      },
    });
  }
  return transporter;
}

/**
 * THE single outbound choke point. Every email in this service goes through
 * deliver(), so the UAT sink cannot be bypassed by any current or future
 * caller. When UAT_REDIRECT_EMAIL is set:
 *   • every recipient (to/cc/bcc) is replaced by the sink address — no
 *     customer or internal team is ever emailed;
 *   • the intended recipient is preserved in the subject tag + a body banner.
 */
// Pure recipient guard — rewrites the mail object for the UAT sink. Exported so
// it can be verified in isolation. Returns a NEW object; never mutates input.
export function prepareForDelivery(mail) {
  const sink = config.uatRedirectEmail;
  if (!sink) return mail;
  const intended = mail.to;
  const note = `[UAT REDIRECT] Generated for ${intended}; redirected here in the UAT environment. The real recipient was NOT emailed.`;
  return {
    ...mail,
    to: sink,
    cc: undefined, // strip any stray copy recipients
    bcc: undefined,
    subject: `[UAT→${intended}] ${mail.subject || ""}`,
    text: mail.text != null ? `${note}\n\n----------\n\n${mail.text}` : mail.text,
    html: mail.html
      ? `<p style="color:#b45309"><b>[UAT REDIRECT]</b> Generated for ${intended}; the real recipient was NOT emailed.</p><hr>${mail.html}`
      : mail.html,
  };
}

async function deliver(mail) {
  const info = await getTransporter().sendMail(prepareForDelivery(mail));
  return { messageId: info.messageId };
}

/** True when running as a UAT sink (no mail reaches real recipients). */
export const isUatRedirect = () => !!config.uatRedirectEmail;

/**
 * Send a plain email (no threading) — used for internal QRC routing alerts.
 */
export async function sendMail({ to, subject, body }) {
  return deliver({
    from: `RapidMoney Support <${config.gmailEmail}>`,
    to,
    subject,
    text: body,
  });
}

/**
 * Send a reply to a customer. Uses In-Reply-To/References so the reply lands
 * in the same Gmail thread as the original message.
 */
export async function sendReply({
  to,
  cc,
  subject,
  body,
  html,
  attachments,
  messageId,
  threadId,
  prefixRe = true, // false → use the given subject verbatim (fixed-subject templates)
}) {
  const replySubject = !prefixRe || subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const headers = {};
  const ref = messageId || threadId;
  if (ref) {
    headers["In-Reply-To"] = ref;
    headers["References"] = ref;
  }

  const mail = {
    from: `RapidMoney Support <${config.gmailEmail}>`,
    to,
    subject: replySubject,
    text: body || "",
    headers,
  };
  if (cc && cc.trim()) mail.cc = cc; // dropped by deliver() in UAT mode
  if (html && html.trim()) mail.html = html;
  if (Array.isArray(attachments) && attachments.length) {
    mail.attachments = attachments.map((a) => ({
      filename: a.filename || "attachment",
      content: a.content, // base64 string
      encoding: "base64",
      contentType: a.contentType || undefined,
    }));
  }

  const info = await deliver(mail);
  return { subject: replySubject, messageId: info.messageId };
}

/**
 * Supervisor SLA breach alert. Only fires when SLA_ALERTS_ENABLED=true
 * (paused by default). Also routed through the UAT sink.
 */
export async function sendSlaAlert(ticket) {
  const subject = `[SLA BREACH] Ticket #${ticket.id} — ${ticket.subject || "(no subject)"}`;
  const body = [
    `SLA breached for ticket #${ticket.id}.`,
    ``,
    `From:     ${ticket.from_name || ""} <${ticket.from_email || ""}>`,
    `Priority: ${ticket.priority}`,
    `Due at:   ${ticket.sla_due_at}`,
    `Status:   ${ticket.status}`,
    ``,
    `Open in portal: ${config.portalUrl}`,
  ].join("\n");

  return deliver({
    from: `RapidMoney CRM <${config.gmailEmail}>`,
    to: config.supervisorEmail,
    subject,
    text: body,
  });
}
