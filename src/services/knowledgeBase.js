// Intent knowledge base for keyword-based auto-answers.
//
// SOURCE OF TRUTH: every answer below is grounded ONLY in facts published on
// https://www.rapidmoney.in (home, /instant-personal-loan, /contact-us) as of
// 2026-06. Do NOT add figures or policies that aren't on the website. For
// topics the site does not document (e.g. exact NOC / foreclosure terms), the
// answer intentionally routes the customer to support instead of inventing one.
//
// Verified facts used (rapidmoney.in — home, /instant-personal-loan, /about-us,
// /lending-partners, /contact-us, /refund-policy, /term-conditions):
//   • Operator: MoneyTime Technology Solutions Pvt. Ltd. Not a bank; lends via
//     RBI-regulated NBFC partner RU Loans Financial Services Pvt. Ltd. (RFSPL,
//     support@rfspl.co.in, 9167607070).
//   • Mission: credit access to 10 million people over 5 years; "no hidden
//     fees", responsible lending.
//   • Loan amount: ₹5,000–₹50,000 | Tenure: up to 6 months
//   • Interest: 0.1%–0.15% per day | Processing fee: 5%–15% (excl. GST), up to
//     15% charged at disbursement.
//   • Eligibility: Indian citizen, age 25–58, min salary ₹20,000/mo credited
//     regularly, credit score 650–900
//   • Documents: ID — Aadhaar, PAN; Address — Aadhaar/utility bill/bank or
//     home-loan statement/rent agreement; Income — bank statement/payslip/work email
//   • Disbursal within 24 hours; fully digital, zero paperwork, direct to bank
//   • Late payment: a Late Payment Fee applies; missing EMI for 3 consecutive
//     months = default, reported to the credit bureau (affects credit score).
//   • Refunds: only for amount debited on a failed/duplicate transaction; claim
//     within 7 days; processed within 15 days of acceptance, credited within
//     7 working days; email support@rapidmoney.in with the transaction number.
//   • Grievance: acknowledged within 1 working day, initial response within 15
//     working days; escalate to GRO Avinash Babulal Dhivar
//     (avinash.dhivar@rapidmoney.in), then RBI Sachet portal sachet.rbi.org.in.
//   • Support: support@rapidmoney.in | App: "RapidMoney" on Google Play

