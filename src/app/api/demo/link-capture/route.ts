import { merchantAction } from "@/lib/session";
import { linkCapture, ServiceError } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";

export const POST = merchantAction(
  () => "/demo",
  async ({ form, actor }) => {
    const orderId = String(form.get("orderId") ?? "");
    const captureId = String(form.get("captureId") ?? "").trim();
    if (!orderId || !captureId) throw new ServiceError("Choose an order and paste a capture ID");
    const link = await linkCapture(appDeps(), orderId, captureId, actor);
    return { msg: `Verified with PayPal and linked capture ${link.captureId}.` };
  },
);
