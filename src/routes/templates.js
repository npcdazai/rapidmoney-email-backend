import { Router } from "express";
import { query } from "../db.js";
import { requireModule, activityLog } from "../auth/middleware.js";
import { MAIL_SECTIONS } from "../auth/modules.js";

export const templatesRouter = Router();

templatesRouter.use(activityLog);

// Light HTML sanitizer — strips executable markup so stored template bodies
// can't run script when rendered/inserted.
function sanitizeHtml(s) {
  if (s == null) return null;
  return String(s)
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|base)\b[^>]*>/gi, "")
    .replace(/ on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/ on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/ on\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "")
    .slice(0, 50000);
}

// GET /api/templates — list all templates.
templatesRouter.get("/", requireModule(...MAIL_SECTIONS), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, subject, body, created_by, updated_at
         FROM templates ORDER BY name ASC`
    );
    res.json({ items: rows });
  } catch (e) {
    next(e);
  }
});

// POST /api/templates — create a template.
templatesRouter.post("/", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { name, subject, body } = req.body || {};
    if (!name || !name.trim()) return res.status(422).json({ detail: "Name is required" });
    const by = req.user?.name || req.user?.email || "Agent";
    const { rows } = await query(
      `INSERT INTO templates (name, subject, body, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id, name, subject, body, created_by, updated_at`,
      [name.trim(), subject || null, sanitizeHtml(body), by]
    );
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/templates/:id — update a template.
templatesRouter.patch("/:id", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { name, subject, body } = req.body || {};
    if (!name || !name.trim()) return res.status(422).json({ detail: "Name is required" });
    const { rows } = await query(
      `UPDATE templates SET name = $2, subject = $3, body = $4, updated_at = now()
        WHERE id = $1 RETURNING id, name, subject, body, created_by, updated_at`,
      [req.params.id, name.trim(), subject || null, sanitizeHtml(body)]
    );
    if (!rows.length) return res.status(404).json({ detail: "Template not found" });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/templates/:id — delete a template.
templatesRouter.delete("/:id", requireModule(...MAIL_SECTIONS), async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM templates WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ detail: "Template not found" });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
