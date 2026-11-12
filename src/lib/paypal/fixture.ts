// SIMULATED payments for PAYMENTS_MODE=fixture. Backed by the Fixture* tables.
// Mirrors PayPal's documented semantics (idempotent PayPal-Request-Id, over-refund rejection)
// so UI and tests exercise the same code paths. Every ID is prefixed FIXTURE- and every screen
// in this mode displays a "Simulated payments" banner.
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { PaymentsError, type CaptureInfo, type PaymentsAdapter, type RefundInfo, type RefundRequest, type WebhookHeaders } from "./types";

export type FixtureFault = "none" | "timeout_after_commit" | "timeout_before_commit" | "server_error" | "pending";

export class FixturePaymentsAdapter implements PaymentsAdapter {
  readonly mode = "FIXTURE" as const;
  /** Test/demo hook: inject a fault into the next refund call. */
  nextFault: FixtureFault = "none";

  constructor(private readonly db: PrismaClient) {}

  static newCaptureId() {
    return `FIXTURE-CAP-${randomBytes(6).toString("hex").toUpperCase()}`;
  }

  async createCapture(amountCents: number, currency = "USD"): Promise<string> {
    const id = FixturePaymentsAdapter.newCaptureId();
    await this.db.fixtureCapture.create({ data: { id, amountCents, currency, status: "COMPLETED" } });
    return id;
  }

  async getCapture(captureId: string): Promise<CaptureInfo> {
    const c = await this.db.fixtureCapture.findUnique({ where: { id: captureId }, include: { refunds: true } });
    if (!c) throw new PaymentsError(`Fixture capture ${captureId} not found`, "DEFINITE", 404);
    return { id: c.id, status: c.status, amountCents: c.amountCents, currency: c.currency, raw: { simulated: true, ...c } };
  }

  async refundCapture(req: RefundRequest): Promise<RefundInfo> {
    const fault = this.nextFault;
    this.nextFault = "none";
    if (fault === "timeout_before_commit") throw new PaymentsError("Simulated timeout (request never reached PayPal)", "AMBIGUOUS");
    if (fault === "server_error") throw new PaymentsError("Simulated 503 from PayPal", "AMBIGUOUS", 503);

    // Idempotency: same request id returns the original refund.
    const existing = await this.db.fixtureRefund.findUnique({ where: { requestId: req.requestId } });
    if (existing) return this.toInfo(existing);

    const refund = await this.db.$transaction(async (tx) => {
      const cap = await tx.fixtureCapture.findUnique({ where: { id: req.captureId }, include: { refunds: true } });
      if (!cap) throw new PaymentsError("RESOURCE_NOT_FOUND", "DEFINITE", 404);
      if (req.currency !== cap.currency) throw new PaymentsError("CURRENCY_MISMATCH", "DEFINITE", 422);
      const refunded = cap.refunds.filter((r) => r.status !== "FAILED" && r.status !== "CANCELLED").reduce((s, r) => s + r.amountCents, 0);
      if (req.amountCents <= 0 || refunded + req.amountCents > cap.amountCents) {
        throw new PaymentsError("REFUND_AMOUNT_EXCEEDED", "DEFINITE", 422);
      }
      const status = fault === "pending" ? "PENDING" : "COMPLETED";
      const created = await tx.fixtureRefund.create({
        data: {
          id: `FIXTURE-REF-${randomBytes(6).toString("hex").toUpperCase()}`,
          captureId: cap.id,
          requestId: req.requestId,
          amountCents: req.amountCents,
          currency: req.currency,
          invoiceId: req.invoiceId,
          status,
        },
      });
      const total = refunded + req.amountCents;
      await tx.fixtureCapture.update({ where: { id: cap.id }, data: { status: total >= cap.amountCents ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
      return created;
    });

    if (fault === "timeout_after_commit") {
      throw new PaymentsError("Simulated timeout after PayPal processed the refund", "AMBIGUOUS");
    }
    return this.toInfo(refund);
  }

  async getRefund(refundId: string): Promise<RefundInfo> {
    const r = await this.db.fixtureRefund.findUnique({ where: { id: refundId } });
    if (!r) throw new PaymentsError(`Fixture refund ${refundId} not found`, "DEFINITE", 404);
    return this.toInfo(r);
  }

  /** Fixture mode never accepts inbound HTTP webhooks. Simulated events use a separate internal path. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async verifyWebhookSignature(_headers: WebhookHeaders, _event: unknown): Promise<boolean> {
    return false;
  }

  /** Simulator: settle a PENDING fixture refund (used by the "simulate webhook" control). */
  async settlePending(refundId: string, status: "COMPLETED" | "FAILED") {
    await this.db.fixtureRefund.update({ where: { id: refundId }, data: { status } });
  }

  private toInfo(r: { id: string; status: string; amountCents: number; currency: string; invoiceId: string }): RefundInfo {
    return { id: r.id, status: r.status, amountCents: r.amountCents, currency: r.currency, invoiceId: r.invoiceId, raw: { simulated: true, ...r } };
  }
}
