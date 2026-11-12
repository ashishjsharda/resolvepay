import { type NextRequest } from "next/server";
import { back, getSession } from "@/lib/session";
import { linkCapture } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";
import { PayPalSandboxAdapter } from "@/lib/paypal/sandbox";
import { prisma } from "@/lib/db";

// PayPal redirects the buyer here after approval. We capture the order server-side, then verify
// and link the resulting capture. Requires the merchant session; the checkout must be one we created.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return back(req, "/login", { err: "Sign in, then retry from Demo Setup." });
  const checkoutId = req.nextUrl.searchParams.get("checkout") ?? "";
  const checkout = await prisma.sandboxCheckout.findUnique({ where: { id: checkoutId } });
  if (!checkout || checkout.status !== "CREATED") return back(req, "/demo", { err: "Unknown or already-processed checkout" });
  const deps = appDeps();
  if (!(deps.payments instanceof PayPalSandboxAdapter)) return back(req, "/demo", { err: "Not in sandbox mode" });
  try {
    const cap = await deps.payments.captureOrder(checkout.paypalOrderId, `resolvepay-capture-${checkout.id}`);
    await prisma.sandboxCheckout.update({ where: { id: checkout.id }, data: { status: cap.status, captureId: cap.captureId } });
    if (cap.status !== "COMPLETED" || !cap.captureId) return back(req, "/demo", { err: `PayPal order status ${cap.status}; no completed capture` });
    await linkCapture(deps, checkout.orderId, cap.captureId, `merchant:${session.sid.slice(0, 8)}`);
    return back(req, "/demo", { msg: `Real sandbox payment captured (${cap.captureId}) and linked.` });
  } catch (e) {
    return back(req, "/demo", { err: e instanceof Error ? e.message : "Capture failed" });
  }
}
