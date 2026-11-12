// Pure approval-binding checks used both at approval time and immediately before execution.
import { approvalFingerprint } from "./proposal";

export interface ApprovalRecord {
  proposalId: string;
  proposalVersion: number;
  captureId: string;
  currency: string;
  amountCents: number;
  fingerprint: string;
  invalidatedAt: Date | null;
}

export interface CurrentState {
  caseId: string;
  latestProposal: {
    id: string;
    version: number;
    action: "REFUND" | "DECLINE" | "ESCALATE";
    amountCents: number;
    currency: string;
    supersededAt: Date | null;
  } | null;
  payment: { captureId: string; currency: string } | null;
}

export type BindingResult = { ok: true } | { ok: false; reason: string };

export function checkApprovalBinding(approval: ApprovalRecord, current: CurrentState): BindingResult {
  if (approval.invalidatedAt) return { ok: false, reason: "Approval was invalidated" };
  const p = current.latestProposal;
  if (!p) return { ok: false, reason: "No current proposal" };
  if (p.supersededAt) return { ok: false, reason: "Proposal has been superseded" };
  if (p.action !== "REFUND") return { ok: false, reason: `Current proposal action is ${p.action}, not REFUND` };
  if (!current.payment) return { ok: false, reason: "Order has no verified payment" };
  if (p.id !== approval.proposalId) return { ok: false, reason: "Approval is for a different proposal" };
  if (p.version !== approval.proposalVersion) return { ok: false, reason: "Proposal version changed" };
  if (p.amountCents !== approval.amountCents) return { ok: false, reason: "Proposal amount changed" };
  if (p.currency !== approval.currency || current.payment.currency !== approval.currency) {
    return { ok: false, reason: "Currency changed" };
  }
  if (current.payment.captureId !== approval.captureId) return { ok: false, reason: "Capture ID changed" };
  const expected = approvalFingerprint({
    caseId: current.caseId,
    captureId: current.payment.captureId,
    currency: p.currency,
    amountCents: p.amountCents,
    proposalId: p.id,
    proposalVersion: p.version,
  });
  if (expected !== approval.fingerprint) return { ok: false, reason: "Approval fingerprint mismatch" };
  return { ok: true };
}
