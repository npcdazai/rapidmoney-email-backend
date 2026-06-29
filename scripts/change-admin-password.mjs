import { query, pool } from "../src/db.js";
import { hashPassword } from "../src/auth/password.js";

const EMAIL = "admin@rapidmoney.in";
const NEW_PASSWORD = "rapidmoney!123";

const hash = await hashPassword(NEW_PASSWORD);
const { rowCount } = await query(
  `UPDATE users SET password = $1, password_set = TRUE WHERE lower(email) = lower($2)`,
  [hash, EMAIL]
);
console.log(rowCount ? `OK: password updated for ${EMAIL}` : `NO ROW: ${EMAIL} not found`);
await pool.end();
