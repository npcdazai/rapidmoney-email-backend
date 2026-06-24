import { Router } from "express";
import { query } from "../db.js";
import { config } from "../config.js";
import { signToken, verifyToken, expiryDate, TOKEN_TYPE } from "../auth/jwt.js";
import { hashPassword, comparePassword } from "../auth/password.js";
import { loadUser, publicUser } from "../auth/repo.js";
import { authMiddleware, checkPermission, activityLog } from "../auth/middleware.js";
import { sendResetPasswordEmail } from "../services/authEmail.js";
import { adminUsersRouter } from "./adminUsers.js";
import { rolesRouter } from "./roles.js";
import { permissionsRouter } from "./permissions.js";

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Issue a fresh session token and persist it; enforces single-session by
// clearing any existing tokens for the user first.
async function startSession(userId) {
  await query(`DELETE FROM tokens WHERE user_id = $1`, [userId]);
  const token = signToken({ sub: userId, type: TOKEN_TYPE.SESSION }, config.jwtExpiresIn);
  await query(
    `INSERT INTO tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiryDate(token)]
  );
  return token;
}

// Verify a single-purpose JWT (set/reset password) and return its payload, or
// null when the signature/type is invalid or it has expired.
function verifyPurposeToken(token, expectedType) {
  try {
    const payload = verifyToken(token);
    return payload.type === expectedType ? payload : null;
  } catch {
    return null;
  }
}

// Log every auth request (user is null on the public endpoints).
authRouter.use(activityLog);

// ───────────────────────── Public endpoints ─────────────────────────

// POST /api/auth/login
authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(422).json({ detail: "Email and password are required" });

    const user = await loadUser("lower(email) = lower($1)", [email], { withPassword: true });
    // Same response for unknown user / unset password / wrong password —
    // avoids leaking which accounts exist.
    if (!user || !user.password_set)
      return res.status(401).json({ detail: "Invalid credentials", code: "INVALID_CREDENTIALS" });
    if (user.status !== "Active")
      return res.status(403).json({ detail: "Account is inactive", code: "ACCOUNT_INACTIVE" });
    if (!(await comparePassword(password, user.password)))
      return res.status(401).json({ detail: "Invalid credentials", code: "INVALID_CREDENTIALS" });

    const token = await startSession(user.id);
    res.json({ token, user: publicUser(user), roles: user.roles, permissions: user.permissions });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/set-password — activate a new account
authRouter.post("/set-password", async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password)
      return res.status(422).json({ detail: "Token and password are required" });
    if (password.length < MIN_PASSWORD)
      return res.status(422).json({ detail: `Password must be at least ${MIN_PASSWORD} characters` });

    const payload = verifyPurposeToken(token, TOKEN_TYPE.SET_PASSWORD);
    if (!payload)
      return res.status(400).json({ detail: "Invalid or expired token", code: "INVALID_TOKEN" });

    const user = await loadUser("id = $1", [payload.sub]);
    if (!user)
      return res.status(400).json({ detail: "Invalid or expired token", code: "INVALID_TOKEN" });
    if (user.password_set)
      return res.status(409).json({ detail: "Password already set", code: "PASSWORD_ALREADY_SET" });

    const hash = await hashPassword(password);
    await query(
      `UPDATE users SET password = $1, password_set = TRUE, updated_at = now() WHERE id = $2`,
      [hash, user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/forgot-password
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(422).json({ detail: "Email is required" });

    const user = await loadUser("lower(email) = lower($1)", [email]);
    // Always respond ok — never reveal whether the address exists.
    if (user) {
      const token = signToken({ sub: user.id, type: TOKEN_TYPE.RESET_PASSWORD }, "1h");
      try {
        await sendResetPasswordEmail(user, token);
      } catch (e) {
        console.error("[forgot-password] email send failed:", e.message);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/reset-password
authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword)
      return res.status(422).json({ detail: "Token and newPassword are required" });
    if (newPassword.length < MIN_PASSWORD)
      return res.status(422).json({ detail: `Password must be at least ${MIN_PASSWORD} characters` });

    const payload = verifyPurposeToken(token, TOKEN_TYPE.RESET_PASSWORD);
    if (!payload)
      return res.status(400).json({ detail: "Invalid or expired token", code: "INVALID_TOKEN" });

    const user = await loadUser("id = $1", [payload.sub]);
    if (!user)
      return res.status(400).json({ detail: "Invalid or expired token", code: "INVALID_TOKEN" });

    const hash = await hashPassword(newPassword);
    await query(
      `UPDATE users SET password = $1, password_set = TRUE, updated_at = now() WHERE id = $2`,
      [hash, user.id]
    );
    // Reset invalidates any existing session (forces a fresh login).
    await query(`DELETE FROM tokens WHERE user_id = $1`, [user.id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ───────────────────────── Authenticated endpoints ─────────────────────────

// GET /api/auth/me — current profile + roles/permissions
authRouter.get("/me", authMiddleware, (req, res) => {
  res.json({
    user: publicUser(req.user),
    roles: req.user.roles,
    permissions: req.user.permissions,
  });
});

// POST /api/auth/logout — end the current session
authRouter.post("/logout", authMiddleware, async (req, res, next) => {
  try {
    await query(`DELETE FROM tokens WHERE token = $1`, [req.token]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// PUT /api/auth/update — edit own profile (name / email)
authRouter.put("/update", authMiddleware, checkPermission("users.update"), async (req, res, next) => {
  try {
    const { name, email } = req.body || {};
    const sets = [];
    const params = [];
    const add = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (name !== undefined) add("name", name);
    if (email !== undefined) {
      if (!EMAIL_RE.test(email))
        return res.status(422).json({ detail: "Invalid email" });
      const { rows } = await query(
        `SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2`,
        [email, req.user.id]
      );
      if (rows.length) return res.status(409).json({ detail: "Email already in use", code: "EMAIL_TAKEN" });
      add("email", email.toLowerCase());
    }
    if (!sets.length) return res.status(422).json({ detail: "Nothing to update" });

    params.push(req.user.id);
    await query(
      `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
      params
    );
    const updated = await loadUser("id = $1", [req.user.id]);
    res.json({ user: publicUser(updated) });
  } catch (e) {
    next(e);
  }
});

// ───────────────────────── Admin / RBAC sub-routers ─────────────────────────
// Everything below requires a valid session; individual permission checks live
// inside each sub-router.
authRouter.use("/admin", authMiddleware, adminUsersRouter);
authRouter.use("/role", authMiddleware, rolesRouter);
authRouter.use("/permission", authMiddleware, permissionsRouter);
