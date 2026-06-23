// Rule-based ticket classifier (keyword heuristics).
// Not AI — a deterministic first pass so tickets don't pile up as Uncategorized.
// Swap classify() for a Claude call (Phase 2) for semantic accuracy later.

// Canonical taxonomy. `code` is stored in tickets.category.
// `group` rolls each category up into the QRC framework
// (Q = Queries, R = Requests, C = Complaints; null = ungrouped).
export const CATEGORIES = {
  complaint:   { label: "Customer complaints",       priority: "P2", group: "C" },
  inquiry:     { label: "Product inquiries",         priority: "P3", group: "Q" },
  pricing:     { label: "Pricing requests",          priority: "P3", group: "Q" },
  support:     { label: "Support tickets",           priority: "P3", group: "R" },
  order:       { label: "Order status questions",    priority: "P3", group: "Q" },
  partnership: { label: "Partnership requests",      priority: "P3", group: "R" },
  spam:        { label: "Spam/unimportant emails",   priority: "P3", group: null },
};

export const CATEGORY_CODES = Object.keys(CATEGORIES);

// QRC groups → member category codes.
export const GROUPS = {
  Q: { label: "Queries", codes: CATEGORY_CODES.filter((c) => CATEGORIES[c].group === "Q") },
  R: { label: "Requests", codes: CATEGORY_CODES.filter((c) => CATEGORIES[c].group === "R") },
  C: { label: "Complaints", codes: CATEGORY_CODES.filter((c) => CATEGORIES[c].group === "C") },
};

// Evaluated in this order — first match wins. High-signal buckets first.
// Each bucket lists keywords per language: English, then Hindi (Devanagari),
// then Hinglish (romanised Hindi). Matching is a lowercase substring test, so
// supporting a new language is purely additive — append its terms here, no
// logic change. Arbitrary languages are still handled by the Claude classifier
// (semantic), which runs ahead of these rules when an API key is configured.
const RULES = [
  ["spam", [
    // en
    "unsubscribe", "lottery", "you have won", "viagra", "casino", "crypto",
    "bitcoin", "click here", "earn money", "seo service", "guest post",
    "backlink", "marketing service", "limited offer", "act now", "free trial",
    "congratulations you", "claim your",
    // hi
    "लॉटरी", "इनाम जीत", "आपने जीता", "मुफ्त", "अभी क्लिक", "पैसे कमाओ", "बधाई हो आपने",
    // hinglish
    "lottery jeet", "inaam jeet", "muft", "abhi click karein", "paisa kamao", "paise kamao",
  ]],
  ["complaint", [
    // en
    "complaint", "complain", "wrong", "harass", "fraud", "cheat", "scam",
    "unauthor", "double charg", "extra emi", "deducted twice", "wrongly deducted",
    "not received", "worst", "disappoint", "pathetic", "terrible", "refund",
    "mental", "threat", "rude", "misbehav",
    // hi
    "शिकायत", "धोखा", "ठगी", "फ्रॉड", "गलत तरीके", "परेशान कर", "पैसे कट गए", "दो बार कट",
    "वापस चाहिए", "रिफंड", "बदतमीज़", "बेकार", "गाली", "धमकी",
    // hinglish
    "shikayat", "dhoka", "thagi", "galat tarike", "pareshan kar", "paise kat gaye",
    "do baar kat", "wapas chahiye", "badtameez", "bekaar", "dhamki",
  ]],
  ["partnership", [
    // en
    "partner", "partnership", "collaborat", "tie-up", "tie up", "business propos",
    "integrat", "api access", "reseller", "affiliate", "vendor", "co-brand",
    "channel partner", "dsa",
    // hi
    "साझेदारी", "पार्टनरशिप", "व्यापार प्रस्ताव", "जुड़ना चाहते", "साथ काम",
    // hinglish
    "saajhedari", "partnership karni", "vyapar prastav", "judna chahte", "saath kaam",
  ]],
  ["pricing", [
    // en
    "price", "pricing", "cost", "charges", "processing fee", "interest rate",
    "rate of interest", "quote", "how much", "emi amount", "tariff", "roi",
    "what are the charges", "fees",
    // hi
    "ब्याज दर", "ब्याज कितना", "कीमत", "शुल्क", "प्रोसेसिंग फीस", "कितने का", "दर क्या",
    // hinglish
    "byaj dar", "byaj kitna", "keemat", "shulk", "processing fees", "kitne ka", "dar kya",
  ]],
  ["order", [
    // en
    "order status", "track", "application status", "loan status", "status of my",
    "disbursal", "disbursement", "when will i get", "when will i receive",
    "pending approval", "approval status", "where is my",
    // hi
    "मेरा लोन कहाँ", "कब मिलेगा", "कब आएगा", "डिसबर्सल", "अप्रूवल कब", "ट्रैक कर",
    // hinglish
    "loan kahan hai", "kab milega", "kab aayega", "disbursal kab", "approval kab", "track karna",
  ]],
  ["support", [
    // en
    "not working", "error", "login", "log in", "can't", "cannot", "unable",
    "reset", "otp", "app crash", "bug", "technical", "not able", "stuck",
    "verification", "kyc", "document upload", "password",
    // hi
    "काम नहीं कर रहा", "लॉगिन नहीं", "ओटीपी नहीं आया", "एरर", "ऐप क्रैश", "पासवर्ड",
    "केवाईसी", "अटक गया", "वेरिफिकेशन",
    // hinglish
    "kaam nahi kar raha", "login nahi ho raha", "otp nahi aaya", "error aa raha",
    "app crash ho", "password reset", "atak gaya",
  ]],
  ["inquiry", [
    // en
    "how do i", "what is", "information", "details", "eligibility", "interested",
    "want to know", "tell me about", "apply", "loan", "would like to",
    "could you please", "inquiry", "enquiry", "query",
    // hi
    "कैसे करें", "क्या है", "जानकारी", "लोन चाहिए", "पात्रता", "आवेदन", "लोन कैसे ले",
    "जानना चाहता",
    // hinglish
    "kaise karein", "kya hai", "jankari chahiye", "loan chahiye", "patrata",
    "aavedan", "loan kaise le", "janna chahta",
  ]],
];

/**
 * Classify an email into { code, priority }.
 * Falls back to "inquiry" when nothing matches (most inbound is a product inquiry).
 */
export function classify(subject = "", body = "") {
  const text = `${subject} ${body}`.toLowerCase();
  for (const [code, keywords] of RULES) {
    if (keywords.some((kw) => text.includes(kw))) {
      return { code, priority: CATEGORIES[code].priority };
    }
  }
  return { code: "inquiry", priority: CATEGORIES.inquiry.priority };
}
