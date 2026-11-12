// End-to-end service tests against a real Postgres test database, using the FIXTURE payments
// adapter (simulated PayPal). These prove the app's safety logic, not PayPal connectivity.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { resetAndSeed } from "@/lib/seed";
import { FixturePaymentsAdapter } from "@/lib/paypal/fixture";
import { COMPROMISED_CASE_C, FIXTURE_ANALYSES } from "@/lib/ai/fixtures";
import {
  analyzeCase,
  approveProposal,
  executeRefund,
  handlePayPalWebhook,
  linkCapture,
  reconcileOperation,
  reviseProposal,
  ServiceError,
  type Deps,
} from "@/lib/services/cases";
import type { WebhookHeaders } from "@/lib/paypal/types";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const NOW = new Date("2026-11-07T12:00:00Z");

/** Fixture adapter whose webhook verification accepts only a known test signature. */
class TestPayments extends FixturePaymentsAdapter {
  async verifyWebhookSignature(h: WebhookHeaders): Promise<boolean> {
    return h.transmissionSig === "valid-test-signature";
  }
}

let payments: TestPayments;
let modelOverride: Record<string, unknown> = {};

function deps(): Deps {
  return {
    db,
    payments,
    now: () => NOW,
    returnWindowDays: 30,
    runModel: async ({ caseId }) => ({ source: "fixture", raw: structuredClone(modelOverride[caseId] ?? FIXTURE_ANALYSES[caseId]) }),
  };
}

async function linkFixtureCapture(orderId: string) {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const captureId = await payments.createCapture(order.totalCents);
  await linkCapture(deps(), orderId, captureId, "merchant");
  return captureId;
}

async function approveLatest(caseId: string) {
  const p = await db.proposal.findFirstOrThrow({ where: { caseId }, orderBy: { version: "desc" } });
  return approveProposal(deps(), caseId, { proposalId: p.id, proposalVersion: p.version, amountCents: p.amountCents }, "merchant");
}

const validHeaders: WebhookHeaders = { transmissionId: "t", transmissionTime: "now", certUrl: "u", authAlgo: "a", transmissionSig: "valid-test-signature" };

beforeEach(async () => {
  await resetAndSeed(db, NOW);
  payments = new TestPayments(db);
  modelOverride = {};
});
afterAll(() => db.$disconnect());

describe("Case A: damaged item, partial refund (fixture payments)", () => {
  it("runs complaint -> analysis -> approval -> refund -> audit", async () => {
    const captureId = await linkFixtureCapture("order_a");
    const { proposal } = await analyzeCase(deps(), "case_a");
    expect(proposal).toMatchObject({ action: "REFUND", amountCents: 4800, captureId });
    expect((await db.case.findUniqueOrThrow({ where: { id: "case_a" } })).status).toBe("AWAITING_REVIEW");

    const approval = await approveLatest("case_a");
    const res = await executeRefund(deps(), "case_a", approval.id, "merchant");
    expect(res).toMatchObject({ state: "COMPLETED", caseStatus: "REFUNDED" });

    const cap = await db.fixtureCapture.findUniqueOrThrow({ where: { id: captureId }, include: { refunds: true } });
    expect(cap.status).toBe("PARTIALLY_REFUNDED");
    expect(cap.refunds.map((r) => r.amountCents)).toEqual([4800]);

    const types = (await db.auditEvent.findMany({ where: { caseId: "case_a" }, orderBy: { createdAt: "asc" } })).map((a) => a.type);
    expect(types).toEqual(
      expect.arrayContaining(["ai.analysis", "proposal.created", "approval.granted", "refund.operation_created", "refund.preflight_ok", "refund.submitted"]),
    );
  });
});

