import { randomUUID } from "node:crypto";
import { merchantAction } from "@/lib/session";
import { handlePayPalWebhook, ServiceError } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";
import { FixturePaymentsAdapter } from "@/lib/paypal/fixture";
import { prisma } from "@/lib/db";

// FIXTURE MODE ONLY. Settles a simulated PENDING refund and delivers a simulated webhook through the
// same reconciliation code. Recorded with source=fixture-simulator; never confused with PayPal events.
export const POST = merchantAction(
  (_r, form) => `/cases/${encodeURIComponent(String(form.get("caseId") ?? ""))}`,
  async ({ form }) => {
    const deps = appDeps();
    if (!(deps.payments instanceof FixturePaymentsAdapter)) throw new ServiceError("The webhook simulator is only available in fixture mode");
    const op = await prisma.refundOperation.findUnique({ where: { id: String(form.get("opId") ?? "") } });
    if (!op?.paypalRefundId) throw new ServiceError("No simulated refund id on this operation");
    const status = form.get("status") === "FAILED" ? "FAILED" : "COMPLETED";
    await deps.payments.settlePending(op.paypalRefundId, status);
    const res = await handlePayPalWebhook(
      deps,
      {
        event: { id: `FIXTURE-EVT-${randomUUID()}`, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: op.paypalRefundId, status } },
        headers: { transmissionId: null, transmissionTime: null, certUrl: null, authAlgo: null, transmissionSig: null },
      },
      "fixture-simulator",
    );
    return { msg: `Simulated webhook: ${res.outcome}` };
  },
);
