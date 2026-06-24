// QRC auto-reply scheme — implements the internal "RapidMoney — QRC email
// auto-reply reference" spec. Incoming email is classified into
// Query / Request / Complaint, then a sub-category that determines routing,
// TAT, and which of the fixed templates goes out.
//
// Hard rules (from the spec):
//   1. Confidence < 0.75 → generic acknowledgement + route to a human.
//   2. Account-specific queries (balances, EMI, KYC) → acknowledge + route;
//      never reveal account data over email (sender not identity-verified).
//   3. Safe + confident query → auto-answer from the knowledge base only.
//   4. Requests & Complaints → always acknowledge + route, never auto-resolve.

// group: query | request | complaint
// accountSpecific (queries): needs account data → acknowledge, never auto-answer
// kb: knowledge-base intent key used for the live Query auto-answer (queries only)
// routedTo: owning team for the internal alert
// Each `kws` list is grouped by language — English, then Hindi (Devanagari),
// then Hinglish (romanised Hindi). Matching is a lowercase substring test, so a
// new language is just more entries in the same array. Arbitrary languages are
// still covered by the Claude classifier (analyzeQRC), which runs first.
export const SUBCATS = {
  // ── Queries · TAT 24 working hours ──
  loan_status: { group: "query", routedTo: "ops@rapidmoney.in", accountSpecific: true, kb: null, kws: [
    "status", "where is my loan", "application", "disbursal", "approved", "pending", "track", "how long",
    "मेरा लोन कहाँ", "कब मिलेगा", "कब आएगा", "डिसबर्सल", "ट्रैक", "अप्रूव", "स्थिति",
    "loan kahan", "kab milega", "kab aayega", "disbursal kab", "approve ho gaya", "track karu",
  ] },
  interest_rates: { group: "query", routedTo: "ops@rapidmoney.in", accountSpecific: false, kb: "interest_rate", kws: [
    "interest rate", "rate of interest", "roi", "charges", "processing fee", "what is the rate",
    "ब्याज दर", "ब्याज कितना", "दर", "प्रोसेसिंग फीस", "शुल्क", "कितना ब्याज",
    "byaj dar", "byaj kitna", "processing fee", "shulk", "kitna byaj", "dar kya",
  ] },
  eligibility: { group: "query", routedTo: "sales@rapidmoney.in", accountSpecific: false, kb: "eligibility", kws: [
    "am i eligible", "eligibility", "can i apply", "do i qualify", "criteria",
    "क्या मैं योग्य", "पात्रता", "योग्यता", "आवेदन कर सकता", "मापदंड",
    "kya main eligible", "patrata", "yogyata", "apply kar sakta", "criteria kya",
  ] },
  documents_required: { group: "query", routedTo: "ops@rapidmoney.in", accountSpecific: false, kb: "documents", kws: [
    "documents", "kyc", "what do i need", "proof", "pan", "aadhaar", "aadhar",
    "दस्तावेज़", "केवाईसी", "क्या चाहिए", "प्रूफ", "पैन", "आधार",
    "dastavej", "kyc", "kya chahiye", "proof", "pan card", "aadhaar",
  ] },
  repayment_info: { group: "query", routedTo: "collections@rapidmoney.in", accountSpecific: false, kb: "repayment", kws: [
    "how to pay", "payment options", "upi", "nach", "auto-debit", "autodebit",
    "कैसे भुगतान", "भुगतान विकल्प", "यूपीआई", "नैच", "ऑटो-डेबिट",
    "kaise pay karu", "payment options", "upi", "nach", "auto debit",
  ] },
  general_info: { group: "query", routedTo: "support@rapidmoney.in", accountSpecific: false, kb: null, kws: [] }, // catch-all

  // ── Requests · TAT 2 working days ──
  statement_request: { group: "request", routedTo: "ops@rapidmoney.in", kws: [
    "statement", "account statement", "repayment schedule", "send me my statement",
    "स्टेटमेंट", "खाता विवरण", "भुगतान अनुसूची", "स्टेटमेंट भेज",
    "statement bhejo", "khata vivran", "statement chahiye",
  ] },
  noc_request: { group: "request", routedTo: "ops@rapidmoney.in", kws: [
    "noc", "no objection", "closure certificate",
    "एनओसी", "अनापत्ति", "क्लोजर सर्टिफिकेट",
    "noc chahiye", "anapatti", "closure certificate",
  ] },
  foreclosure: { group: "request", routedTo: "collections@rapidmoney.in", kws: [
    "foreclose", "close my loan", "early closure", "preclose", "settle", "full payment",
    "फोरक्लोज़", "लोन बंद", "जल्दी बंद", "सेटल", "पूरा भुगतान",
    "foreclose", "loan band karo", "jaldi band", "settle", "pura bhugtan",
  ] },
  emi_reschedule: { group: "request", routedTo: "collections@rapidmoney.in", kws: [
    "reschedule", "change emi date", "extend", "restructure", "defer", "postpone",
    "रीशेड्यूल", "ईएमआई तारीख बदल", "बढ़ा दो", "आगे बढ़ा", "टाल",
    "reschedule", "emi date badlo", "aage badhao", "extend karo", "postpone",
  ] },
  profile_update: { group: "request", routedTo: "ops@rapidmoney.in", kws: [
    "update my", "change my number", "change email", "update address", "correct name",
    "अपडेट कर", "नंबर बदल", "ईमेल बदल", "पता बदल", "नाम सही कर",
    "update karo", "number badlo", "email badlo", "address badlo", "naam sahi",
  ] },
  callback_request: { group: "request", routedTo: "support@rapidmoney.in", kws: [
    "call me", "please call", "request callback", "contact me", "callback",
    "मुझे कॉल", "कृपया कॉल", "कॉल बैक", "संपर्क कर",
    "mujhe call karo", "call back karo", "callback", "contact karo",
  ] },

  // ── Complaints · TAT 3 working days → grievance@ ──
  payment_not_reflected: { group: "complaint", routedTo: "grievance@rapidmoney.in", kws: [
    "not reflected", "not updated", "debited but", "money debited", "deducted but", "paid but", "already paid",
    "नहीं दिखा", "अपडेट नहीं हुआ", "कट गए लेकिन", "पैसे कट", "पहले ही भुगतान",
    "nahi dikha", "update nahi hua", "kat gaye lekin", "paise kat gaye", "pehle hi pay",
  ] },
  extra_charges: { group: "complaint", routedTo: "grievance@rapidmoney.in", kws: [
    "extra charge", "wrongly charged", "overcharged", "hidden charge", "unauthorised debit", "unauthorized debit",
    "अतिरिक्त शुल्क", "गलत चार्ज", "ज्यादा काट", "छुपा शुल्क", "बिना बताए काट",
    "extra charge", "galat charge", "jyada kata", "chupa shulk", "bina bataye",
  ] },
  agent_behaviour: { group: "complaint", routedTo: "grievance@rapidmoney.in", kws: [
    "rude", "agent misbehaved", "harassment", "abusive", "recovery agent",
    "बदतमीज़", "एजेंट ने परेशान", "गाली", "रिकवरी एजेंट",
    "badtameez", "agent ne pareshan", "gaali", "recovery agent",
  ] },
  app_technical: { group: "complaint", routedTo: "grievance@rapidmoney.in", kws: [
    "app not working", "error", "can't login", "cannot login", "otp not received", "crash", "bug",
    "ऐप नहीं चल", "एरर", "लॉगिन नहीं", "ओटीपी नहीं आया", "क्रैश", "बग",
    "app nahi chal", "error", "login nahi ho", "otp nahi aaya", "crash",
  ] },
  data_privacy: { group: "complaint", routedTo: "grievance@rapidmoney.in", kws: [
    "privacy", "shared my number", "spam", "consent", "delete my data",
    "निजता", "नंबर शेयर", "स्पैम", "सहमति", "डेटा हटा",
    "privacy", "number share", "spam", "consent", "data delete",
  ] },
  mis_selling: { group: "complaint", routedTo: "grievance@rapidmoney.in", kws: [
    "mis-sold", "missold", "wrong information", "promised", "misled", "false", "different from what was said",
    "गलत जानकारी", "वादा किया", "गुमराह", "झूठ", "अलग बताया",
    "galat jankari", "vada kiya", "gumrah", "jhooth", "alag bataya tha",
  ] },
  other_grievance: { group: "complaint", routedTo: "grievance@rapidmoney.in", kws: [] }, // catch-all
};