describe("approval safety", () => {
  it("rejects approving a stale proposal version or a mismatched amount", async () => {
    await linkFixtureCapture("order_a");
    await analyzeCase(deps(), "case_a");
    const p = await db.proposal.findFirstOrThrow({ where: { caseId: "case_a" } });
    await expect(approveProposal(deps(), "case_a", { proposalId: p.id, proposalVersion: p.version, amountCents: 8000 }, "m")).rejects.toThrow(/does not match/);
    await reviseProposal(deps(), "case_a", { action: "REFUND", items: [{ lineItemId: "li_a1", quantity: 1 }] });
    await expect(approveProposal(deps(), "case_a", { proposalId: p.id, proposalVersion: p.version, amountCents: p.amountCents }, "m")).rejects.toThrow(
      /no longer current/,
    );
  });

  it("invalidates an approval when the proposal changes after approval", async () => {
    await linkFixtureCapture("order_a");
    await analyzeCase(deps(), "case_a");
    const approval = await approveLatest("case_a");
    await reviseProposal(deps(), "case_a", { action: "REFUND", items: [{ lineItemId: "li_a1", quantity: 1 }, { lineItemId: "li_a2", quantity: 1 }] });
    const reloaded = await db.approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(reloaded.invalidatedAt).not.toBeNull();
    await expect(executeRefund(deps(), "case_a", approval.id, "m")).rejects.toThrow(/APPROVED|not valid/);
    expect(await db.fixtureRefund.count()).toBe(0);
  });

  it("invalidates approval when the linked capture changes", async () => {
    await linkFixtureCapture("order_a");
    await analyzeCase(deps(), "case_a");
    const approval = await approveLatest("case_a");
    await linkFixtureCapture("order_a"); // relink to a different capture
    expect((await db.case.findUniqueOrThrow({ where: { id: "case_a" } })).status).toBe("AWAITING_REVIEW");
    await expect(executeRefund(deps(), "case_a", approval.id, "m")).rejects.toThrow(ServiceError);
  });

  it("cannot approve without a verified capture, and cannot execute without an approval", async () => {
    await analyzeCase(deps(), "case_a");
    await expect(approveLatest("case_a")).rejects.toThrow(/No verified PayPal capture/);
    await expect(executeRefund(deps(), "case_a", "made-up-approval", "m")).rejects.toThrow(ServiceError);
  });

  it("rejects a capture whose amount does not match the order", async () => {
    const wrong = await payments.createCapture(100);
    await expect(linkCapture(deps(), "order_a", wrong, "m")).rejects.toThrow(/does not match order total/);
    await expect(linkCapture(deps(), "order_a", "8AB12345CD678901E", "m")).rejects.toThrow(/Fixture mode only/);
  });
});

describe("Case B: outside return window", () => {
  it("is escalated and cannot be approved until a merchant creates a refund proposal", async () => {
    await linkFixtureCapture("order_b");
    const { proposal } = await analyzeCase(deps(), "case_b");
    expect(proposal?.action).toBe("ESCALATE");
    expect((await db.case.findUniqueOrThrow({ where: { id: "case_b" } })).status).toBe("ESCALATED");
    await expect(approveLatest("case_b")).rejects.toThrow(/Only REFUND proposals/);
    // Human makes an explicit exception:
    await reviseProposal(deps(), "case_b", { action: "REFUND", items: [{ lineItemId: "li_b1", quantity: 1 }], note: "Goodwill exception" });
    const approval = await approveLatest("case_b");
    expect(approval.amountCents).toBe(6500);
  });
});

describe("Case C: prompt injection cannot bypass approval or amount limits", () => {
  it("with a compromised model, the case is escalated and the attacker's $135 is never proposed", async () => {
    await linkFixtureCapture("order_c");
    modelOverride.case_c = COMPROMISED_CASE_C;
    const { proposal } = await analyzeCase(deps(), "case_c");
    expect(proposal?.action).toBe("ESCALATE");
    expect(proposal!.amountCents).toBeLessThan(13500);
    await expect(approveLatest("case_c")).rejects.toThrow(/Only REFUND proposals/);
    expect(await db.refundOperation.count()).toBe(0);
    expect(await db.fixtureRefund.count()).toBe(0);
  });

  it("a merchant cannot propose more than the remaining refundable amount", async () => {
    await linkFixtureCapture("order_c");
    await analyzeCase(deps(), "case_c");
    await reviseProposal(deps(), "case_c", { action: "REFUND", items: [{ lineItemId: "li_c2", quantity: 1 }] });
    await executeRefund(deps(), "case_c", (await approveLatest("case_c")).id, "m");
    // Re-open a separate case on the same order trying to refund everything again:
    await db.case.create({ data: { id: "case_c2", merchantId: "merchant_demo", orderId: "order_c", complaint: "refund all" } });
    await expect(
      reviseProposal(deps(), "case_c2", { action: "REFUND", items: [{ lineItemId: "li_c1", quantity: 1 }, { lineItemId: "li_c2", quantity: 1 }] }),
    ).rejects.toThrow(/exceeds remaining refundable/);
  });
});

