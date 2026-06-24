import { config } from "../config.js";
import { sendMail } from "./emailSender.js";

// Both emails funnel through sendMail() → deliver(), so the UAT sink applies.

/** Email a newly-created user the link to choose their first password. */
export function sendCreatePasswordEmail(user, token) {
  const link = `${config.frontendUrl}/auth/create-password?token=${token}`;
  return sendMail({
    to: user.email,
    subject: "Set up your RapidMoney CRM account",
    body: [
      `Hi ${user.name || ""},`.trim(),
      ``,
      `An account has been created for you on the RapidMoney CRM.`,
      `Click the link below to set your password and activate the account.`,
      `This link expires in 1 hour.`,
      ``,
      link,
      ``,
      `If you weren't expecting this, you can ignore this email.`,
    ].join("\n"),
  });
}

/** Email an existing user the link to reset a forgotten password. */
export function sendResetPasswordEmail(user, token) {
  const link = `${config.frontendUrl}/auth/reset-password?token=${token}`;
  return sendMail({
    to: user.email,
    subject: "Reset your RapidMoney CRM password",
    body: [
      `Hi ${user.name || ""},`.trim(),
      ``,
      `We received a request to reset your password.`,
      `Click the link below to choose a new one. This link expires in 1 hour.`,
      ``,
      link,
      ``,
      `If you didn't request this, you can safely ignore this email.`,
    ].join("\n"),
  });
}
