import { merchantAction } from "@/lib/session";
import { linkCapture, ServiceError } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";
import { FixturePaymentsAdapter } from "@/lib/paypal/fixture";
import { prisma } from "@/lib/db";

export const POST = merchantAction(
  () => "/demo",
  async ({ form, actor }) => {
    const deps = appDeps();
    if (!(deps.payments instanceof FixturePaymentsAdapter)) throw new ServiceError("Simulated captures are only available in fixture mode");
    const order = await prisma.order.findUnique({ where: { id: String(form.get("orderId") ?? "") } });
    if (!order) throw new ServiceError("Order not found");
    const captureId = await deps.payments.createCapture(order.totalCents);
    await linkCapture(deps, order.id, captureId, actor);
    return { msg: `Created SIMULATED capture ${captureId} (not a PayPal payment).` };
  },
);
