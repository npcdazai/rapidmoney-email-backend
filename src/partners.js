// Partner / system senders — grouped into their own sidebar folders so mail
// from payment gateways, the NBFC, etc. is separated from customer mail.
// Add a new partner by appending here (key, label, and its sender domains).
export const PARTNERS = [
  { key: "easebuzz", label: "Easebuzz", domains: ["easebuzz.in", "easebuzz.com"] },
  { key: "rfspl", label: "RFSPL", domains: ["rfspl.co.in"] },
];

export const PARTNER_KEYS = PARTNERS.map((p) => p.key);
export const partnerByKey = (k) => PARTNERS.find((p) => p.key === k) || null;

/**
 * Build a SQL condition (and its params) matching any of a partner's sender
 * domains: from_email ILIKE '%@domain'. Params are appended to `params`.
 */
export function partnerCondition(partner, params) {
  const likes = partner.domains.map((d) => {
    params.push(`%@${d}`);
    return `from_email ILIKE $${params.length}`;
  });
  return `(${likes.join(" OR ")})`;
}
