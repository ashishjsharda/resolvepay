import type { PrismaClient } from "@/generated/prisma/client";
import { DEMO_CASES, DEMO_MERCHANT, DEMO_POLICIES, demoOrders } from "./demoData";
import { addCents, lineTotalCents } from "./money";

/**
 * Wipe ResolvePay demo data and re-seed. PaymentLinks are removed too, so after a reset you
 * re-link captures in Demo Setup (a real sandbox capture can only be refunded up to its amount once).
 */
export async function resetAndSeed(db: PrismaClient, now = new Date()) {
  await db.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany();
    await tx.webhookEvent.deleteMany();
    await tx.refundOperation.deleteMany();
    await tx.approval.deleteMany();
    await tx.proposal.deleteMany();
    await tx.analysis.deleteMany();
    await tx.case.deleteMany();
    await tx.sandboxCheckout.deleteMany();
    await tx.paymentLink.deleteMany();
    await tx.lineItem.deleteMany();
    await tx.order.deleteMany();
    await tx.policy.deleteMany();
    await tx.merchant.deleteMany();
    await tx.fixtureRefund.deleteMany();
    await tx.fixtureCapture.deleteMany();

    await tx.merchant.create({ data: DEMO_MERCHANT });
    for (const p of DEMO_POLICIES) await tx.policy.create({ data: { ...p, merchantId: DEMO_MERCHANT.id } });
    for (const o of demoOrders(now)) {
      const itemTotal = addCents(...o.lineItems.map((li) => lineTotalCents(li.unitCents, li.quantity)));
      await tx.order.create({
        data: {
          id: o.id,
          merchantId: DEMO_MERCHANT.id,
          orderNumber: o.orderNumber,
          customerName: o.customerName,
          customerEmail: o.customerEmail,
          currency: "USD",
          shippingCents: o.shippingCents,
          totalCents: addCents(itemTotal, o.shippingCents),
          placedAt: o.placedAt,
          deliveredAt: o.deliveredAt,
          lineItems: { create: o.lineItems },
        },
      });
    }
    for (const c of DEMO_CASES) {
      await tx.case.create({ data: { ...c, merchantId: DEMO_MERCHANT.id } });
      await tx.auditEvent.create({ data: { caseId: c.id, type: "case.received", actor: "system", data: { channel: "seeded demo complaint" } } });
    }
  }, { timeout: 30_000, maxWait: 10_000 });
}
