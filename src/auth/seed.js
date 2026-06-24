import { query } from "../db.js";
import { config } from "../config.js";
import { hashPassword } from "./password.js";
import { MODULE_KEYS } from "./modules.js";

// Canonical permission catalogue. The slugs here are the ones referenced by
// checkPermission(...) across the auth routes.
export const PERMISSIONS = [
  ["users.create", "Create users"],
  ["users.view", "View users"],
  ["users.update", "Update users"],
  ["users.delete", "Delete users"],
  ["roles.create", "Create roles"],
  ["roles.view", "View roles"],
  ["roles.update", "Update roles"],
  ["roles.delete", "Delete roles"],
  ["permissions.view", "View permissions"],
  ["permissions.manage", "Manage permissions"],
];

/**
 * Idempotent auth seed, run on every migration:
 *   • upsert the permission catalogue,
 *   • ensure an "Admin" role that holds every permission,
 *   • create a bootstrap admin user the first time the table is empty.
 */
export async function seedAuth() {
  // 1. Permissions
  for (const [slug, name] of PERMISSIONS) {
    await query(
      `INSERT INTO permissions (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING`,
      [slug, name]
    );
  }

  // 2. Admin role with all permissions
  const { rows: roleRows } = await query(
    `INSERT INTO roles (name, description) VALUES ('Admin', 'Full system access')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    []
  );
  const adminRoleId = roleRows[0].id;
  await query(
    `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, p.id FROM permissions p
       ON CONFLICT DO NOTHING`,
    [adminRoleId]
  );

  // 3. Bootstrap admin — only when there are no users yet
  const { rows: countRows } = await query(`SELECT COUNT(*)::int AS n FROM users`);
  if (countRows[0].n === 0) {
    const hash = await hashPassword(config.bootstrapAdminPassword);
    const { rows: u } = await query(
      `INSERT INTO users (email, name, password, password_set, status)
         VALUES ($1, $2, $3, TRUE, 'Active')
       RETURNING id`,
      [config.bootstrapAdminEmail, config.bootstrapAdminName, hash]
    );
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [u[0].id, adminRoleId]
    );
    // Bootstrap admin gets every module allocated.
    for (const key of MODULE_KEYS) {
      await query(
        `INSERT INTO user_modules (user_id, module_key) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
        [u[0].id, key]
      );
    }
    console.log(
      `[SEED] bootstrap admin created: ${config.bootstrapAdminEmail} ` +
        `(password from BOOTSTRAP_ADMIN_PASSWORD — change it after first login)`
    );
  }

  // 4. Ensure the bootstrap admin always holds every module + the Admin role
  //    (covers admins created before modules existed).
  const { rows: adminUser } = await query(
    `SELECT id FROM users WHERE lower(email) = lower($1)`,
    [config.bootstrapAdminEmail]
  );
  if (adminUser.length) {
    const aid = adminUser[0].id;
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [aid, adminRoleId]
    );
    for (const key of MODULE_KEYS) {
      await query(
        `INSERT INTO user_modules (user_id, module_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [aid, key]
      );
    }
  }

  // 5. Drop any allocations whose key is no longer in the catalogue (e.g. the
  //    old coarse "mail" key now split into mail.* sections).
  await query(`DELETE FROM user_modules WHERE module_key <> ALL($1)`, [MODULE_KEYS]);
}
