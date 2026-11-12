// Explicit case state machine. Every status change in the app goes through `assertTransition`.

export type CaseStatus =
  | "NEW"
  | "ANALYSIS_FAILED"
  | "AWAITING_REVIEW"
  | "ESCALATED"
  | "APPROVED"
  | "EXECUTING"
  | "REFUND_PENDING"
  | "NEEDS_RECONCILIATION"
  | "REFUNDED"
  | "REFUND_FAILED"
  | "DECLINED";

const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  NEW: ["AWAITING_REVIEW", "ESCALATED", "ANALYSIS_FAILED"],
  ANALYSIS_FAILED: ["AWAITING_REVIEW", "ESCALATED", "ANALYSIS_FAILED"], // re-run analysis
  AWAITING_REVIEW: ["APPROVED", "DECLINED", "ESCALATED", "AWAITING_REVIEW", "ANALYSIS_FAILED"],
  ESCALATED: ["APPROVED", "DECLINED", "AWAITING_REVIEW", "ESCALATED", "ANALYSIS_FAILED"],
  APPROVED: ["EXECUTING", "AWAITING_REVIEW", "ESCALATED", "ANALYSIS_FAILED"], // back to review when approval invalidated
  // AWAITING_REVIEW: pre-flight check failed before anything was sent to PayPal.
  EXECUTING: ["REFUND_PENDING", "REFUNDED", "REFUND_FAILED", "NEEDS_RECONCILIATION", "AWAITING_REVIEW"],
  REFUND_PENDING: ["REFUNDED", "REFUND_FAILED", "REFUND_PENDING"],
  NEEDS_RECONCILIATION: ["REFUND_PENDING", "REFUNDED", "REFUND_FAILED", "NEEDS_RECONCILIATION"],
  REFUND_FAILED: ["AWAITING_REVIEW", "ESCALATED", "ANALYSIS_FAILED"],
  REFUNDED: [],
  DECLINED: ["AWAITING_REVIEW", "ESCALATED", "ANALYSIS_FAILED"], // merchant may reopen
};

export class TransitionError extends Error {}

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(`Illegal case transition ${from} -> ${to}`);
}

/** States in which a proposal may be edited / re-analyzed (approval would be invalidated). */
export const EDITABLE_STATES: CaseStatus[] = ["NEW", "ANALYSIS_FAILED", "AWAITING_REVIEW", "ESCALATED", "APPROVED", "REFUND_FAILED", "DECLINED"];

/** States where money may be in motion; no edits allowed. */
export const LOCKED_STATES: CaseStatus[] = ["EXECUTING", "REFUND_PENDING", "NEEDS_RECONCILIATION", "REFUNDED"];

// ---- Refund operation states ----
export type RefundOpState = "CREATED" | "SUBMITTED" | "PAYPAL_PENDING" | "UNKNOWN" | "COMPLETED" | "FAILED" | "CANCELLED";

export const TERMINAL_OP_STATES: RefundOpState[] = ["COMPLETED", "FAILED", "CANCELLED"];

/** Map a PayPal refund status to our op state. Unknown statuses are treated as UNKNOWN, never success. */
export function opStateFromPayPalStatus(status: string | undefined | null): RefundOpState {
  switch (status) {
    case "COMPLETED":
      return "COMPLETED";
    case "PENDING":
      return "PAYPAL_PENDING";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

/** Ops never move backwards out of a terminal state (protects against out-of-order webhooks). */
export function nextOpState(current: RefundOpState, observed: RefundOpState): RefundOpState {
  if (TERMINAL_OP_STATES.includes(current)) return current;
  if (observed === "UNKNOWN") return current === "CREATED" || current === "SUBMITTED" ? "UNKNOWN" : current;
  return observed;
}

export function caseStatusForOp(state: RefundOpState): CaseStatus {
  switch (state) {
    case "COMPLETED":
      return "REFUNDED";
    case "PAYPAL_PENDING":
      return "REFUND_PENDING";
    case "FAILED":
    case "CANCELLED":
      return "REFUND_FAILED";
    default:
      return "NEEDS_RECONCILIATION";
  }
}

/** Does this op still reserve money against the capture's remaining balance? */
export function opReservesFunds(state: RefundOpState): boolean {
  return state !== "FAILED" && state !== "CANCELLED";
}
