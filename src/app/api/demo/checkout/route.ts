import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { merchantAction } from "@/lib/session";
import { ServiceError } from "@/lib/services/cases";
import { payments } from "@/lib/paypal";
import { PayPalSandboxAdapter } from "@/lib/paypal/sandbox";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { addCents, lineTotalCents } from "@/lib/money";

// Creates a REAL PayPal sandbox order for a seeded order's exact total and sends the merchant
// to PayPal to pay it with a sandbox buyer account.
export const POST = merchantAction(
  () => "/demo",
  async ({ form }) => {
    const pp = payments();
    if (!(pp instanceof PayPalSandboxAdapter)) throw new ServiceError("Real sandbox checkout requires PAYMENTS_MODE=sandbox");
    const order = await prisma.order.findUnique({ where: { id: String(form.get("orderId") ?? "") }, include: { lineItems: true, payment: true } });
    if (!order) throw new ServiceError("Order not found");
    if (order.payment) throw new ServiceError("This order already has a linked capture");
    const itemTotal = addCents(...order.lineItems.map((li) => lineTotalCents(li.unitCents, li.quantity)));
    const checkoutId = randomUUID();
    const base = config().APP_BASE_URL;
    const created = await pp.createOrder({
      referenceId: order.orderNumber,
      totalCents: order.totalCents,
      itemTotalCents: itemTotal,
      shippingCents: order.shippingCents,
      items: order.lineItems,
      returnUrl: `${base}/api/demo/checkout/return?checkout=${checkoutId}`,
      cancelUrl: `${base}/demo?err=${encodeURIComponent("Sandbox checkout cancelled")}`,
      requestId: `resolvepay-order-${checkoutId}`,
    });
    await prisma.sandboxCheckout.create({ data: { id: checkoutId, orderId: order.id, paypalOrderId: created.id, status: "CREATED" } });
    return NextResponse.redirect(created.approveUrl, 303);
  },
);
