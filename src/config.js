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

  // SLA
  supervisorEmail:
    process.env.SUPERVISOR_EMAIL || "amit.agashe@rapidmoney.in",
  portalUrl: process.env.PORTAL_URL || "http://192.168.0.159:3000",
  slaP1Hours: int(process.env.SLA_P1_HOURS, 4),
  slaP2Hours: int(process.env.SLA_P2_HOURS, 24),
  slaP3Hours: int(process.env.SLA_P3_HOURS, 48),
  slaCheckInterval: int(process.env.SLA_CHECK_INTERVAL, 300), // seconds
  slaAlertsEnabled: (process.env.SLA_ALERTS_ENABLED || "false") === "true",

  // AI (Phase 2 — not yet active)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
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
