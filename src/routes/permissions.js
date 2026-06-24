import { Router } from "express";
import { query } from "../db.js";
import { checkPermission } from "../auth/middleware.js";

// Mounted at /api/auth/permission (behind authMiddleware).
export const permissionsRouter = Router();

const SLUG_RE = /^[a-z0-9]+(\.[a-z0-9]+)+$/; // e.g. users.create

// GET /api/auth/permission — list all permissions
permissionsRouter.get("/", checkPermission("permissions.view"), async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, slug, name, description, created_at FROM permissions ORDER BY slug`);
    res.json({ permissions: rows });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/permission/:id
permissionsRouter.get("/:id", checkPermission("permissions.view"), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, slug, name, description, created_at FROM permissions WHERE id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ detail: "Permission not found" });
    res.json({ permission: rows[0] });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/permission — create
permissionsRouter.post("/", checkPermission("permissions.manage"), async (req, res, next) => {
  try {
    const { slug, name = null, description = null } = req.body || {};
    if (!slug || !SLUG_RE.test(slug))
      return res.status(422).json({ detail: "slug must look like 'resource.action'" });

    const dupe = await query(`SELECT 1 FROM permissions WHERE slug = $1`, [slug]);
    if (dupe.rows.length) return res.status(409).json({ detail: "Permission slug already exists", code: "PERMISSION_EXISTS" });

    const { rows } = await query(
      `INSERT INTO permissions (slug, name, description) VALUES ($1, $2, $3)
       RETURNING id, slug, name, description, created_at`,
      [slug, name, description]
    );
    res.status(201).json({ permission: rows[0] });
  } catch (e) {
    next(e);
  }
});

// PUT /api/auth/permission/:id — update name/description (slug is immutable)
permissionsRouter.put("/:id", checkPermission("permissions.manage"), async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    const sets = [];
    const params = [];
    if (name !== undefined) {
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description);
      sets.push(`description = $${params.length}`);
    }
    if (!sets.length) return res.status(422).json({ detail: "Nothing to update" });

    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE permissions SET ${sets.join(", ")} WHERE id = $${params.length}
       RETURNING id, slug, name, description, created_at`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ detail: "Permission not found" });
    res.json({ permission: rows[0] });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/auth/permission/:id — cascades out of role_permissions
permissionsRouter.delete("/:id", checkPermission("permissions.manage"), async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM permissions WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ detail: "Permission not found" });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