export const SUBCAT_KEYS = Object.keys(SUBCATS);

export const TAT = {
  query: "24 working hours",
  request: "2 working days",
  complaint: "3 working days",
};

// Evaluation order: complaints first (safety), then requests, then specific
// queries; falls back to the query catch-all when nothing matches.
const ORDER = SUBCAT_KEYS.filter((k) => SUBCATS[k].group === "complaint" && k !== "other_grievance")
  .concat(SUBCAT_KEYS.filter((k) => SUBCATS[k].group === "request"))
  .concat(SUBCAT_KEYS.filter((k) => SUBCATS[k].group === "query" && k !== "general_info"));

/**
 * Keyword fallback classifier (used when no LLM key is configured).
 * @returns {{subKey, group, confidence, sentiment, urgency, summary}}
 */
export function classifyQRC(subject = "", body = "") {
  const text = `${subject} ${body}`.toLowerCase();
  let subKey = null;
  for (const key of ORDER) {
    if (SUBCATS[key].kws.some((kw) => text.includes(kw))) {
      subKey = key;
      break;
    }
  }
  const matched = !!subKey;
  if (!subKey) subKey = "general_info"; // query catch-all
  const group = SUBCATS[subKey].group;
  return {
    subKey,
    group,
    confidence: matched ? 0.9 : 0.4, // unmatched → low → acknowledge generically
    sentiment: group === "complaint" ? "negative" : "neutral",
    urgency: group === "complaint" ? "high" : "normal",
    summary: (body || subject || "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

// ───────── Customer auto-reply templates (RapidMoney QRC auto-reply responses) ─────────
// Each template has its own fixed Subject and Body. Greeting is "Hello," (no
// name needed); no reference number is shown to the customer. Selected by group
// + confidence (low confidence → universal catch-all).
const SIGNOFF = "Warm Regards,\nCustomer Experience Team\nRapidMoney";

export const TEMPLATES = {
  // Query — information request · 24 business hours
  query: {
    subject: "RapidMoney Support: We have received your query",
    body:
      "Hello,\n\nThank you for reaching out to RapidMoney. We have received your query and our team is reviewing it.\n\n" +
      "To help us assist you faster, kindly reply with:\n• Full Name\n• Registered Mobile Number\n\n" +
      "Our team will get back to you within 24 business hours. For account-specific details such as your application status, EMIs or statements, you can also log in to the RapidMoney app.\n\n" +
      "Thank you for choosing RapidMoney.\n\n" +
      SIGNOFF,
  },
  // Request — action or document · 2 business days
  request: {
    subject: "RapidMoney Support: Your request has been logged",
    body:
      "Hello,\n\nThank you for contacting RapidMoney. We have logged your request and assigned it to the relevant team for processing.\n\n" +
      "To help us process it securely, kindly reply with:\n• Full Name\n• Registered Mobile Number\n\n" +
      "For account-related actions we may verify your identity before proceeding. Our team will action your request and share an update within 2 business days.\n\n" +
      "Thank you for choosing RapidMoney.\n\n" +
      SIGNOFF,
  },
  // Complaint — grievance · 3 business days
  complaint: {
    subject: "RapidMoney Support: Your concern has been registered",
    body:
      "Hello,\n\nThank you for writing to us, and we are sorry for the inconvenience. Your concern has been registered as a grievance and assigned to our resolution team.\n\n" +
      "To help us investigate quickly, kindly reply with:\n• Full Name\n• Registered Mobile Number\n• Any relevant dates, amounts or screenshots\n\n" +
      "Our team will review the details and respond within 3 business days. If you are not satisfied with the resolution, you may escalate to our Grievance Redressal Officer at grievance@rapidmoney.in.\n\n" +
      "We value your trust and are committed to making this right.\n\n" +
      SIGNOFF,
  },
  // Universal acknowledgement — catch-all · 24 business hours
  universal: {
    subject: "RapidMoney Support: We have received your message",
    body:
      "Hello,\n\nThank you for contacting RapidMoney. This is an automated acknowledgement to confirm that we have successfully received your request and assigned it to the relevant team.\n\n" +
      "To help us assist you faster, kindly reply with:\n• Full Name\n• Registered Mobile Number\n\n" +
      "Our team is reviewing your request and will get back to you within 24 business hours.\n\n" +
      "Thank you for choosing RapidMoney.\n\n" +
      SIGNOFF,
  },
};

/**
 * Pick the customer template key from the QRC group + confidence.
 * Low confidence (or anything not clearly Q/R/C) → universal catch-all.
 */
export function pickTemplate(group, confident) {
  if (!confident) return "universal";
  if (group === "request") return "request";
  if (group === "complaint") return "complaint";
  if (group === "query") return "query";
  return "universal";
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Optional internal alert to the owning team (not the customer).
export function internalAlert({ group, subKey, ref, subject, from, urgency, sentiment, confidence, summary }) {
  return {
    subject: `[${cap(group)}/${subKey}] ${ref} - ${subject || "(no subject)"}`,
    body: `New ${cap(group)} routed by the QRC bot.\n\nTicket: ${ref}\nFrom: ${from}\nSub-category: ${subKey}\nUrgency: ${urgency}\nSentiment: ${sentiment}\nConfidence: ${typeof confidence === "number" ? confidence.toFixed(2) : confidence}\n\nSummary: ${summary || "(none)"}`,
  };
}

/** RM-YYYYMMDD-NNNNN reference from the email date + ticket id. */
export function makeReference(date, id) {
  let d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime())) d = new Date(); // guard invalid received_at
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `RM-${ymd}-${String(id).padStart(5, "0")}`;
}
