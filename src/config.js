import dotenv from "dotenv";

dotenv.config();

const int = (v, d) => (v === undefined || v === "" ? d : parseInt(v, 10));

export const config = {
  // Server
  port: int(process.env.PORT, 8000),

  // Database
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://rpm_user:rpm_secure_2026@localhost:5432/rpm_crm",

  // Gmail
  gmailEmail: process.env.GMAIL_EMAIL || "support@rapidmoney.in",
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || "",
  imapHost: process.env.IMAP_HOST || "imap.gmail.com",
  imapPort: int(process.env.IMAP_PORT, 993),
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: int(process.env.SMTP_PORT, 465),

  // Polling
  emailPollInterval: int(process.env.EMAIL_POLL_INTERVAL, 60), // seconds
  emailPollEnabled: (process.env.EMAIL_POLL_ENABLED || "true") === "true",

  // Auto-reply domain allowlist — only auto-reply to senders on these domains.
  // Defaults to gmail.com only (never private/corporate domains). Comma-separated.
  autoReplyDomains: (process.env.AUTO_REPLY_DOMAINS || "gmail.com")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),

  // Send the optional internal QRC routing alert to the owning team
  // (ops@/sales@/collections@/grievance@). OFF by default — those are real
  // internal addresses; enable once they exist. Customer replies are unaffected.
  internalAlertsEnabled: (process.env.INTERNAL_ALERTS_ENABLED || "false") === "true",

  // Auto-reply: send an acknowledgement to low-priority (P3) tickets on ingest.
  // OFF by default — this emails real customers, and the first poll processes
  // the entire UNSEEN backlog. Spam is always skipped (see autoReply.js).
  autoReplyEnabled: (process.env.AUTO_REPLY_ENABLED || "false") === "true",

  // SLA
  supervisorEmail:
    process.env.SUPERVISOR_EMAIL || "amit.agashe@rapidmoney.in",
  portalUrl: process.env.PORTAL_URL || "http://192.168.0.159:3000",
  slaP1Hours: int(process.env.SLA_P1_HOURS, 4),
  slaP2Hours: int(process.env.SLA_P2_HOURS, 24),
  slaP3Hours: int(process.env.SLA_P3_HOURS, 48),
  slaCheckInterval: int(process.env.SLA_CHECK_INTERVAL, 300), // seconds
  slaAlertsEnabled: (process.env.SLA_ALERTS_ENABLED || "false") === "true",

  // AI (Phase 2) — when ANTHROPIC_API_KEY is set, Claude classifies incoming
  // email (category + intent + sentiment). Falls back to keyword rules if unset.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  aiModel: process.env.AI_MODEL || "claude-opus-4-8",
};

export function slaHoursFor(priority) {
  switch (priority) {
    case "P1":
      return config.slaP1Hours;
    case "P2":
      return config.slaP2Hours;
    default:
      return config.slaP3Hours;
  }
}