export const INTENTS = [
  {
    // Placed first so it wins over the generic "refund"/"pricing" intents when
    // the email is about the application fee being charged. keywordsAll requires
    // BOTH a fee term AND a deduction term, so a plain "what's the fee?" pricing
    // question does NOT match this and still routes to interest_rate.
    key: "rejection_fee",
    title: "Application fee charged despite rejection",
    // Each "a|b|c" group also carries Hindi/Hinglish synonyms so a Hindi or
    // Hinglish "₹199 fee was deducted" email still matches both required groups.
    keywordsAll: [
      "application fee|loan application fee|₹199|199|आवेदन शुल्क|एप्लीकेशन फीस|aavedan shulk|application fees",
      "deduct|debit|charged|charge|cut|paid|taken|काट|कट गए|कट गया|kat gaye|kata|liya",
    ],
    answer:
      "The ₹199 Loan Application Fee is charged towards credit assessment, verification, and loan evaluation services conducted during the application process. As these services are performed regardless of the final loan decision, the fee is non-refundable, even if the loan application is not approved.\n\nWe appreciate your understanding.\n\nTeam RapidMoney",
  },
  {
    key: "rejection_reason",
    title: "Why loan was rejected / reapply",
    keywords: [
      // en
      "why was my loan", "why loan rejected", "why was i rejected", "why rejected",
      "loan rejected", "loan was rejected", "loan is rejected", "loan got rejected",
      "application rejected", "application is rejected", "application was rejected",
      "loan declined", "application declined", "reason for rejection", "reason of rejection",
      "reapply", "re-apply", "apply again", "can i apply",
      // hi
      "लोन रिजेक्ट", "लोन क्यों रिजेक्ट", "लोन क्यों रद्द", "आवेदन रिजेक्ट",
      "रिजेक्शन का कारण", "दोबारा आवेदन", "फिर से अप्लाई",
      // hinglish
      "loan reject", "loan kyon reject", "loan kyu reject", "application reject",
      "rejection ka karan", "dobara apply", "phir se apply",
    ],
    answer:
      "Loan applications are evaluated based on multiple factors, including eligibility criteria, credit assessment, verification results, and internal risk policies. Unfortunately, your application did not meet the requirements for approval at this time.\n\nYou may reapply after 30 days from the date of rejection, subject to eligibility criteria applicable at that time.\n\nWe appreciate your interest in RapidMoney and thank you for your understanding.\n\nTeam RapidMoney",
  },
  {
    key: "noc",
    title: "NOC / closure certificate",
    keywords: [
      "noc", "no objection", "closure certificate", "loan closed certificate",
      "एनओसी", "अनापत्ति", "क्लोजर सर्टिफिकेट", "लोन बंद सर्टिफिकेट",
      "noc chahiye", "anapatti", "closure certificate",
    ],
    answer:
      "For a No Objection Certificate (NOC) once your loan is fully repaid, please write to support@rapidmoney.in with your registered details and our team will assist you.",
  },
  {
    key: "foreclosure",
    title: "Foreclosure / prepayment",
    keywords: [
      "foreclos", "preclos", "prepay", "close my loan early", "settle my loan", "early closure",
      "फोरक्लोज़", "लोन जल्दी बंद", "प्रीपे", "लोन सेटल", "जल्दी बंद",
      "foreclose", "loan jaldi band", "prepay", "loan settle", "jaldi band karu",
    ],
    answer:
      "For foreclosure or early repayment of your RapidMoney loan, please contact support@rapidmoney.in and our team will share the applicable details for your specific loan.",
  },
  {
    key: "refund",
    title: "Refund / failed or duplicate payment",
    keywords: [
      "refund", "money debited", "amount debited", "deducted but", "failed transaction",
      "duplicate payment", "paid twice", "double payment", "transaction failed but",
      "रिफंड", "पैसे कट गए", "राशि कट", "फेल ट्रांज़ैक्शन", "दो बार भुगतान", "दो बार कट",
      "refund chahiye", "paise kat gaye", "fail transaction", "do baar payment", "do baar kat",
    ],
    answer:
      "If an amount was debited from your bank/card on a failed or duplicate transaction, you can claim a refund within 7 days of the payment by emailing support@rapidmoney.in with the transaction reference number, your registered mobile number, beneficiary bank details (name, account number, IFSC) and the reason. Eligible refunds are processed within 15 days of acceptance and credited within 7 working days.",
  },
  {
    key: "late_payment",
    title: "Late payment / missed EMI",
    keywords: [
      "late payment", "late fee", "missed", "miss my emi", "skip my emi", "can't pay",
      "cannot pay", "couldn't pay", "didn't pay", "did not pay", "unable to pay",
      "penalty", "penal", "overdue", "default",
      "देर से भुगतान", "लेट फीस", "ईएमआई मिस", "भुगतान नहीं कर", "नहीं चुका", "पेनल्टी", "ओवरड्यू",
      "late payment", "late fee", "emi miss", "pay nahi kar", "emi nahi de", "penalty", "overdue",
    ],
    answer:
      "If an EMI is paid late, a Late Payment Fee applies as per your loan agreement. Please note that missing your EMI for three consecutive months is treated as a default and is reported to the credit bureau, which can affect your credit score. If you're facing difficulty, please write to support@rapidmoney.in and our team will help.",
  },
  {
    key: "grievance",
    title: "Contact / grievance",
    keywords: [
      "grievance", "complaint email", "customer care", "helpline", "phone number",
      "contact number", "how do i contact", "talk to someone", "nodal officer", "escalate",
      "शिकायत", "कस्टमर केयर", "हेल्पलाइन", "फोन नंबर", "संपर्क नंबर", "किससे बात", "एस्केलेट",
      "shikayat", "customer care", "helpline", "phone number", "kisse baat karu", "escalate",
    ],
    // Contact emails are intentionally omitted here — the auto-reply footer
    // already carries support@ and the Grievance Officer's address, so this
    // answer focuses on the SLA timelines + RBI escalation path (not in footer).
    answer:
      "We acknowledge complaints within 1 working day and provide an initial response within 15 working days. If your grievance remains unresolved, you may escalate it to our Grievance Redressal Officer, Avinash Babulal Dhivar, and thereafter to the RBI via the Sachet portal (sachet.rbi.org.in).",
  },
  {
    key: "interest_rate",
    title: "Interest rate & fees",
    keywords: [
      "interest rate", "rate of interest", "roi", "what is the interest", "processing fee",
      "charges", "pricing", "how much interest",
      "ब्याज दर", "ब्याज कितना", "प्रोसेसिंग फीस", "शुल्क", "कितना ब्याज", "दर क्या",
      "byaj dar", "byaj kitna", "processing fee", "shulk", "kitna byaj", "dar kya hai",
    ],
    answer:
      "RapidMoney personal loans carry interest of 0.1% to 0.15% per day, with a processing fee of 5% to 15% (excluding GST). Your exact rate and fee are shown in your loan offer in the app before you accept it.",
  },
  {
    key: "emi",
    title: "EMI / repayment schedule",
    keywords: [
      "emi date", "due date", "next emi", "emi due", "when is my emi", "emi amount",
      "emi schedule", "instalment", "installment",
      "ईएमआई तारीख", "देय तिथि", "अगली ईएमआई", "ईएमआई कब", "ईएमआई राशि", "किस्त",
      "emi date", "due date", "agli emi", "emi kab", "emi kitni", "kist",
    ],
    answer:
      "RapidMoney loans are repaid in fixed monthly instalments over a tenure of up to 6 months. Your exact instalment amount and schedule are available in the RapidMoney app; our team can also help if you have a specific question.",
  },
  {
    key: "repayment",
    title: "Repayment / payment",
    keywords: [
      "how to pay", "payment method", "pay emi", "repay", "payment failed", "make payment",
      "कैसे भुगतान", "भुगतान तरीका", "ईएमआई भर", "भुगतान फेल", "पेमेंट कैसे",
      "kaise pay karu", "payment kaise", "emi bharo", "repay", "payment fail",
    ],
    answer:
      "Your RapidMoney loan is repaid in fixed monthly instalments (tenure up to 6 months). To make or check a payment, please use the RapidMoney app — our team can assist if you face any issue.",
  },
  {
    key: "loan_amount",
    title: "Loan amount & tenure",
    keywords: [
      "loan amount", "how much can i borrow", "maximum loan", "minimum loan", "borrow",
      "tenure", "repayment period", "how much loan",
      "लोन राशि", "कितना लोन", "अधिकतम लोन", "न्यूनतम लोन", "अवधि", "कितना उधार",
      "loan amount", "kitna loan", "max loan", "min loan", "tenure", "kitna udhar",
    ],
    answer:
      "RapidMoney offers instant personal loans from ₹5,000 to ₹50,000, repayable over a tenure of up to 6 months. The amount you're eligible for is shown when you apply in the app.",
  },
  {
    key: "loan_status",
    title: "Application / disbursal status",
    // NOTE: bare "approved" is intentionally excluded — it's too generic and
    // matched rejection emails ("once my loan is approved … but it's rejected").
    keywords: [
      "loan status", "application status", "status of my", "disbursal", "disburse",
      "when will i get", "when will i receive", "pending approval",
      "लोन स्थिति", "आवेदन स्थिति", "डिसबर्सल", "कब मिलेगा", "कब आएगा", "मेरा लोन कहाँ",
      "loan status", "application status", "disbursal", "kab milega", "kab aayega", "loan kahan hai",
    ],
    answer:
      "Once your application is approved, the amount is transferred directly to your bank account within 24 hours. You can track your application in the RapidMoney app, and our team will also check the latest status on your application.",
  },
  {
    key: "documents",
    title: "Documents / KYC",
    keywords: [
      "kyc", "aadhaar", "aadhar", "pan card", "document", "documents required",
      "what documents", "upload",
      "केवाईसी", "आधार", "पैन कार्ड", "दस्तावेज़", "कौन से दस्तावेज़", "अपलोड",
      "kyc", "aadhaar", "pan card", "dastavej", "kaun se document", "upload",
    ],
    answer:
      "RapidMoney is fully digital with zero paperwork. You'll need: Identity — Aadhaar and PAN; Address proof — Aadhaar, a utility bill, bank/home-loan statement or rent agreement; Income proof — bank statement, payslip or work email.",
  },
  {
    key: "login_otp",
    title: "Login / OTP / app",
    keywords: [
      "login", "log in", "otp", "password", "can't access", "cannot login",
      "unable to login", "app not working", "app crash", "not receiving otp",
      "लॉगिन", "ओटीपी", "पासवर्ड", "एक्सेस नहीं", "लॉगिन नहीं", "ऐप नहीं चल", "ओटीपी नहीं आया",
      "login", "otp", "password", "access nahi", "login nahi ho", "app nahi chal", "otp nahi aaya",
    ],
    answer:
      "Please make sure you're using the latest version of the RapidMoney app from the Google Play Store. If you still can't log in or receive your OTP, reply with your registered mobile number and our team will help you.",
  },
  {
    key: "eligibility",
    title: "Eligibility",
    keywords: [
      "eligib", "am i eligible", "qualify", "who can apply", "criteria", "cibil",
      "credit score", "minimum salary", "interested in loan", "want a loan",
      "पात्रता", "क्या मैं योग्य", "योग्य", "कौन आवेदन", "मापदंड", "सिबिल", "क्रेडिट स्कोर", "लोन चाहिए",
      "patrata", "kya main eligible", "yogya", "kaun apply", "criteria", "cibil", "credit score", "loan chahiye",
    ],
    answer:
      "To be eligible for a RapidMoney personal loan you should be an Indian citizen aged 25–58, with a minimum monthly salary of ₹20,000 credited regularly to your bank account, and a credit score between 650 and 900. The quickest way to check your personalised eligibility is to apply in the RapidMoney app.",
  },
  {
    key: "apply",
    title: "How to apply / process",
    keywords: [
      "how to apply", "how do i apply", "apply for loan", "application process",
      "steps to apply", "want to apply",
      "कैसे आवेदन", "लोन के लिए आवेदन", "आवेदन प्रक्रिया", "अप्लाई करना", "अप्लाई कैसे",
      "kaise apply", "loan ke liye apply", "application process", "apply karna hai", "apply kaise",
    ],
    answer:
      "Applying is quick and fully online in three steps: 1) Apply and choose the amount you need, 2) fill and verify your basic details, 3) get instant approval and disbursement. There are no bank visits and zero paperwork — you can apply in the RapidMoney app or on rapidmoney.in.",
  },
  {
    key: "about",
    title: "About RapidMoney / lending partner",
    keywords: [
      "what is rapidmoney", "is rapidmoney a bank", "bank or nbfc", "who are you",
      "about rapidmoney", "is this safe", "is this legit", "rbi", "lending partner", "who is the lender",
      "रैपिडमनी क्या", "क्या यह बैंक", "कौन हो", "सुरक्षित है", "आरबीआई", "लेंडिंग पार्टनर", "कौन देता है लोन",
      "rapidmoney kya hai", "ye bank hai", "kaun ho", "safe hai", "rbi", "lending partner", "loan kaun deta",
    ],
    answer:
      "RapidMoney (operated by MoneyTime Technology Solutions Pvt. Ltd.) is a digital platform for instant personal loans online, with a mission of responsible lending and no hidden fees. RapidMoney is not a bank — your loan is provided by its RBI-regulated NBFC lending partner, RU Loans Financial Services Pvt. Ltd. (RFSPL).",
  },
];

