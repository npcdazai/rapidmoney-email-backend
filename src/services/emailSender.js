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
 * Send a plain email (no threading) — used for internal QRC routing alerts.
 */
export async function sendMail({ to, subject, body }) {
  const info = await getTransporter().sendMail({
    from: `RapidMoney Support <${config.gmailEmail}>`,
    to,
    subject,
    text: body,
  });
  return { messageId: info.messageId };
}

/**
 * Send a reply to a customer. Uses In-Reply-To/References so the reply lands
 * in the same Gmail thread as the original message.
 */
export async function sendReply({
  to,
  subject,
  body,
  html,
  attachments,
  messageId,
  threadId,
}) {
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
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
  if (html && html.trim()) mail.html = html;
  if (Array.isArray(attachments) && attachments.length) {
    mail.attachments = attachments.map((a) => ({
      filename: a.filename || "attachment",
      content: a.content, // base64 string
      encoding: "base64",
      contentType: a.contentType || undefined,
    }));
  }

  const info = await getTransporter().sendMail(mail);
  return { subject: replySubject, messageId: info.messageId };
}

/**
 * Supervisor SLA breach alert. Implemented but only fires when
 * SLA_ALERTS_ENABLED=true (paused by default, mirroring the original).
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

  await getTransporter().sendMail({
    from: `RapidMoney CRM <${config.gmailEmail}>`,
    to: config.supervisorEmail,
    subject,
    text: body,
  });
}
