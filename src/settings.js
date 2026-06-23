// Runtime, UI-editable settings. Hydrated from the app_settings table on boot,
// updated via the API, and persisted back so the toggle survives restarts.
// Falls back to the .env default (config.autoReplyEnabled) until overridden.

import { config } from "./config.js";
import { query } from "./db.js";

const state = {
  autoReplyEnabled: config.autoReplyEnabled,
};

export function getSettings() {
  return { ...state };
}

export function isAutoReplyEnabled() {
  return state.autoReplyEnabled;
}

export async function loadSettings() {
  try {
    const { rows } = await query("SELECT key, value FROM app_settings");
    for (const r of rows) {
      if (r.key === "auto_reply_enabled") state.autoReplyEnabled = r.value === "true";
    }
    console.log(`[SETTINGS] auto-reply ${state.autoReplyEnabled ? "ON" : "OFF"}`);
  } catch {
    /* table not migrated yet — keep .env default */
  }
}

export async function setAutoReplyEnabled(enabled) {
  state.autoReplyEnabled = !!enabled;
  await query(
    `INSERT INTO app_settings (key, value) VALUES ('auto_reply_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [String(!!enabled)]
  );
  console.log(`[SETTINGS] auto-reply set ${state.autoReplyEnabled ? "ON" : "OFF"}`);
  return getSettings();
}
