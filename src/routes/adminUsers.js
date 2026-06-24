import { Router } from "express";
import { query, withClient } from "../db.js";
import { config } from "../config.js";
import { signToken, TOKEN_TYPE } from "../auth/jwt.js";
import { loadUser, publicUser } from "../auth/repo.js";
import { checkPermission } from "../auth/middleware.js";
import { sendCreatePasswordEmail, sendResetPasswordEmail } from "../services/authEmail.js";
import { MODULES, sanitizeModules, DEFAULT_MODULES } from "../auth/modules.js";

// Mounted at /api/auth/admin (behind authMiddleware).
export const adminUsersRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_STATUS = ["Active", "Inactive"];

// Validate roleIds resolve to existing roles; returns the deduped int list.
async function resolveRoleIds(roleIds) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return [];
  const ids = [...new Set(roleIds.map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return [];
  const { rows } = await query(`SELECT id FROM roles WHERE id = ANY($1)`, [ids]);
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((i) => !found.has(i));
    const err = new Error(`Unknown role id(s): ${missing.join(", ")}`);
    err.status = 422;
    throw err;
  }
  return ids;
}

// POST /api/auth/admin/create-user
adminUsersRouter.post("/create-user", checkPermission("users.create"), async (req, res, next) => {
  try {
    const { email, name = null, roleIds = [], modules } = req.body || {};
    if (!email || !EMAIL_RE.test(email))
      return res.status(422).json({ detail: "A valid email is required" });
    const moduleKeys = modules === undefined ? DEFAULT_MODULES : sanitizeModules(modules);

    const exists = await query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [email]);
    if (exists.rows.length)
      return res.status(409).json({ detail: "A user with this email already exists", code: "USER_ALREADY_EXISTS" });

    let ids;
    try {
      ids = await resolveRoleIds(roleIds);
    } catch (e) {
      return res.status(e.status || 422).json({ detail: e.message });
    }

    // Create the user (no password yet) and assign roles atomically.
    const userId = await withClient(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO users (email, name, password, password_set, status)
           VALUES ($1, $2, NULL, FALSE, 'Active') RETURNING id`,
        [email.toLowerCase(), name]
      );
      const id = rows[0].id;
      for (const roleId of ids) {
        await c.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, roleId]
        );
      }
      for (const key of moduleKeys) {
        await c.query(
          `INSERT INTO user_modules (user_id, module_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, key]
        );
      }
      return id;
    });

    // 1h token for the create-password page. The link is BOTH emailed and
    // returned here, so an admin can hand it over directly when email delivery
    // isn't available/configured.
    const token = signToken({ sub: userId, type: TOKEN_TYPE.SET_PASSWORD }, "1h");
    const setPasswordUrl = `${config.frontendUrl}/auth/create-password?token=${token}`;
    const user = await loadUser("id = $1", [userId]);
    let emailSent = true;
    try {
      await sendCreatePasswordEmail(user, token);
    } catch (e) {
      emailSent = false;
      console.error("[create-user] email send failed:", e.message);
    }
    res.status(201).json({ user: publicUser(user), emailSent, setPasswordToken: token, setPasswordUrl });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/admin/users — paginated + searchable list
