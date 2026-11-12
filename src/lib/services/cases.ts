// Case lifecycle: analysis -> proposal -> approval -> execution -> reconciliation.
// Pure-ish: all I/O comes through `deps` so tests can inject a database and a payments adapter.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { decide, parseModelOutput, type ParseResult, type TrustedPolicy } from "../ai/guards";
import { checkApprovalBinding } from "../approval";
import { assertCurrency, formatUSD } from "../money";
import { approvalFingerprint, priceSelection, proposalContentFingerprint, remainingRefundableCents, type SelectedItem } from "../proposal";
import {
  assertTransition,
  caseStatusForOp,
  LOCKED_STATES,
  nextOpState,
  opReservesFunds,
  opStateFromPayPalStatus,
  TERMINAL_OP_STATES,
  type CaseStatus,
  type RefundOpState,
} from "../stateMachine";
import { PaymentsError, type PaymentsAdapter, type RefundInfo } from "../paypal/types";

export interface Deps {
  db: PrismaClient;
  payments: PaymentsAdapter;
  now: () => Date;
  returnWindowDays: number;
  runModel: (args: { caseId: string; complaint: string }) => Promise<{ source: string; raw: unknown; error?: string }>;
}

export class ServiceError extends Error {
  constructor(message: string, public readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID" | "FORBIDDEN" = "INVALID") {
    super(message);
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

async function audit(db: Db, caseId: string | null, type: string, actor: string, data: Record<string, unknown>) {
  await db.auditEvent.create({ data: { caseId, type, actor, data: data as Prisma.InputJsonValue } });
}

async function setStatus(db: Db, caseId: string, from: CaseStatus, to: CaseStatus) {
  assertTransition(from, to);
  // Conditional update guards against concurrent writers.
  const res = await db.case.updateMany({ where: { id: caseId, status: from }, data: { status: to } });
  if (res.count !== 1) throw new ServiceError(`Case ${caseId} is no longer ${from}`, "CONFLICT");
}

async function invalidateApprovals(db: Db, caseId: string, reason: string, actor: string) {
  const res = await db.approval.updateMany({
    where: { caseId, invalidatedAt: null, refundOp: { is: null } },
    data: { invalidatedAt: new Date(), invalidReason: reason },
  });
  if (res.count > 0) await audit(db, caseId, "approval.invalidated", actor, { reason, count: res.count });
}

/** Funds already refunded or possibly in flight against a capture, from our durable records. */
export async function reservedCentsForCapture(db: Db, captureId: string, excludeOpId?: string): Promise<number[]> {
  const ops = await db.refundOperation.findMany({ where: { captureId } });
  return ops.filter((o) => o.id !== excludeOpId && opReservesFunds(o.state as RefundOpState)).map((o) => o.amountCents);
}

export async function remainingForOrder(db: Db, orderId: string): Promise<number | null> {
  const link = await db.paymentLink.findUnique({ where: { orderId } });
  if (!link) return null;
  return remainingRefundableCents(link.capturedCents, await reservedCentsForCapture(db, link.captureId));
}

export async function loadCase(db: Db, caseId: string) {
  const c = await db.case.findUnique({
    where: { id: caseId },
    include: {
      order: { include: { lineItems: true, payment: true } },
      merchant: { include: { policies: true } },
      proposals: { orderBy: { version: "desc" } },
    },
  });
  if (!c) throw new ServiceError("Case not found", "NOT_FOUND");
  return c;
}

// ---------------------------------------------------------------- analysis

export async function analyzeCase(deps: Deps, caseId: string, actor = "merchant") {
  const c = await loadCase(deps.db, caseId);
  if (LOCKED_STATES.includes(c.status as CaseStatus)) throw new ServiceError(`Cannot re-analyze a case in ${c.status}`, "CONFLICT");

  const model = await deps.runModel({ caseId, complaint: c.complaint });
  const parse: ParseResult = model.error ? { ok: false, errors: [model.error] } : parseModelOutput(model.raw);
  const policies: TrustedPolicy[] = c.merchant.policies.map((p) => ({ key: p.key, title: p.title, text: p.text }));
  const remaining = await remainingForOrder(deps.db, c.orderId);
  const decision = decide({
    parse,
    orderItems: c.order.lineItems,
    policies,
    complaint: c.complaint,
    deliveredAt: c.order.deliveredAt,
    now: deps.now(),
    returnWindowDays: deps.returnWindowDays,
    remainingRefundableCents: remaining,
  });

  return deps.db.$transaction(async (tx) => {
    const fresh = await tx.case.findUniqueOrThrow({ where: { id: caseId } });
    const analysis = await tx.analysis.create({
      data: {
        caseId,
        source: model.source,
        raw: (model.raw ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        parsed: parse.ok ? (parse.analysis as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        valid: parse.ok,
        errors: (parse.ok ? [] : parse.errors) as Prisma.InputJsonValue,
      },
    });
    await audit(tx, caseId, "ai.analysis", "ai", {
      source: model.source,
      valid: parse.ok,
      errors: parse.ok ? [] : parse.errors,
      recommendation: parse.ok ? parse.analysis.recommendation : null,
      injectionSignals: decision.injectionSignals.length,
    });
    if (!parse.ok) {
      await supersedeAndInvalidate(tx, caseId, "Re-analysis failed validation", actor);
      await setStatus(tx, caseId, fresh.status as CaseStatus, "ANALYSIS_FAILED");
      return { analysisId: analysis.id, proposal: null, decision };
    }
    const proposal = await createProposal(tx, {
      caseId,
      analysisId: analysis.id,
      source: "AI",
      action: decision.action,
      items: decision.items,
      amountCents: decision.amountCents,
      captureId: c.order.payment?.captureId ?? null,
      reasons: decision.reasons,
      evidence: decision.evidence,
      actor,
    });
    const to: CaseStatus = decision.action === "ESCALATE" ? "ESCALATED" : "AWAITING_REVIEW";
    await setStatus(tx, caseId, fresh.status as CaseStatus, to);
    return { analysisId: analysis.id, proposal, decision };
  });
}

async function supersedeAndInvalidate(tx: Db, caseId: string, reason: string, actor: string) {
  await tx.proposal.updateMany({ where: { caseId, supersededAt: null }, data: { supersededAt: new Date() } });
  await invalidateApprovals(tx, caseId, reason, actor);
}

async function createProposal(
  tx: Db,
  p: {
    caseId: string;
    analysisId: string | null;
    source: "AI" | "MERCHANT";
    action: "REFUND" | "DECLINE" | "ESCALATE";
    items: SelectedItem[];
    amountCents: number;
    captureId: string | null;
    reasons: string[];
    evidence?: unknown;
    actor: string;
  },
) {
  const last = await tx.proposal.findFirst({ where: { caseId: p.caseId }, orderBy: { version: "desc" } });
  const version = (last?.version ?? 0) + 1;
  await supersedeAndInvalidate(tx, p.caseId, `Proposal replaced by version ${version}`, p.actor);
  const fingerprint = proposalContentFingerprint({ ...p, version, currency: "USD" });
  const proposal = await tx.proposal.create({
    data: {
      caseId: p.caseId,
      version,
      analysisId: p.analysisId,
      source: p.source,
      action: p.action,
      items: p.items as unknown as Prisma.InputJsonValue,
      amountCents: p.amountCents,
      currency: "USD",
      captureId: p.captureId,
      reasons: { reasons: p.reasons, evidence: p.evidence ?? [] } as Prisma.InputJsonValue,
      fingerprint,
    },
  });
  await audit(tx, p.caseId, "proposal.created", p.source === "AI" ? "system" : p.actor, {
    version,
    source: p.source,
    action: p.action,
    amountCents: p.amountCents,
    items: p.items,
    reasons: p.reasons,
  });
  return proposal;
}

// ---------------------------------------------------------------- merchant revision

export async function reviseProposal(
  deps: Deps,
  caseId: string,
  input: { action: "REFUND" | "ESCALATE"; items: SelectedItem[]; note?: string },
  actor = "merchant",
) {
  const c = await loadCase(deps.db, caseId);
  if (LOCKED_STATES.includes(c.status as CaseStatus)) throw new ServiceError(`Cannot revise a case in ${c.status}`, "CONFLICT");
  const priced = priceSelection(c.order.lineItems, input.items); // throws on unknown items / bad qty
  const remaining = await remainingForOrder(deps.db, c.orderId);
  if (input.action === "REFUND") {
    if (priced.amountCents <= 0) throw new ServiceError("Refund proposal must include at least one item");
    if (remaining !== null && priced.amountCents > remaining) {
      throw new ServiceError(`Amount ${formatUSD(priced.amountCents)} exceeds remaining refundable ${formatUSD(remaining)}`);
    }
  }
  return deps.db.$transaction(async (tx) => {
    const fresh = await tx.case.findUniqueOrThrow({ where: { id: caseId } });
    const proposal = await createProposal(tx, {
      caseId,
      analysisId: null,
      source: "MERCHANT",
      action: input.action,
      items: priced.lines.map(({ lineItemId, quantity }) => ({ lineItemId, quantity })),
      amountCents: priced.amountCents,
      captureId: c.order.payment?.captureId ?? null,
      reasons: input.note ? [`Merchant note: ${input.note}`] : ["Merchant-edited proposal"],
      actor,
    });
    const to: CaseStatus = input.action === "ESCALATE" ? "ESCALATED" : "AWAITING_REVIEW";
    await setStatus(tx, caseId, fresh.status as CaseStatus, to);
    return proposal;
  });
}

export async function declineCase(deps: Deps, caseId: string, note: string, actor = "merchant") {
  return deps.db.$transaction(async (tx) => {
    const c = await tx.case.findUniqueOrThrow({ where: { id: caseId } });
    await invalidateApprovals(tx, caseId, "Case declined", actor);
    await setStatus(tx, caseId, c.status as CaseStatus, "DECLINED");
    await audit(tx, caseId, "case.declined", actor, { note: note.slice(0, 500) });
  });
}

// ---------------------------------------------------------------- approval

export async function approveProposal(
  deps: Deps,
  caseId: string,
  input: { proposalId: string; proposalVersion: number; amountCents: number },
  actor: string,
) {
  return deps.db.$transaction(
    async (tx) => {
      const c = await tx.case.findUnique({ where: { id: caseId }, include: { order: { include: { payment: true } } } });
      if (!c) throw new ServiceError("Case not found", "NOT_FOUND");
      if (c.status !== "AWAITING_REVIEW" && c.status !== "ESCALATED") {
        throw new ServiceError(`Case is ${c.status}; only cases awaiting review can be approved`, "CONFLICT");
      }
      const latest = await tx.proposal.findFirst({ where: { caseId }, orderBy: { version: "desc" } });
      if (!latest || latest.id !== input.proposalId || latest.version !== input.proposalVersion || latest.supersededAt) {
        throw new ServiceError("The proposal you approved is no longer current. Reload and review again.", "CONFLICT");
      }
      if (latest.amountCents !== input.amountCents) throw new ServiceError("Amount on screen does not match the proposal", "CONFLICT");
      if (latest.action !== "REFUND") {
        throw new ServiceError("Only REFUND proposals can be approved. Edit the proposal to create a refund proposal first.");
      }
      if (latest.amountCents <= 0) throw new ServiceError("Refund amount must be positive");
      const link = c.order.payment;
      if (!link) throw new ServiceError("No verified PayPal capture is linked to this order. Use Demo Setup first.");
      if (link.mode !== deps.payments.mode) {
        throw new ServiceError(`Linked capture is ${link.mode} but app is running in ${deps.payments.mode} mode`);
      }
      assertCurrency(link.currency);
      assertCurrency(latest.currency);
      const remaining = remainingRefundableCents(link.capturedCents, await reservedCentsForCapture(tx, link.captureId));
      if (latest.amountCents > remaining) {
        throw new ServiceError(`Amount ${formatUSD(latest.amountCents)} exceeds remaining refundable ${formatUSD(remaining)}`);
      }
      await invalidateApprovals(tx, caseId, "Superseded by a new approval", actor);
      const fingerprint = approvalFingerprint({
        caseId,
        captureId: link.captureId,
        currency: latest.currency,
        amountCents: latest.amountCents,
        proposalId: latest.id,
        proposalVersion: latest.version,
      });
      const approval = await tx.approval.create({
        data: {
          caseId,
          proposalId: latest.id,
          proposalVersion: latest.version,
          captureId: link.captureId,
          currency: latest.currency,
          amountCents: latest.amountCents,
          fingerprint,
          approvedBy: actor,
        },
      });
      await setStatus(tx, caseId, c.status as CaseStatus, "APPROVED");
      await audit(tx, caseId, "approval.granted", actor, {
        approvalId: approval.id,
        proposalVersion: latest.version,
        amountCents: latest.amountCents,
        captureId: link.captureId,
        fingerprint,
      });
      return approval;
    },
    { isolationLevel: "Serializable" },
  );
}

// ---------------------------------------------------------------- execution

export type ExecuteResult = { opId: string; state: RefundOpState; caseStatus: CaseStatus; message: string };

export async function executeRefund(deps: Deps, caseId: string, approvalId: string, actor: string): Promise<ExecuteResult> {
  // Phase 1: claim the case and write a durable operation record BEFORE any network call.
  let op;
  try {
    op = await deps.db.$transaction(
      async (tx) => {
        const c = await tx.case.findUnique({ where: { id: caseId }, include: { order: { include: { payment: true } } } });
        if (!c) throw new ServiceError("Case not found", "NOT_FOUND");
        if (c.status !== "APPROVED") throw new ServiceError(`Case is ${c.status}; refund can only run once from APPROVED`, "CONFLICT");
        const approval = await tx.approval.findUnique({ where: { id: approvalId } });
        if (!approval || approval.caseId !== caseId) throw new ServiceError("Approval not found for this case", "NOT_FOUND");
        const latest = await tx.proposal.findFirst({ where: { caseId }, orderBy: { version: "desc" } });
        const binding = checkApprovalBinding(approval, {
          caseId,
          latestProposal: latest && {
            id: latest.id,
            version: latest.version,
            action: latest.action,
            amountCents: latest.amountCents,
            currency: latest.currency,
            supersededAt: latest.supersededAt,
          },
          payment: c.order.payment && { captureId: c.order.payment.captureId, currency: c.order.payment.currency },
        });
        if (!binding.ok) throw new ServiceError(`Approval is not valid: ${binding.reason}`, "CONFLICT");
        if (c.order.payment!.mode !== deps.payments.mode) throw new ServiceError("Payment mode mismatch", "CONFLICT");

        await setStatus(tx, caseId, "APPROVED", "EXECUTING");
        const id = randomUUID();
        const created = await tx.refundOperation.create({
          data: {
            id,
            caseId,
            approvalId,
            mode: deps.payments.mode,
            captureId: approval.captureId,
            amountCents: approval.amountCents,
            currency: approval.currency,
            paypalRequestId: `resolvepay-refund-${id}`,
            invoiceId: `RP-${id}`,
            activeLock: caseId, // unique: only one non-terminal refund per case
          },
        });
        await audit(tx, caseId, "refund.operation_created", actor, { opId: id, amountCents: approval.amountCents, captureId: approval.captureId });
        return created;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2002" || e.code === "P2034")) {
      throw new ServiceError("A refund is already in progress or was already executed for this case", "CONFLICT");
    }
    throw e;
  }

  // Phase 2: authoritative pre-flight from PayPal (no money moves here).
  try {
    const capture = await deps.payments.getCapture(op.captureId);
    const link = await deps.db.paymentLink.findUniqueOrThrow({ where: { captureId: op.captureId } });
    const problems: string[] = [];
    if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(capture.status)) problems.push(`capture status is ${capture.status}`);
    if (capture.currency !== op.currency) problems.push(`capture currency ${capture.currency} != ${op.currency}`);
    if (capture.amountCents !== link.capturedCents) problems.push("captured amount differs from the verified link");
    const remaining = remainingRefundableCents(capture.amountCents, await reservedCentsForCapture(deps.db, op.captureId, op.id));
    if (op.amountCents > remaining) problems.push(`amount exceeds remaining refundable (${formatUSD(remaining)})`);
    if (problems.length) return await abortBeforeSubmit(deps, op.id, caseId, `Pre-flight failed: ${problems.join("; ")}`, actor);
    await audit(deps.db, caseId, "refund.preflight_ok", "system", { captureStatus: capture.status, remainingCents: remaining });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return await abortBeforeSubmit(deps, op.id, caseId, `Pre-flight could not fetch capture: ${msg}`, actor);
  }

  // Phase 3: mark SUBMITTED durably, then call PayPal exactly once.
  await deps.db.refundOperation.update({ where: { id: op.id }, data: { state: "SUBMITTED", attempts: { increment: 1 } } });
  return submitAndRecord(deps, op.id, actor, "refund.submitted");
}

async function abortBeforeSubmit(deps: Deps, opId: string, caseId: string, reason: string, actor: string): Promise<ExecuteResult> {
  await deps.db.$transaction(async (tx) => {
    await tx.refundOperation.update({ where: { id: opId }, data: { state: "CANCELLED", activeLock: null, lastError: reason } });
    await tx.approval.updateMany({ where: { refundOp: { is: { id: opId } } }, data: { invalidatedAt: new Date(), invalidReason: reason } });
    await setStatus(tx, caseId, "EXECUTING", "AWAITING_REVIEW");
    await audit(tx, caseId, "refund.aborted_before_submit", "system", { opId, reason, by: actor });
  });
  return { opId, state: "CANCELLED", caseStatus: "AWAITING_REVIEW", message: `${reason}. Nothing was sent to PayPal; re-approve to try again.` };
}

/** Send (or replay, with the SAME PayPal-Request-Id) the refund and record the outcome. */
async function submitAndRecord(deps: Deps, opId: string, actor: string, auditType: string): Promise<ExecuteResult> {
  const op = await deps.db.refundOperation.findUniqueOrThrow({ where: { id: opId } });
  let refund: RefundInfo | null = null;
  let failure: { kind: "DEFINITE" | "AMBIGUOUS"; message: string } | null = null;
  try {
    refund = await deps.payments.refundCapture({
      captureId: op.captureId,
      amountCents: op.amountCents,
      currency: op.currency,
      requestId: op.paypalRequestId,
      invoiceId: op.invoiceId,
      customId: op.caseId,
      noteToPayer: "Refund approved by the merchant via ResolvePay.",
    });
  } catch (e) {
    // Anything that isn't a clear PayPal rejection (including unparsable success bodies) is AMBIGUOUS.
    failure = e instanceof PaymentsError ? { kind: e.kind, message: e.message } : { kind: "AMBIGUOUS", message: `Unexpected error: ${e instanceof Error ? e.message : e}` };
  }

  if (refund && (refund.amountCents !== null && refund.amountCents !== op.amountCents)) {
    failure = { kind: "AMBIGUOUS", message: `PayPal reported refund amount ${refund.amountCents} != requested ${op.amountCents}` };
  }

  let observed: RefundOpState;
  if (refund && !failure) observed = opStateFromPayPalStatus(refund.status);
  // A 4xx is only trusted as "nothing happened" on the very first attempt. On a replay after an
  // ambiguous outcome, the first attempt may have succeeded, so we stay UNKNOWN for human review.
  else if (failure?.kind === "DEFINITE" && !op.paypalRefundId && op.state === "SUBMITTED" && op.attempts === 1) observed = "FAILED";
  else observed = "UNKNOWN";

  return applyObservedState(deps, opId, observed, {
    paypalRefundId: refund?.id,
    paypalStatus: refund?.status,
    error: failure?.message,
    actor,
    auditType,
  });
}

async function applyObservedState(
  deps: Deps,
  opId: string,
  observed: RefundOpState,
  info: { paypalRefundId?: string; paypalStatus?: string; error?: string; actor: string; auditType: string },
): Promise<ExecuteResult> {
  return deps.db.$transaction(async (tx) => {
    const op = await tx.refundOperation.findUniqueOrThrow({ where: { id: opId }, include: { case: true } });
    const next = nextOpState(op.state as RefundOpState, observed);
    const terminal = TERMINAL_OP_STATES.includes(next);
    if (info.paypalRefundId && op.paypalRefundId && op.paypalRefundId !== info.paypalRefundId) {
      throw new ServiceError("PayPal returned a different refund id for the same operation", "CONFLICT");
    }
    await tx.refundOperation.update({
      where: { id: opId },
      data: {
        state: next,
        paypalRefundId: info.paypalRefundId ?? op.paypalRefundId,
        paypalStatus: info.paypalStatus ?? op.paypalStatus,
        lastError: info.error ?? (next === op.state ? op.lastError : null),
        activeLock: terminal ? null : op.activeLock,
      },
    });
    const from = op.case.status as CaseStatus;
    const to = caseStatusForOp(next);
    if (from !== to && from !== "REFUNDED") await setStatus(tx, op.caseId, from, to);
    await audit(tx, op.caseId, info.auditType, info.actor, {
      opId,
      observed,
      state: next,
      paypalRefundId: info.paypalRefundId ?? op.paypalRefundId,
      paypalStatus: info.paypalStatus ?? null,
      error: info.error ?? null,
    });
    const who = op.mode === "FIXTURE" ? "SIMULATED (fixture)" : "PayPal sandbox";
    const message =
      next === "COMPLETED"
        ? `${who} reports the refund COMPLETED.`
        : next === "PAYPAL_PENDING"
          ? `${who} accepted the refund; status is PENDING. Waiting for reconciliation.`
          : next === "FAILED" || next === "CANCELLED"
            ? `Refund ${next.toLowerCase()}: ${info.error ?? info.paypalStatus ?? ""}`
            : "Outcome uncertain. No new refund will be created; use Reconcile to replay the same idempotent request or wait for the webhook.";
    return { opId, state: next, caseStatus: from === "REFUNDED" ? "REFUNDED" : to, message };
  });
}

// ---------------------------------------------------------------- reconciliation

export async function reconcileOperation(deps: Deps, opId: string, actor: string, auditType = "refund.reconciled"): Promise<ExecuteResult> {
  const op = await deps.db.refundOperation.findUnique({ where: { id: opId }, include: { case: true } });
  if (!op) throw new ServiceError("Refund operation not found", "NOT_FOUND");
  if (TERMINAL_OP_STATES.includes(op.state as RefundOpState)) {
    return { opId, state: op.state as RefundOpState, caseStatus: op.case.status as CaseStatus, message: "Already final; nothing to do." };
  }
  if (op.mode !== deps.payments.mode) throw new ServiceError("Operation belongs to a different payments mode", "CONFLICT");

  if (op.paypalRefundId) {
    try {
      const refund = await deps.payments.getRefund(op.paypalRefundId);
      return applyObservedState(deps, opId, opStateFromPayPalStatus(refund.status), {
        paypalRefundId: refund.id,
        paypalStatus: refund.status,
        actor,
        auditType,
      });
    } catch (e) {
      return applyObservedState(deps, opId, "UNKNOWN", { error: `Could not fetch refund: ${e instanceof Error ? e.message : e}`, actor, auditType });
    }
  }
  // No refund id known: replay the original request with the SAME PayPal-Request-Id.
  // PayPal treats this as the same request, so it cannot create a second refund.
  await deps.db.refundOperation.update({ where: { id: opId }, data: { attempts: { increment: 1 } } });
  return submitAndRecord(deps, opId, actor, "refund.replayed_idempotent");
}

// ---------------------------------------------------------------- payment linking

export async function linkCapture(deps: Deps, orderId: string, captureId: string, actor: string) {
  const id = captureId.trim();
  if (deps.payments.mode === "SANDBOX") {
    if (id.startsWith("FIXTURE-")) throw new ServiceError("Fixture capture IDs cannot be used in sandbox mode");
    if (!/^[A-Z0-9]{10,40}$/.test(id)) throw new ServiceError("That does not look like a PayPal capture ID");
  } else if (!id.startsWith("FIXTURE-CAP-")) {
    throw new ServiceError("Fixture mode only accepts simulated FIXTURE-CAP- IDs");
  }
  const order = await deps.db.order.findUnique({ where: { id: orderId }, include: { cases: true, payment: true } });
  if (!order) throw new ServiceError("Order not found", "NOT_FOUND");
  if (order.cases.some((c) => LOCKED_STATES.includes(c.status as CaseStatus))) {
    throw new ServiceError("A refund is in progress or completed on this order's current capture; it cannot be relinked", "CONFLICT");
  }
  const other = await deps.db.paymentLink.findUnique({ where: { captureId: id } });
  if (other && other.orderId !== orderId) throw new ServiceError("That capture is already linked to another order", "CONFLICT");

  const capture = await deps.payments.getCapture(id); // authoritative
  if (capture.status !== "COMPLETED") throw new ServiceError(`Capture status is ${capture.status}; only fresh COMPLETED captures can be linked`);
  if (capture.currency !== "USD") throw new ServiceError(`Capture currency ${capture.currency} is not USD`);
  if (capture.amountCents !== order.totalCents) {
    throw new ServiceError(`Capture amount ${formatUSD(capture.amountCents)} does not match order total ${formatUSD(order.totalCents)}`);
  }

  return deps.db.$transaction(async (tx) => {
    const link = await tx.paymentLink.upsert({
      where: { orderId },
      create: {
        orderId,
        captureId: id,
        mode: deps.payments.mode,
        currency: capture.currency,
        capturedCents: capture.amountCents,
        captureStatus: capture.status,
        verifiedAt: deps.now(),
        raw: capture.raw as Prisma.InputJsonValue,
      },
      update: {
        captureId: id,
        mode: deps.payments.mode,
        currency: capture.currency,
        capturedCents: capture.amountCents,
        captureStatus: capture.status,
        verifiedAt: deps.now(),
        raw: capture.raw as Prisma.InputJsonValue,
      },
    });
    for (const c of order.cases) {
      if (order.payment && order.payment.captureId !== id) {
        await invalidateApprovals(tx, c.id, "Linked capture changed", actor);
        if (c.status === "APPROVED") await setStatus(tx, c.id, "APPROVED", "AWAITING_REVIEW");
      }
      await audit(tx, c.id, "payment.linked", actor, { captureId: id, mode: deps.payments.mode, amountCents: capture.amountCents });
    }
    return link;
  });
}

// ---------------------------------------------------------------- webhooks

export interface InboundWebhook {
  event: unknown;
  headers: import("../paypal/types").WebhookHeaders;
}

export type WebhookOutcome = { status: 200 | 400; outcome: string };

const RELEVANT_EVENTS = new Set([
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.REFUND.PENDING",
  "PAYMENT.REFUND.FAILED",
  "PAYMENT.REFUND.CANCELLED",
  "PAYMENT.REFUND.COMPLETED",
]);

export async function handlePayPalWebhook(deps: Deps, inbound: InboundWebhook, source: "paypal" | "fixture-simulator" = "paypal"): Promise<WebhookOutcome> {
  const ev = inbound.event as { id?: unknown; event_type?: unknown; resource?: { id?: unknown; invoice_id?: unknown } } | null;
  if (!ev || typeof ev.id !== "string" || typeof ev.event_type !== "string" || !ev.resource || typeof ev.resource !== "object") {
    return { status: 400, outcome: "rejected: malformed event" };
  }

  // Verify signature before trusting anything. Fixture-simulated events skip PayPal verification
  // but are recorded with source=fixture-simulator and never reach this path from HTTP.
  if (source === "paypal") {
    const ok = await deps.payments.verifyWebhookSignature(inbound.headers, inbound.event);
    if (!ok) {
      await audit(deps.db, null, "webhook.rejected", "paypal-webhook", { eventId: ev.id.slice(0, 64), eventType: ev.event_type.slice(0, 64) });
      return { status: 400, outcome: "rejected: signature verification failed" };
    }
  }

  // Deduplicate on PayPal event id (unique index).
  let stored;
  try {
    stored = await deps.db.webhookEvent.create({
      data: {
        paypalEventId: ev.id,
        eventType: ev.event_type,
        verified: source === "paypal",
        source,
        resourceId: typeof ev.resource.id === "string" ? ev.resource.id : null,
        payload: inbound.event as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    const existing = await deps.db.webhookEvent.findUniqueOrThrow({ where: { paypalEventId: ev.id } });
    // Already fully processed: acknowledge. Stored but not processed (earlier crash): process it now.
    if (existing.processedAt) return { status: 200, outcome: "duplicate: already received" };
    stored = existing;
  }

  let outcome = "ignored: event type not relevant";
  if (RELEVANT_EVENTS.has(ev.event_type)) {
    const refundId = typeof ev.resource.id === "string" ? ev.resource.id : null;
    const invoiceId = typeof ev.resource.invoice_id === "string" ? ev.resource.invoice_id : null;
    const op =
      (refundId && (await deps.db.refundOperation.findUnique({ where: { paypalRefundId: refundId } }))) ||
      (invoiceId && (await deps.db.refundOperation.findUnique({ where: { invoiceId } }))) ||
      null;
    if (!op) {
      outcome = "ignored: refund not created by ResolvePay";
    } else {
      // Never trust the event's status or delivery order: fetch the refund's current state from PayPal.
      if (!op.paypalRefundId && refundId) {
        const fetched = await deps.payments.getRefund(refundId).catch(() => null);
        if (fetched && fetched.invoiceId === op.invoiceId) {
          await deps.db.refundOperation.update({ where: { id: op.id }, data: { paypalRefundId: fetched.id } });
        }
      }
      const res = await reconcileOperation(deps, op.id, "paypal-webhook", "refund.reconciled_from_webhook");
      outcome = `reconciled: op ${op.id} -> ${res.state}`;
    }
  }
  await deps.db.webhookEvent.update({ where: { id: stored.id }, data: { outcome, processedAt: new Date() } });
  return { status: 200, outcome };
}
