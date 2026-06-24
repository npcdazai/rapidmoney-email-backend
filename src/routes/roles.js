import { Router } from "express";
import { query, withClient } from "../db.js";
import { checkPermission } from "../auth/middleware.js";

// Mounted at /api/auth/role (behind authMiddleware).
export const rolesRouter = Router();

// Validate permissionIds exist; returns deduped int list.
async function resolvePermissionIds(permissionIds) {
  if (!Array.isArray(permissionIds) || permissionIds.length === 0) return [];
  const ids = [...new Set(permissionIds.map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return [];
  const { rows } = await query(`SELECT id FROM permissions WHERE id = ANY($1)`, [ids]);
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const err = new Error(`Unknown permission id(s): ${ids.filter((i) => !found.has(i)).join(", ")}`);
    err.status = 422;
    throw err;
  }
  return ids;
}

// Attach permissions to a list of role rows in one query.
async function withPermissions(roles) {
  const ids = roles.map((r) => r.id);
  if (!ids.length) return roles;
  const { rows } = await query(
    `SELECT rp.role_id, p.id, p.slug, p.name
       FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ANY($1)`,
    [ids]
  );
  const byRole = {};
  for (const r of rows) (byRole[r.role_id] ||= []).push({ id: r.id, slug: r.slug, name: r.name });
  return roles.map((r) => ({ ...r, permissions: byRole[r.id] || [] }));
}

// GET /api/auth/role — list roles with permissions
rolesRouter.get("/", checkPermission("roles.view"), async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, name, description, created_at, updated_at FROM roles ORDER BY name`);
    res.json({ roles: await withPermissions(rows) });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/role/:id
rolesRouter.get("/:id", checkPermission("roles.view"), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, description, created_at, updated_at FROM roles WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ detail: "Role not found" });
    const [role] = await withPermissions(rows);
    res.json({ role });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/role/create
rolesRouter.post("/create", checkPermission("roles.create"), async (req, res, next) => {
  try {
    const { name, description = null, permissionIds = [] } = req.body || {};
    if (!name || !name.trim()) return res.status(422).json({ detail: "Role name is required" });

    const dupe = await query(`SELECT 1 FROM roles WHERE lower(name) = lower($1)`, [name.trim()]);
    if (dupe.rows.length) return res.status(409).json({ detail: "Role name already exists", code: "ROLE_NAME_TAKEN" });

    let ids;
    try {
      ids = await resolvePermissionIds(permissionIds);
    } catch (e) {
      return res.status(e.status || 422).json({ detail: e.message });
    }

    const roleId = await withClient(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING id`,
        [name.trim(), description]
      );
      const id = rows[0].id;
      for (const pid of ids)
        await c.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [id, pid]);
      return id;
    });

    const { rows } = await query(`SELECT id, name, description, created_at, updated_at FROM roles WHERE id = $1`, [roleId]);
    const [role] = await withPermissions(rows);
    res.status(201).json({ role });
  } catch (e) {
    next(e);
  }
});

// PUT /api/auth/role/update/:id
rolesRouter.put("/update/:id", checkPermission("roles.update"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, description, permissionIds } = req.body || {};

    const existing = await query(`SELECT 1 FROM roles WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ detail: "Role not found" });

    if (name !== undefined) {
      if (!name.trim()) return res.status(422).json({ detail: "Role name cannot be empty" });
      const dupe = await query(`SELECT 1 FROM roles WHERE lower(name) = lower($1) AND id <> $2`, [name.trim(), id]);
      if (dupe.rows.length) return res.status(409).json({ detail: "Role name already exists", code: "ROLE_NAME_TAKEN" });
    }

    let ids = null;
    if (permissionIds !== undefined) {
      try {
        ids = await resolvePermissionIds(permissionIds);
      } catch (e) {
        return res.status(e.status || 422).json({ detail: e.message });
      }
    }

    await withClient(async (c) => {
      const sets = [];
      const params = [];
      if (name !== undefined) {
        params.push(name.trim());
        sets.push(`name = $${params.length}`);
      }
      if (description !== undefined) {
        params.push(description);
        sets.push(`description = $${params.length}`);
      }
      if (sets.length) {
        params.push(id);
        await c.query(`UPDATE roles SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
      }
      if (ids !== null) {
        await c.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
        for (const pid of ids)
          await c.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [id, pid]);
      }
    });

    const { rows } = await query(`SELECT id, name, description, created_at, updated_at FROM roles WHERE id = $1`, [id]);
    const [role] = await withPermissions(rows);
    res.json({ role });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/auth/role/delete/:id — blocked while still assigned to a user
rolesRouter.delete("/delete/:id", checkPermission("roles.delete"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await query(`SELECT 1 FROM roles WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ detail: "Role not found" });

    const inUse = await query(`SELECT COUNT(*)::int AS n FROM user_roles WHERE role_id = $1`, [id]);
    if (inUse.rows[0].n > 0)
      return res.status(409).json({
        detail: `Role is assigned to ${inUse.rows[0].n} user(s) and cannot be deleted`,
        code: "ROLE_IN_USE",
      });

    await query(`DELETE FROM roles WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/role/assign — set a user's roles
rolesRouter.post("/assign", checkPermission("users.update"), async (req, res, next) => {
  try {
    const { userId, roleIds } = req.body || {};
    if (!userId) return res.status(422).json({ detail: "userId is required" });
    if (!Array.isArray(roleIds)) return res.status(422).json({ detail: "roleIds must be an array" });

    const user = await query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (user.rows.length === 0) return res.status(404).json({ detail: "User not found" });

    const ids = [...new Set(roleIds.map(Number).filter(Number.isInteger))];
    if (ids.length) {
      const { rows } = await query(`SELECT id FROM roles WHERE id = ANY($1)`, [ids]);
      if (rows.length !== ids.length)
        return res.status(422).json({ detail: "One or more role ids are unknown" });
    }

    await withClient(async (c) => {
      await c.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
      for (const roleId of ids)
        await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, roleId]);
    });

    res.json({ ok: true, userId: Number(userId), roleIds: ids });
  } catch (e) {
    next(e);
  }
});
