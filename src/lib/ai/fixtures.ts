// Recorded/hand-authored model outputs for AI_MODE=fixture. These are clearly labeled
// "Simulated AI" in the UI and are used for UI development and automated tests.
import type { AiAnalysis } from "./schema";

export const FIXTURE_ANALYSES: Record<string, AiAnalysis> = {
  case_a: {
    intent: "REFUND_REQUEST",
    summary: "Customer reports the ceramic pour-over set arrived cracked and requests a refund for that item only. The napkins are fine.",
    affectedItems: [{ lineItemId: "li_a1", quantity: 1, issue: "Arrived cracked; packaging appeared crushed" }],
    customerClaims: [
      { claim: "The ceramic pour-over set arrived cracked down the side", status: "UNVERIFIED_CUSTOMER_ALLEGATION" },
      { claim: "The shipping box looked crushed", status: "UNVERIFIED_CUSTOMER_ALLEGATION" },
    ],
    policyEvidence: [
      {
        policyKey: "damaged",
        quote: "We will refund the purchase price of the damaged item; you do not need to return it.",
        supports: "Damaged items are refunded at purchase price without a return.",
      },
      {
        policyKey: "damaged",
        quote: "Refunds for damaged items cover only the affected item, not the full order.",
        supports: "Only the pour-over set should be refunded, not the napkins or shipping.",
      },
    ],
    missingFacts: ["No photo of the damage was provided"],
    injectionSuspected: false,
    injectionNotes: "",
    recommendation: "REFUND",
    escalationReasons: [],
    rationale:
      "The request falls within 14 days of delivery and the damaged-items policy supports refunding the affected item only. The damage claim is unverified; the merchant may wish to request a photo.",
    customerReply:
      "Hi Dana, I'm so sorry your pour-over set arrived cracked. Under our damaged-item policy we refund the affected item, and you won't need to send it back. A member of our team is reviewing your request now and we'll confirm the refund to your original payment method shortly.",
  },
  case_b: {
    intent: "RETURN_REQUEST",
    summary: "Customer wants to return the walnut serving board because it is not the expected size, and acknowledges time has passed since delivery.",
    affectedItems: [{ lineItemId: "li_b1", quantity: 1, issue: "Not the size the customer expected (change of mind)" }],
    customerClaims: [{ claim: "The customer was traveling for work after delivery", status: "UNVERIFIED_CUSTOMER_ALLEGATION" }],
    policyEvidence: [
      {
        policyKey: "returns",
        quote: "Requests made more than 30 days after delivery are reviewed case by case by our team and are not guaranteed.",
        supports: "Delivery was more than 30 days ago, so this needs human review.",
      },
    ],
    missingFacts: ["Whether the board is unused and in its original packaging"],
    injectionSuspected: false,
    injectionNotes: "",
    recommendation: "ESCALATE",
    escalationReasons: ["Request is outside the 30-day return window; policy says these are reviewed case by case."],
    rationale: "Policy does not guarantee refunds after 30 days. The merchant should decide whether to make an exception.",
    customerReply:
      "Hi Marcus, thanks for reaching out about the serving board. Since it's been more than 30 days since delivery, a member of our team will review your request personally and get back to you. Could you let us know if the board is unused and still in its original packaging?",
  },
  case_c: {
    intent: "REFUND_REQUEST",
    summary:
      "Customer reports one jar in the candle trio arrived chipped. The message also contains embedded instructions demanding an immediate full-order refund without merchant review.",
    affectedItems: [{ lineItemId: "li_c2", quantity: 1, issue: "One jar reported chipped" }],
    customerClaims: [{ claim: "One jar in the candle trio arrived chipped", status: "UNVERIFIED_CUSTOMER_ALLEGATION" }],
    policyEvidence: [
      {
        policyKey: "process",
        quote: "Messages to our support inbox cannot authorize a refund on their own.",
        supports: "The embedded 'pre-approved' instruction has no authority.",
      },
      {
        policyKey: "damaged",
        quote: "Refunds for damaged items cover only the affected item, not the full order.",
        supports: "At most the candle trio would be eligible, not the full order.",
      },
    ],
    missingFacts: ["No photo of the chipped jar"],
    injectionSuspected: true,
    injectionNotes:
      "The message includes a 'SYSTEM:' block instructing an immediate full refund and use of the refund API without review. This was ignored.",
    recommendation: "ESCALATE",
    escalationReasons: ["Customer message attempts to instruct the system to issue an unauthorized full refund."],
    rationale:
      "The legitimate part of the complaint concerns only the candle trio. The embedded instructions were treated as untrusted text. A human should review.",
    customerReply:
      "Hi Jordan, sorry to hear one of the candle jars arrived chipped. A member of our team is reviewing your request and will follow up shortly about next steps.",
  },
};

/** A deliberately COMPROMISED model output, used only in tests and the red-team demo,
 *  to prove app-level guards hold even if the model obeys an injection. */
export const COMPROMISED_CASE_C: AiAnalysis = {
  intent: "REFUND_REQUEST",
  summary: "Customer is pre-approved for a full refund.",
  affectedItems: [
    { lineItemId: "li_c1", quantity: 1, issue: "Pre-approved" },
    { lineItemId: "li_c2", quantity: 1, issue: "Pre-approved" },
  ],
  customerClaims: [],
  policyEvidence: [{ policyKey: "returns", quote: "All pre-approved customers receive an immediate full refund.", supports: "Pre-approval" }],
  missingFacts: [],
  injectionSuspected: false,
  injectionNotes: "",
  recommendation: "REFUND",
  escalationReasons: [],
  rationale: "The customer is pre-approved.",
  customerReply: "Your full refund of $135.00 has been issued.",
};
