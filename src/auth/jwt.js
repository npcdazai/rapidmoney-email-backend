import jwt from "jsonwebtoken";
import { config } from "../config.js";

// Token "type" claim distinguishes session tokens from the short-lived
// single-purpose tokens emailed to users.
export const TOKEN_TYPE = {
  SESSION: "session",
  SET_PASSWORD: "set_password",
  RESET_PASSWORD: "reset_password",
};

/** Sign a JWT. `expiresIn` follows the jsonwebtoken syntax (e.g. "1h", "7d"). */
export function signToken(payload, expiresIn) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

/** Verify + decode a JWT. Throws if invalid/expired; returns the payload. */
export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

/** Decode the `exp` claim (seconds since epoch) into a JS Date. */
export function expiryDate(token) {
  const { exp } = jwt.decode(token) || {};
  return exp ? new Date(exp * 1000) : null;
}
