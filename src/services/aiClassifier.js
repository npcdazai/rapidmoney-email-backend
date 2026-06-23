// Claude-powered email triage (Phase 2).
//
// Claude CLASSIFIES the email — it picks a category + the single best intent
// (from our fixed lists) plus sentiment/language. It does NOT write replies:
// the reply text always comes from the website-grounded knowledge base
// (knowledgeBase.js), so the "answers from the website only" guarantee holds.
//
// Gracefully no-ops (returns null) when ANTHROPIC_API_KEY is unset, so the
// keyword classifier remains the default. Uses structured outputs to force
// valid JSON. Model defaults to claude-opus-4-8 (override with AI_MODEL).

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { CATEGORIES, CATEGORY_CODES } from "./classifier.js";
import { INTENTS } from "./knowledgeBase.js";
import { SUBCATS, SUBCAT_KEYS } from "./qrc.js";

let client = null;
const getClient = () => (client ??= new Anthropic({ apiKey: config.anthropicApiKey }));

export const aiEnabled = () => !!config.anthropicApiKey;

const INTENT_KEYS = INTENTS.map((i) => i.key);

// Structured-output schema — no numeric/string constraints (unsupported); the
// model returns enums we validate against our own lists.
const SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: CATEGORY_CODES },
    intent: { type: "string", enum: [...INTENT_KEYS, "none"] },
    priority: { type: "string", enum: ["P1", "P2", "P3"] },
    sentiment: { type: "number" }, // -1 (very negative) .. 1 (very positive)
    language: { type: "string" }, // ISO code, e.g. "en", "hi"
    confidence: { type: "number" }, // 0 .. 1
  },
  required: ["category", "intent", "priority", "sentiment", "language", "confidence"],
  additionalProperties: false,
};

function buildSystem() {
  const cats = CATEGORY_CODES.map((c) => `- ${c}: ${CATEGORIES[c].label}`).join("\n");
  const intents = INTENTS.map((i) => `- ${i.key}: ${i.title}`).join("\n");
  return `You are a support-email triage classifier for RapidMoney, an Indian instant personal-loan provider (operated by MoneyTime Technology Solutions). Classify the customer email.

Pick exactly one category and the single best intent ("none" if no specific intent fits). Also detect sentiment (-1 very negative .. 1 very positive), the language ISO code (e.g. "en", "hi"), and your confidence (0..1). Complaints, harassment, fraud, or wrong-deduction emails are category "complaint". Promotional/junk is "spam". Do NOT write a reply — only classify.

Categories:
${cats}

Intents:
${intents}`;
}

/**
 * Classify an email with Claude.
 * @returns {{category, intent, priority, sentiment, language, confidence}|null}
 *          null when no API key is configured or the call fails.
 */
export async function analyzeEmail(subject = "", body = "") {
  if (!config.anthropicApiKey) return null;
  try {
    const resp = await getClient().messages.create({
      model: config.aiModel,
      max_tokens: 1024,
      system: buildSystem(),
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Subject: ${subject || "(no subject)"}\n\nBody:\n${(body || "").slice(0, 4000)}`,
        },
      ],
    });
    const text = resp.content.find((b) => b.type === "text")?.text;
    if (!text) return null;
    const data = JSON.parse(text);
    if (!CATEGORY_CODES.includes(data.category)) return null;
    if (data.intent === "none") data.intent = null;
    return data;
  } catch (e) {
    console.error(`[AI] classify failed: ${e.message}`);
    return null;
  }
}

// ───────── QRC classifier (auto-reply spec; Claude Haiku per the reference) ─────────

const QRC_MODEL = process.env.QRC_MODEL || "claude-haiku-4-5";

const QRC_SCHEMA = {
  type: "object",
  properties: {
    group: { type: "string", enum: ["query", "request", "complaint"] },
    subKey: { type: "string", enum: SUBCAT_KEYS },
    accountSpecific: { type: "boolean" },
    confidence: { type: "number" }, // 0..1
    sentiment: { type: "string", enum: ["negative", "neutral", "positive"] },
    urgency: { type: "string", enum: ["low", "normal", "high"] },
    summary: { type: "string" },
  },
  required: ["group", "subKey", "accountSpecific", "confidence", "sentiment", "urgency", "summary"],
  additionalProperties: false,
};

function buildQrcSystem() {
  const lines = SUBCAT_KEYS.map(
    (k) => `- ${k} (${SUBCATS[k].group})`
  ).join("\n");
  return `You triage customer support email for RapidMoney (Indian instant personal loans) into the QRC framework.

Query = wants information only, no account action. Request = wants the team to DO something / send a document. Complaint = dissatisfaction or something went wrong.

Classify by MEANING (handle paraphrasing, typos, Hinglish). Pick the single best sub-category and its group. Set accountSpecific=true when answering would need the customer's own account data (balances, their EMI amount/date, KYC status, their specific loan/application status) — those must be acknowledged, never auto-answered. Give confidence 0..1, sentiment, urgency, and a one-line summary. Do NOT write a reply.

Sub-categories:
${lines}`;
}

/**
 * Classify an email per the QRC spec with Claude.
 * @returns {{group, subKey, accountSpecific, confidence, sentiment, urgency, summary}|null}
 */
export async function analyzeQRC(subject = "", body = "") {
  if (!config.anthropicApiKey) return null;
  try {
    const resp = await getClient().messages.create({
      model: QRC_MODEL,
      max_tokens: 1024,
      system: buildQrcSystem(),
      output_config: { format: { type: "json_schema", schema: QRC_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `Subject: ${subject || "(no subject)"}\n\nBody:\n${(body || "").slice(0, 4000)}`,
        },
      ],
    });
    const text = resp.content.find((b) => b.type === "text")?.text;
    if (!text) return null;
    const data = JSON.parse(text);
    if (!SUBCAT_KEYS.includes(data.subKey)) return null;
    return data;
  } catch (e) {
    console.error(`[AI] QRC classify failed: ${e.message}`);
    return null;
  }
}
