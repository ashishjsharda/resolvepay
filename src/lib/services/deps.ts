import "server-only";
import { config, MERCHANT_RULES } from "../config";
import { prisma } from "../db";
import { payments } from "../paypal";
import { runModel } from "../ai/analyze";
import type { Deps } from "./cases";

export function appDeps(): Deps {
  config(); // validate env early
  return {
    db: prisma,
    payments: payments(),
    now: () => new Date(),
    returnWindowDays: MERCHANT_RULES.returnWindowDays,
    runModel: async ({ caseId }) => {
      const c = await prisma.case.findUniqueOrThrow({
        where: { id: caseId },
        include: { order: { include: { lineItems: true } }, merchant: { include: { policies: true } } },
      });
      return runModel({
        caseId,
        orderNumber: c.order.orderNumber,
        placedAt: c.order.placedAt,
        deliveredAt: c.order.deliveredAt,
        shippingCents: c.order.shippingCents,
        lineItems: c.order.lineItems,
        policies: c.merchant.policies.map((p) => ({ key: p.key, title: p.title, text: p.text })),
        complaint: c.complaint,
        today: new Date(),
      });
    },
  };
}