// A customer reporting a rejected/declined/cancelled application must never get
// the upbeat "your loan is approved, money in 24h" answer. These cases need a
// human, so we suppress the loan_status intent and fall back to a holding ack.
const NEGATIVE_OUTCOME = /reject|declin|denied|not approved|disapprov|cancell/i;

// True if `text` contains any synonym in a "a|b|c" group.
const hasAnyOf = (text, group) => group.split("|").some((t) => text.includes(t));

/**
 * Detect the best-matching intent for an email.
 *
 * An intent matches if EITHER:
 *   • keywords     — any single keyword appears (substring match), OR
 *   • keywordsAll  — every group matches, where a group is a "syn1|syn2" set
 *                    (used for context-sensitive intents, e.g. fee + deducted).
 * @returns {{key, title, answer}|null}
 */
export function detectIntent(subject = "", body = "") {
  const text = `${subject} ${body}`.toLowerCase();
  const negative = NEGATIVE_OUTCOME.test(text);
  for (const intent of INTENTS) {
    const matched = intent.keywordsAll
      ? intent.keywordsAll.every((group) => hasAnyOf(text, group))
      : intent.keywords.some((kw) => text.includes(kw));
    if (!matched) continue;
    // Don't auto-answer application-status questions that are about a negative
    // outcome — route to a human via the holding ack instead.
    if (intent.key === "loan_status" && negative) continue;
    return intent;
  }
  return null;
}

/** Look up an intent by its key (used when Claude has already classified). */
export function intentByKey(key) {
  return INTENTS.find((i) => i.key === key) || null;
}
