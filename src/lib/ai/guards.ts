// Deterministic checks applied to model output. None of these trust the model.
import { AiAnalysisSchema, type AiAnalysis } from "./schema";
import { priceSelection, ProposalError, type TrustedLineItem } from "../proposal";

export interface TrustedPolicy {
  key: string;
  title: string;
  text: string;
}

/** Normalize whitespace and typographic quotes so a faithful quote still matches. */
export function normalizeForQuote(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export interface EvidenceCheck {
  policyKey: string;
  quote: string;
  verified: boolean;
  reason?: string;
}

export const MIN_QUOTE_CHARS = 12;

export function verifyEvidence(evidence: AiAnalysis["policyEvidence"], policies: TrustedPolicy[]): EvidenceCheck[] {
  const byKey = new Map(policies.map((p) => [p.key, normalizeForQuote(p.text)]));
  return evidence.map((e) => {
    const text = byKey.get(e.policyKey);
    if (text === undefined) return { policyKey: e.policyKey, quote: e.quote, verified: false, reason: "Unknown policy section" };
    const q = normalizeForQuote(e.quote).replace(/[.\s]+$/, "");
    if (q.length < MIN_QUOTE_CHARS) return { policyKey: e.policyKey, quote: e.quote, verified: false, reason: "Quote too short to be evidence" };
    if (!text.includes(q)) return { policyKey: e.policyKey, quote: e.quote, verified: false, reason: "Quote not found verbatim in policy" };
    return { policyKey: e.policyKey, quote: e.quote, verified: true };
  });
}

// Patterns that indicate a customer message is trying to instruct the system.
// This is a backstop; the model is also asked to flag injection. Either signal forces escalation.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier|your) (instructions|rules|prompt|policies)/i,
  /\b(system|developer)\s*(prompt|message|override|mode|instruction)/i,
  /^\s*(system|assistant|developer)\s*:/im,
  /<\/?\s*(system|instructions?|assistant|tool)\b/i,
  /\byou (are|must) now\b/i,
  /\b(authorize|authorise|approve|execute|issue|process)\s+(an?\s+|the\s+|my\s+)?(immediate\s+|automatic\s+)?(full\s+)?refund\b.*\b(immediately|now|automatically|without (review|approval))/i,
  /\b(call|invoke|use) (the )?(refund|payments?|paypal) (api|tool|endpoint|function)/i,
  /\bpre-?approved\b/i,
];

export function detectInjection(message: string): string[] {
  return INJECTION_PATTERNS.filter((p) => p.test(message)).map((p) => p.source);
}

export type ParseResult =
  | { ok: true; analysis: AiAnalysis }
  | { ok: false; errors: string[] };

/** Parse unknown model output safely. Never throws. */
export function parseModelOutput(raw: unknown): ParseResult {
  const result = AiAnalysisSchema.safeParse(raw);
  if (result.success) return { ok: true, analysis: result.data };
  return {
    ok: false,
    errors: result.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

export interface DecisionInput {
  parse: ParseResult;
  orderItems: TrustedLineItem[];
  policies: TrustedPolicy[];
  complaint: string;
  deliveredAt: Date | null;
  now: Date;
  returnWindowDays: number;
  remainingRefundableCents: number | null; // null when no verified payment is linked
}

export interface Decision {
  action: "REFUND" | "DECLINE" | "ESCALATE";
  items: { lineItemId: string; quantity: number }[];
  amountCents: number; // computed by app code from trusted order data
  reasons: string[]; // why escalated / notes for the merchant
  evidence: EvidenceCheck[];
  injectionSignals: string[];
}

/**
 * Turn (untrusted) model output into a proposal. Application code decides the action and amount.
 * The model's recommendation can only make the outcome MORE conservative, never less.
 */
export function decide(input: DecisionInput): Decision {
  const reasons: string[] = [];
  const injectionSignals = detectInjection(input.complaint);

  if (!input.parse.ok) {
    return {
      action: "ESCALATE",
      items: [],
      amountCents: 0,
      reasons: ["AI output failed validation and was rejected; manual review required.", ...input.parse.errors.map((e) => `Validation: ${e}`)],
      evidence: [],
      injectionSignals,
    };
  }
  const a = input.parse.analysis;
  const evidence = verifyEvidence(a.policyEvidence, input.policies);

  // Price the model-selected items using trusted order data.
  let items: { lineItemId: string; quantity: number }[] = [];
  let amountCents = 0;
  let itemsValid = true;
  try {
    const priced = priceSelection(input.orderItems, a.affectedItems.map((i) => ({ lineItemId: i.lineItemId, quantity: i.quantity })));
    items = priced.lines.map(({ lineItemId, quantity }) => ({ lineItemId, quantity }));
    amountCents = priced.amountCents;
  } catch (e) {
    itemsValid = false;
    reasons.push(`AI referenced invalid line items: ${e instanceof ProposalError ? e.message : "unknown error"}`);
  }

  let action: Decision["action"] = a.recommendation;

  const escalate = (why: string) => {
    reasons.push(why);
    action = "ESCALATE";
  };

  if (a.recommendation === "ESCALATE") reasons.push(...a.escalationReasons.map((r) => `AI: ${r}`));
  if (!itemsValid) escalate("Line-item selection could not be validated against the order.");
  if (a.injectionSuspected || injectionSignals.length > 0) {
    escalate("Customer message contains instructions aimed at the system (possible prompt injection). Treated as untrusted text.");
  }
  const unverified = evidence.filter((e) => !e.verified);
  if (unverified.length > 0) escalate(`${unverified.length} quoted policy passage(s) could not be found in the policy text.`);
  if ((action === "REFUND" || action === "DECLINE") && evidence.filter((e) => e.verified).length === 0) {
    escalate(`No verified policy evidence supports a ${action.toLowerCase()}.`);
  }
  if (action === "REFUND" && items.length === 0) escalate("Refund recommended but no affected line items identified.");

  // Return window is enforced from trusted structured data, not the model.
  if (!input.deliveredAt) {
    escalate("Order has no recorded delivery date; return-window eligibility cannot be determined.");
  } else {
    const days = Math.floor((input.now.getTime() - input.deliveredAt.getTime()) / 86_400_000);
    if (days > input.returnWindowDays) {
      escalate(`Request is ${days} days after delivery, outside the ${input.returnWindowDays}-day return window.`);
    }
  }

  if (input.remainingRefundableCents === null) {
    reasons.push("No verified PayPal capture is linked to this order yet; link one in Demo Setup before approval.");
  } else if (amountCents > input.remainingRefundableCents) {
    escalate(`Computed amount exceeds remaining refundable balance on the capture.`);
  }

  if (a.missingFacts.length > 0) reasons.push(...a.missingFacts.map((f) => `Missing fact: ${f}`));
  if (/\$\s?\d/.test(a.customerReply)) reasons.push("Draft reply mentions a dollar figure; confirm it matches the approved amount before sending.");

  if (action === "DECLINE") return { action, items: [], amountCents: 0, reasons, evidence, injectionSignals };
  return { action, items, amountCents, reasons, evidence, injectionSignals };
}
