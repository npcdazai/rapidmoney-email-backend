import { query } from "../db.js";

// Columns we ever expose for a user — never select the password hash here.
const USER_COLS = `id, email, name, status, password_set, created_at, updated_at`;

/**
 * Load a user plus their roles and the flat set of permission slugs granted by
 * those roles. Returns null if no user matches. `password` is included only
 * when `withPassword` is true (login path).
 */
export async function loadUser(where, params, { withPassword = false } = {}) {
  const cols = withPassword ? `${USER_COLS}, password` : USER_COLS;
  const { rows } = await query(
    `SELECT ${cols} FROM users WHERE ${where} LIMIT 1`,
    params
  );
  if (rows.length === 0) return null;
  const user = rows[0];

  const { rows: roles } = await query(
    `SELECT r.id, r.name
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY r.name`,
    [user.id]
  );
  const { rows: perms } = await query(
    `SELECT DISTINCT p.slug
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1`,
    [user.id]
  );
  const { rows: mods } = await query(
    `SELECT module_key FROM user_modules WHERE user_id = $1`,
    [user.id]
  );

  user.roles = roles;
  user.permissions = perms.map((p) => p.slug);
  user.modules = mods.map((m) => m.module_key);
  return user;
}

/** Strip internal-only fields before returning a user over the API. */
export function publicUser(user) {
  if (!user) return user;
  const { password, ...safe } = user;
  return safe;
}