describe("malformed model output", () => {
  it("records a failed analysis and does not create a proposal", async () => {
    modelOverride.case_a = { recommendation: "REFUND", refundAmount: 99999 };
    const res = await analyzeCase(deps(), "case_a");
    expect(res.proposal).toBeNull();
    expect((await db.case.findUniqueOrThrow({ where: { id: "case_a" } })).status).toBe("ANALYSIS_FAILED");
    expect((await db.analysis.findFirstOrThrow({ where: { caseId: "case_a" } })).valid).toBe(false);
  });
});

describe("duplicate execution requests", () => {
  it("concurrent executes produce exactly one refund", async () => {
    await linkFixtureCapture("order_a");
    await analyzeCase(deps(), "case_a");
    const approval = await approveLatest("case_a");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => executeRefund(deps(), "case_a", approval.id, "m")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.refundOperation.count()).toBe(1);
    expect(await db.fixtureRefund.count()).toBe(1);
  });

  it("a second execute after completion is rejected", async () => {
    await linkFixtureCapture("order_a");
    await analyzeCase(deps(), "case_a");
    const approval = await approveLatest("case_a");
    await executeRefund(deps(), "case_a", approval.id, "m");
    await expect(executeRefund(deps(), "case_a", approval.id, "m")).rejects.toThrow(/REFUNDED/);
    expect(await db.fixtureRefund.count()).toBe(1);
  });
});

describe("ambiguous network failures", () => {
  async function approvedCaseA() {
    await linkFixtureCapture("order_a");
    await analyzeCase(deps(), "case_a");
    return approveLatest("case_a");
  }

  it("timeout AFTER PayPal processed: marked uncertain, reconcile replays same request id, still one refund", async () => {
    const approval = await approvedCaseA();
    payments.nextFault = "timeout_after_commit";
    const res = await executeRefund(deps(), "case_a", approval.id, "m");
    expect(res).toMatchObject({ state: "UNKNOWN", caseStatus: "NEEDS_RECONCILIATION" });
    expect(await db.fixtureRefund.count()).toBe(1); // money moved, we just didn't hear back

    // A second execute is refused while uncertain: no blind retry with a new refund.
    await expect(executeRefund(deps(), "case_a", approval.id, "m")).rejects.toThrow(ServiceError);

    const op = await db.refundOperation.findFirstOrThrow();
    const rec = await reconcileOperation(deps(), op.id, "m");
    expect(rec).toMatchObject({ state: "COMPLETED", caseStatus: "REFUNDED" });
    expect(await db.fixtureRefund.count()).toBe(1);
    const after = await db.refundOperation.findFirstOrThrow();
    expect(after.paypalRequestId).toBe(op.paypalRequestId);
    expect(after.attempts).toBe(2);
    expect(after.activeLock).toBeNull();
  });

  it("timeout BEFORE PayPal received it: reconcile creates the refund exactly once", async () => {
    const approval = await approvedCaseA();
    payments.nextFault = "timeout_before_commit";
    expect((await executeRefund(deps(), "case_a", approval.id, "m")).state).toBe("UNKNOWN");
    expect(await db.fixtureRefund.count()).toBe(0);
    const op = await db.refundOperation.findFirstOrThrow();
    await reconcileOperation(deps(), op.id, "m");
    await reconcileOperation(deps(), op.id, "m");
    expect(await db.fixtureRefund.count()).toBe(1);
  });

  it("5xx is treated as uncertain, not as failure", async () => {
    const approval = await approvedCaseA();
    payments.nextFault = "server_error";
    expect((await executeRefund(deps(), "case_a", approval.id, "m")).state).toBe("UNKNOWN");
  });

  it("pre-flight failure sends nothing and returns the case to review", async () => {
    const approval = await approvedCaseA();
    const link = await db.paymentLink.findUniqueOrThrow({ where: { orderId: "order_a" } });
    await db.fixtureCapture.update({ where: { id: link.captureId }, data: { status: "REFUNDED" } }); // refunded elsewhere
    const res = await executeRefund(deps(), "case_a", approval.id, "m");
    expect(res).toMatchObject({ state: "CANCELLED", caseStatus: "AWAITING_REVIEW" });
    expect(await db.fixtureRefund.count()).toBe(0);
    expect((await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).invalidatedAt).not.toBeNull();
  });
});

