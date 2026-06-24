import { query } from "../db.js";
import { verifyToken, TOKEN_TYPE } from "./jwt.js";
import { loadUser } from "./repo.js";

// Consistent 403 — mirrors the flowchart's INVALID_OR_EXPIRED_TOKEN node.
function denyToken(res) {
  return res.status(403).json({
    detail: "Invalid or expired token",
    code: "INVALID_OR_EXPIRED_TOKEN",
  });
}

/**
 * Gate for every protected route. Requires a Bearer session JWT that:
 *   1. has a valid signature and type=session,
 *   2. still exists in the tokens table and has not expired,
 *   3. belongs to an Active user.
 * On success sets req.user (with .roles and .permissions) and req.token.
 */
export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) return denyToken(res);

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      return denyToken(res);
    }
    if (payload.type !== TOKEN_TYPE.SESSION) return denyToken(res);

    // Token must still be on record and unexpired (enables logout / force-logout).
    const { rows } = await query(
      `SELECT 1 FROM tokens WHERE token = $1 AND expires_at > now()`,
      [token]
    );
    if (rows.length === 0) return denyToken(res);

    const user = await loadUser("id = $1", [payload.sub]);
    if (!user) return denyToken(res);
    if (user.status !== "Active") {
      return res
        .status(403)
        .json({ detail: "Account is inactive", code: "ACCOUNT_INACTIVE" });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Require that one of the caller's active roles grants `slug`.
 * Must run after authMiddleware.
 */
export function checkPermission(slug) {
  return (req, res, next) => {
    if (!req.user) return denyToken(res);
    if (!req.user.permissions.includes(slug)) {
      return res
        .status(403)
        .json({ detail: "You do not have permission to perform this action", code: "UNAUTHORIZED" });
    }
    next();
  };
}

/**
 * Require that the caller has at least one of the given app modules allocated.
 * Must run after authMiddleware. Used to gate feature APIs (mail/analytics/…).
 */
export function requireModule(...keys) {
  return (req, res, next) => {
    if (!req.user) return denyToken(res);
    const mods = req.user.modules || [];
    if (keys.some((k) => mods.includes(k))) return next();
    return res.status(403).json({
      detail: "This feature is not allocated to your account",
      code: "MODULE_NOT_ALLOCATED",
    });
  };
}

/**
 * Record one activity_logs row per successful (2xx) request, once the response
 * has finished. Fire-and-forget — logging must never break the request.
 */
export function activityLog(req, res, next) {
  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const userId = req.user?.id ?? null;
    query(
      `INSERT INTO activity_logs (user_id, method, path, status_code)
       VALUES ($1, $2, $3, $4)`,
      [userId, req.method, req.originalUrl, res.statusCode]
    ).catch((e) => console.error("[activityLog]", e.message));
  });
  next();
}
