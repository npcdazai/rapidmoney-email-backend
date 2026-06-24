// App "components" the admin can allocate to a user. The Mail workspace is
// broken into its dashboard sections so access can be granted section-by-section.
// These gate both the frontend UI and the backend API (see requireModule()).
export const MODULES = [
  { key: "mail.main", label: "Main", group: "Mail", description: "Inbox, Flagged, SLA Breached, All Tickets" },
  { key: "mail.status", label: "By Status", group: "Mail", description: "Open, In Progress, Pending, Resolved, Closed" },
  { key: "mail.qrc", label: "QRC Categories", group: "Mail", description: "Queries, Requests, Complaints and their categories" },
  { key: "mail.automation", label: "Automation", group: "Mail", description: "Auto-replied tickets" },
  { key: "mail.other", label: "Other", group: "Mail", description: "Spam, Uncategorized" },
  { key: "analytics", label: "Analytics", group: "General", description: "Dashboards and reports" },
  { key: "autoreply", label: "Auto-reply", group: "General", description: "Toggle and trigger automated replies" },
  { key: "admin", label: "User Management", group: "General", description: "Manage users and module allocation" },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

// The Mail-workspace sections — used to decide "does this user have any mail
// access at all" for shared endpoints (folders, stats, ticket detail/actions).
export const MAIL_SECTIONS = MODULES.filter((m) => m.group === "Mail").map((m) => m.key);

// New users get the Main section by default so they land on a usable Inbox.
export const DEFAULT_MODULES = ["mail.main"];

/** Keep only valid module keys from an arbitrary input array. */
export function sanitizeModules(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input)].filter((k) => MODULE_KEYS.includes(k));
}

/** True if the user holds at least one Mail section. */
export const hasAnyMail = (mods = []) => MAIL_SECTIONS.some((s) => mods.includes(s));

/**
 * Map a GET /api/tickets list query to the Mail section it belongs to, so the
 * list endpoint can be gated by exactly the folder being requested.
 */
export function requiredMailSection(q = {}) {
  if (q.status) return "mail.status";
  if (q.auto_replied === "true") return "mail.automation";
  if (q.uncategorized === "true" || q.category === "spam") return "mail.other";
  if (q.group || q.category) return "mail.qrc";
  return "mail.main"; // inbox, flagged, breached, all, plain search
}
