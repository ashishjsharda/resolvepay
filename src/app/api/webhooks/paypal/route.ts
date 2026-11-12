import { NextResponse, type NextRequest } from "next/server";
import { handlePayPalWebhook } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";

// Public endpoint for PayPal. Nothing is trusted until PayPal verifies the signature.
// It can only RECONCILE refunds ResolvePay already created; it can never create or approve one.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 256_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const h = (n: string) => req.headers.get(n);
  try {
    const res = await handlePayPalWebhook(appDeps(), {
      event,
      headers: {
        transmissionId: h("paypal-transmission-id"),
        transmissionTime: h("paypal-transmission-time"),
        certUrl: h("paypal-cert-url"),
        authAlgo: h("paypal-auth-algo"),
        transmissionSig: h("paypal-transmission-sig"),
      },
    });
    return NextResponse.json({ outcome: res.outcome }, { status: res.status });
  } catch (e) {
    console.error("[resolvepay] webhook processing error", e);
    // 500 tells PayPal to retry later; dedupe makes the retry safe.
    return NextResponse.json({ error: "Processing error" }, { status: 500 });
  }
}