describe("webhooks", () => {
  async function pendingRefund() {
    await linkFixtureCapture("order_a");
    await analyzeCase(deps(), "case_a");
    payments.nextFault = "pending";
    await executeRefund(deps(), "case_a", (await approveLatest("case_a")).id, "m");
    return db.refundOperation.findFirstOrThrow();
  }
  const event = (id: string, type: string, refundId: string, status: string) => ({
    id,
    event_type: type,
    resource: { id: refundId, status },
  });

  it("rejects events whose signature fails verification and stores nothing", async () => {
    const op = await pendingRefund();
    await payments.settlePending(op.paypalRefundId!, "COMPLETED");
    const res = await handlePayPalWebhook(deps(), { event: event("WH-1", "PAYMENT.CAPTURE.REFUNDED", op.paypalRefundId!, "COMPLETED"), headers: { ...validHeaders, transmissionSig: "forged" } });
    expect(res.status).toBe(400);
    expect(await db.webhookEvent.count()).toBe(0);
    expect((await db.refundOperation.findFirstOrThrow()).state).toBe("PAYPAL_PENDING");
  });

  it("rejects malformed events", async () => {
    expect((await handlePayPalWebhook(deps(), { event: { hello: "world" }, headers: validHeaders })).status).toBe(400);
    expect((await handlePayPalWebhook(deps(), { event: null, headers: validHeaders })).status).toBe(400);
  });

  it("does not mark complete from the event payload; reconciles from authoritative state", async () => {
    const op = await pendingRefund();
    expect(op.state).toBe("PAYPAL_PENDING");
    // Event CLAIMS completed, but PayPal (fixture) still says PENDING:
    const r1 = await handlePayPalWebhook(deps(), { event: event("WH-2", "PAYMENT.CAPTURE.REFUNDED", op.paypalRefundId!, "COMPLETED"), headers: validHeaders });
    expect(r1.outcome).toMatch(/PAYPAL_PENDING/);
    expect((await db.case.findUniqueOrThrow({ where: { id: "case_a" } })).status).toBe("REFUND_PENDING");
  });

  it("deduplicates events and tolerates out-of-order delivery", async () => {
    const op = await pendingRefund();
    await payments.settlePending(op.paypalRefundId!, "COMPLETED");
    const done = await handlePayPalWebhook(deps(), { event: event("WH-3", "PAYMENT.CAPTURE.REFUNDED", op.paypalRefundId!, "COMPLETED"), headers: validHeaders });
    expect(done.outcome).toMatch(/COMPLETED/);
    const dup = await handlePayPalWebhook(deps(), { event: event("WH-3", "PAYMENT.CAPTURE.REFUNDED", op.paypalRefundId!, "COMPLETED"), headers: validHeaders });
    expect(dup.outcome).toMatch(/duplicate/);
    // A stale PENDING event arriving late must not regress the state:
    await handlePayPalWebhook(deps(), { event: event("WH-0-late", "PAYMENT.REFUND.PENDING", op.paypalRefundId!, "PENDING"), headers: validHeaders });
    expect((await db.refundOperation.findFirstOrThrow()).state).toBe("COMPLETED");
    expect((await db.case.findUniqueOrThrow({ where: { id: "case_a" } })).status).toBe("REFUNDED");
    expect(await db.webhookEvent.count()).toBe(2);
  });

  it("ignores refunds that ResolvePay did not create", async () => {
    const res = await handlePayPalWebhook(deps(), { event: event("WH-4", "PAYMENT.CAPTURE.REFUNDED", "SOMEONE-ELSES-REFUND", "COMPLETED"), headers: validHeaders });
    expect(res).toEqual({ status: 200, outcome: "ignored: refund not created by ResolvePay" });
  });

  it("reconciles an uncertain op via the webhook's invoice_id", async () => {
    await linkFixtureCapture("order_a");
    await analyzeCase(deps(), "case_a");
    payments.nextFault = "timeout_after_commit";
    await executeRefund(deps(), "case_a", (await approveLatest("case_a")).id, "m");
    const op = await db.refundOperation.findFirstOrThrow();
    expect(op.paypalRefundId).toBeNull();
    const realRefund = await db.fixtureRefund.findFirstOrThrow();
    const res = await handlePayPalWebhook(deps(), {
      event: { id: "WH-5", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: realRefund.id, invoice_id: op.invoiceId, status: "COMPLETED" } },
      headers: validHeaders,
    });
    expect(res.outcome).toMatch(/COMPLETED/);
    expect(await db.fixtureRefund.count()).toBe(1);
  });
});