adminUsersRouter.get("/users", checkPermission("users.view"), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();

    const where = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(email ILIKE $${params.length} OR name ILIKE $${params.length})`);
    }
    if (req.query.status && VALID_STATUS.includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows: countRows } = await query(`SELECT COUNT(*)::int AS total FROM users ${whereSql}`, params);
    const total = countRows[0].total;

    params.push(limit, offset);
    const { rows } = await query(
      `SELECT id, email, name, status, password_set, created_at, updated_at
         FROM users ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Attach roles for the page in a single query.
    const ids = rows.map((u) => u.id);
    const rolesByUser = {};
    if (ids.length) {
      const { rows: rr } = await query(
        `SELECT ur.user_id, r.id, r.name
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = ANY($1)`,
        [ids]
      );
      for (const r of rr) (rolesByUser[r.user_id] ||= []).push({ id: r.id, name: r.name });
    }

    // Attach module allocation for the page in a single query.
    const modulesByUser = {};
    if (ids.length) {
      const { rows: mm } = await query(
        `SELECT user_id, module_key FROM user_modules WHERE user_id = ANY($1)`,
        [ids]
      );
      for (const m of mm) (modulesByUser[m.user_id] ||= []).push(m.module_key);
    }

    res.json({
      users: rows.map((u) => ({
        ...u,
        roles: rolesByUser[u.id] || [],
        modules: modulesByUser[u.id] || [],
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/admin/users/:id — detail incl. roles + permissions
adminUsersRouter.get("/users/:id", checkPermission("users.view"), async (req, res, next) => {
  try {
    const user = await loadUser("id = $1", [req.params.id]);
    if (!user) return res.status(404).json({ detail: "User not found" });
    res.json({ user: publicUser(user), roles: user.roles, permissions: user.permissions });
  } catch (e) {
    next(e);
  }
});

// PUT /api/auth/admin/users/:id — update email / status / roleIds
adminUsersRouter.put("/users/:id", checkPermission("users.update"), async (req, res, next) => {
  try {
    const { email, status, roleIds } = req.body || {};
    const id = Number(req.params.id);

    const existing = await query(`SELECT id FROM users WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ detail: "User not found" });

    if (status !== undefined && !VALID_STATUS.includes(status))
      return res.status(422).json({ detail: `Invalid status: ${status}` });

    if (email !== undefined) {
      if (!EMAIL_RE.test(email)) return res.status(422).json({ detail: "Invalid email" });
      const dupe = await query(`SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2`, [email, id]);
      if (dupe.rows.length) return res.status(409).json({ detail: "Email already in use", code: "EMAIL_TAKEN" });
    }

    let ids = null;
    if (roleIds !== undefined) {
      try {
        ids = await resolveRoleIds(roleIds);
      } catch (e) {
        return res.status(e.status || 422).json({ detail: e.message });
      }
    }

    await withClient(async (c) => {
      const sets = [];
      const params = [];
      if (email !== undefined) {
        params.push(email.toLowerCase());
        sets.push(`email = $${params.length}`);
      }
      if (status !== undefined) {
        params.push(status);
        sets.push(`status = $${params.length}`);
      }
      if (sets.length) {
        params.push(id);
        await c.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
      }
      if (ids !== null) {
        await c.query(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
        for (const roleId of ids)
          await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [id, roleId]);
      }
      // Deactivating a user kills their active sessions.
      if (status === "Inactive") await c.query(`DELETE FROM tokens WHERE user_id = $1`, [id]);
    });

    const user = await loadUser("id = $1", [id]);
    res.json({ user: publicUser(user), roles: user.roles, permissions: user.permissions });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/admin/users/:id/force-logout — drop all the user's sessions
adminUsersRouter.post("/users/:id/force-logout", checkPermission("users.update"), async (req, res, next) => {
  try {
    const existing = await query(`SELECT id FROM users WHERE id = $1`, [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ detail: "User not found" });
    const { rowCount } = await query(`DELETE FROM tokens WHERE user_id = $1`, [req.params.id]);
    res.json({ ok: true, sessions_cleared: rowCount });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/admin/users/:id/reset-password — generate a 1h reset link
// (also emailed). The link is returned so an admin can hand it over directly.
adminUsersRouter.post("/users/:id/reset-password", checkPermission("users.update"), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, email, name FROM users WHERE id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ detail: "User not found" });
    const user = rows[0];

    const token = signToken({ sub: user.id, type: TOKEN_TYPE.RESET_PASSWORD }, "1h");
    const resetUrl = `${config.frontendUrl}/auth/reset-password?token=${token}`;
    let emailSent = true;
    try {
      await sendResetPasswordEmail(user, token);
    } catch (e) {
      emailSent = false;
      console.error("[admin reset-password] email send failed:", e.message);
    }
    res.json({ email: user.email, resetToken: token, resetUrl, emailSent });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/admin/modules — the allocatable module/component catalogue
adminUsersRouter.get("/modules", checkPermission("users.view"), (_req, res) => {
  res.json({ modules: MODULES });
});

// PUT /api/auth/admin/users/:id/modules — replace a user's module allocation
adminUsersRouter.put("/users/:id/modules", checkPermission("users.update"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await query(`SELECT id FROM users WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ detail: "User not found" });

    const keys = sanitizeModules(req.body?.modules);
    await withClient(async (c) => {
      await c.query(`DELETE FROM user_modules WHERE user_id = $1`, [id]);
      for (const key of keys)
        await c.query(`INSERT INTO user_modules (user_id, module_key) VALUES ($1, $2)`, [id, key]);
    });

    const user = await loadUser("id = $1", [id]);
    res.json({ user: publicUser(user), modules: user.modules });
  } catch (e) {
    next(e);
  }
});
