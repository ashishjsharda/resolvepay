import "server-only";
import { config } from "../config";
import { prisma } from "../db";
import { FixturePaymentsAdapter } from "./fixture";
import { PayPalSandboxAdapter } from "./sandbox";
import type { PaymentsAdapter } from "./types";

const g = globalThis as unknown as { __payments?: PaymentsAdapter };

/** Returns exactly one adapter based on PAYMENTS_MODE. There is no fallback between modes. */
export function payments(): PaymentsAdapter {
  if (g.__payments) return g.__payments;
  const cfg = config();
  g.__payments =
    cfg.PAYMENTS_MODE === "sandbox"
      ? new PayPalSandboxAdapter({
          baseUrl: cfg.PAYPAL_API_BASE,
          clientId: cfg.PAYPAL_CLIENT_ID!,
          clientSecret: cfg.PAYPAL_CLIENT_SECRET!,
          webhookId: cfg.PAYPAL_WEBHOOK_ID,
        })
      : new FixturePaymentsAdapter(prisma);
  return g.__payments;
}

export function isFixtureMode(): boolean {
  return config().PAYMENTS_MODE === "fixture";
}
