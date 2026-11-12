// Deterministic proposal calculation. The AI never computes amounts:
// it only names line items; this module prices them from trusted order data.
import { createHash } from "node:crypto";
import { addCents, assertCents, lineTotalCents } from "./money";

export interface TrustedLineItem {
  id: string;
  sku: string;
  name: string;
  unitCents: number;
  quantity: number;
}

export interface SelectedItem {
  lineItemId: string;
  quantity: number;
}

export class ProposalError extends Error {}

/**
 * Validate a selection of line items against the order and price it.
 * Throws if any item is unknown, duplicated, or exceeds ordered quantity.
 */
export function priceSelection(orderItems: TrustedLineItem[], selection: SelectedItem[]): {
  amountCents: number;
  lines: { lineItemId: string; quantity: number; amountCents: number }[];
} {
  const byId = new Map(orderItems.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const lines = selection.map((sel) => {
    const item = byId.get(sel.lineItemId);
    if (!item) throw new ProposalError(`Line item ${sel.lineItemId} does not exist in this order`);
    if (seen.has(sel.lineItemId)) throw new ProposalError(`Line item ${sel.lineItemId} selected twice`);
    seen.add(sel.lineItemId);
    if (!Number.isSafeInteger(sel.quantity) || sel.quantity < 1) {
      throw new ProposalError(`Quantity for ${item.sku} must be a positive integer`);
    }
    if (sel.quantity > item.quantity) {
      throw new ProposalError(`Quantity ${sel.quantity} for ${item.sku} exceeds ordered quantity ${item.quantity}`);
    }
    return { lineItemId: item.id, quantity: sel.quantity, amountCents: lineTotalCents(item.unitCents, sel.quantity) };
  });
  return { amountCents: addCents(...lines.map((l) => l.amountCents)), lines };
}

/** Remaining refundable = captured - (completed + in-flight/uncertain refunds). Never negative. */
export function remainingRefundableCents(capturedCents: number, reservedRefundCents: number[]): number {
  assertCents(capturedCents, "capturedCents");
  const reserved = addCents(...reservedRefundCents);
  return Math.max(0, capturedCents - reserved);
}

export interface FingerprintInput {
  caseId: string;
  captureId: string;
  currency: string;
  amountCents: number;
  proposalId: string;
  proposalVersion: number;
}

/** Hash binding an approval to exactly these fields. Any change produces a different fingerprint. */
export function approvalFingerprint(f: FingerprintInput): string {
  assertCents(f.amountCents);
  const canonical = JSON.stringify([f.caseId, f.captureId, f.currency, f.amountCents, f.proposalId, f.proposalVersion]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Fingerprint of the proposal content itself (used before a proposal id exists). */
export function proposalContentFingerprint(p: {
  caseId: string;
  version: number;
  action: string;
  amountCents: number;
  currency: string;
  captureId: string | null;
  items: SelectedItem[];
}): string {
  const items = [...p.items].sort((a, b) => a.lineItemId.localeCompare(b.lineItemId));
  return createHash("sha256")
    .update(JSON.stringify([p.caseId, p.version, p.action, p.amountCents, p.currency, p.captureId, items]))
    .digest("hex");
}
