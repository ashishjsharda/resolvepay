// Centralized, validated server configuration. Never import this from client components.
import "server-only";
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PAYMENTS_MODE: z.enum(["fixture", "sandbox"]),
  AI_MODE: z.enum(["fixture", "live"]),
  PAYPAL_API_BASE: z.string().url().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  AI_PROVIDER: z.enum(["anthropic", "gemini"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  MERCHANT_PASSWORD: z.string().min(8, "MERCHANT_PASSWORD must be at least 8 characters"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  APP_BASE_URL: z.string().url(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (cached) return cached;
  const parsed = EnvSchema.parse(process.env);
  if (parsed.PAYMENTS_MODE === "sandbox") {
    if (!parsed.PAYPAL_CLIENT_ID || !parsed.PAYPAL_CLIENT_SECRET) {
      throw new Error("PAYMENTS_MODE=sandbox requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
    }
    if (!parsed.PAYPAL_API_BASE.includes("sandbox")) {
      throw new Error("Live PayPal is out of scope: PAYPAL_API_BASE must be the sandbox host");
    }
  }
  if (parsed.AI_MODE === "live" && parsed.AI_PROVIDER === "anthropic" && !parsed.ANTHROPIC_API_KEY) {
    throw new Error("AI_MODE=live with AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
  }
  if (parsed.AI_MODE === "live" && parsed.AI_PROVIDER === "gemini" && !parsed.GEMINI_API_KEY) {
    throw new Error("AI_MODE=live with AI_PROVIDER=gemini requires GEMINI_API_KEY");
  }
  cached = parsed;
  return parsed;
}

/** Structured, trusted rules that mirror the merchant's written policy. Enforced by code, not the model. */
export const MERCHANT_RULES = {
  returnWindowDays: 30,
  currency: "USD" as const,
};
