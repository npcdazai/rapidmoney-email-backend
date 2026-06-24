import bcrypt from "bcryptjs";

const ROUNDS = 10;

/** Hash a plaintext password with bcrypt. */
export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

/** Compare a plaintext password against a stored bcrypt hash. */
export function comparePassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}
