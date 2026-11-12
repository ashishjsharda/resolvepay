// Real PayPal REST client (sandbox only). Endpoints verified against PayPal's REST docs:
//   POST /v1/oauth2/token
//   GET  /v2/payments/captures/{id}
//   POST /v2/payments/captures/{id}/refund   (PayPal-Request-Id for idempotency)
//   GET  /v2/payments/refunds/{id}
//   POST /v1/notifications/verify-webhook-signature
//   POST /v2/checkout/orders, POST /v2/checkout/orders/{id}/capture   (demo setup only)
import { z } from "zod";
import { centsToDecimal, parseDecimalToCents } from "../money";
import { PaymentsError, type CaptureInfo, type PaymentsAdapter, type RefundInfo, type RefundRequest, type WebhookHeaders } from "./types";

const MoneySchema = z.object({ value: z.string(), currency_code: z.string() });
const CaptureSchema = z.object({ id: z.string(), status: z.string(), amount: MoneySchema }).passthrough();
const RefundSchema = z
  .object({ id: z.string(), status: z.string(), amount: MoneySchema.optional(), invoice_id: z.string().optional() })
  .passthrough();
const TokenSchema = z.object({ access_token: z.string(), expires_in: z.number() });

export interface SandboxOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class PayPalSandboxAdapter implements PaymentsAdapter {
  readonly mode = "SANDBOX" as const;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: SandboxOptions) {
    if (!opts.baseUrl.includes("sandbox")) throw new Error("Refusing to use a non-sandbox PayPal host");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async rawFetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
    try {
      return await this.fetchImpl(`${this.opts.baseUrl}${path}`, { ...init, signal: controller.signal, cache: "no-store" });
    } catch (e) {
      throw new PaymentsError(`Network error calling PayPal ${path}: ${e instanceof Error ? e.message : e}`, "AMBIGUOUS");
    } finally {
      clearTimeout(timer);
    }
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.rawFetch("/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PaymentsError(`PayPal token request failed (${res.status})`, res.status >= 500 ? "AMBIGUOUS" : "DEFINITE", res.status);
    const parsed = TokenSchema.parse(await res.json());
    this.token = { value: parsed.access_token, expiresAt: Date.now() + parsed.expires_in * 1000 };
    return parsed.access_token;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    let token = await this.accessToken();
    const send = () =>
      this.rawFetch(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await send();
    if (res.status === 401) {
      // Token rejected before processing; safe to refresh and resend (same idempotency key, if any).
      token = await this.accessToken(true);
      res = await send();
    }
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { unparsable: text.slice(0, 500) };
    }
    if (res.ok) return json;
    const name = (json as { name?: string; details?: { issue?: string }[] } | null)?.name;
    const issue = (json as { details?: { issue?: string }[] } | null)?.details?.[0]?.issue;
    const msg = `PayPal ${method} ${path} -> ${res.status}${name ? ` ${name}` : ""}${issue ? ` (${issue})` : ""}`;
    // 409 can mean "a request with this PayPal-Request-Id is still being processed": not a definite failure.
    const kind = res.status >= 500 || [408, 409, 429].includes(res.status) ? "AMBIGUOUS" : "DEFINITE";
    throw new PaymentsError(msg, kind, res.status, debugId, json);
  }

  async getCapture(captureId: string): Promise<CaptureInfo> {
    const json = CaptureSchema.parse(await this.call("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`));
    return {
      id: json.id,
      status: json.status,
      amountCents: parseDecimalToCents(json.amount.value),
      currency: json.amount.currency_code,
      raw: json,
    };
  }

  async refundCapture(req: RefundRequest): Promise<RefundInfo> {
    const json = await this.call(
        "POST",
        `/v2/payments/captures/${encodeURIComponent(req.captureId)}/refund`,
        {
          amount: { value: centsToDecimal(req.amountCents), currency_code: req.currency },
          invoice_id: req.invoiceId,
          custom_id: req.customId,
          note_to_payer: req.noteToPayer.slice(0, 255),
        },
        { "PayPal-Request-Id": req.requestId, Prefer: "return=representation" },
      );
    return toRefundInfo(json);
  }

  async getRefund(refundId: string): Promise<RefundInfo> {
    return toRefundInfo(await this.call("GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`));
  }

  async verifyWebhookSignature(h: WebhookHeaders, event: unknown): Promise<boolean> {
    if (!this.opts.webhookId) return false;
    if (!h.transmissionId || !h.transmissionTime || !h.certUrl || !h.authAlgo || !h.transmissionSig) return false;
    try {
      const json = (await this.call("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: h.authAlgo,
        cert_url: h.certUrl,
        transmission_id: h.transmissionId,
        transmission_sig: h.transmissionSig,
        transmission_time: h.transmissionTime,
        webhook_id: this.opts.webhookId,
        webhook_event: event,
      })) as { verification_status?: string };
      return json?.verification_status === "SUCCESS";
    } catch {
      return false;
    }
  }

  // ---- Demo-setup helpers (Orders v2). Used only to create a real sandbox payment. ----

  async createOrder(args: {
    referenceId: string;
    totalCents: number;
    itemTotalCents: number;
    shippingCents: number;
    items: { name: string; sku: string; unitCents: number; quantity: number }[];
    returnUrl: string;
    cancelUrl: string;
    requestId: string;
  }): Promise<{ id: string; approveUrl: string }> {
    const json = (await this.call(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: args.referenceId,
            amount: {
              currency_code: "USD",
              value: centsToDecimal(args.totalCents),
              breakdown: {
                item_total: { currency_code: "USD", value: centsToDecimal(args.itemTotalCents) },
                shipping: { currency_code: "USD", value: centsToDecimal(args.shippingCents) },
              },
            },
            items: args.items.map((i) => ({
              name: i.name.slice(0, 127),
              sku: i.sku,
              quantity: String(i.quantity),
              unit_amount: { currency_code: "USD", value: centsToDecimal(i.unitCents) },
            })),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: args.returnUrl,
              cancel_url: args.cancelUrl,
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
            },
          },
        },
      },
      { "PayPal-Request-Id": args.requestId },
    )) as { id: string; links?: { rel: string; href: string }[] };
    const link = json.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
    if (!json.id || !link) throw new PaymentsError("PayPal order response had no approval link", "DEFINITE", undefined, undefined, json);
    return { id: json.id, approveUrl: link.href };
  }

  async captureOrder(orderId: string, requestId: string): Promise<{ status: string; captureId: string | null; raw: unknown }> {
    const json = (await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, {
      "PayPal-Request-Id": requestId,
      Prefer: "return=representation",
    })) as { status?: string; purchase_units?: { payments?: { captures?: { id: string }[] } }[] };
    const captureId = json.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
    return { status: json.status ?? "UNKNOWN", captureId, raw: json };
  }
}

function toRefundInfo(json: unknown): RefundInfo {
  const r = RefundSchema.parse(json);
  return {
    id: r.id,
    status: r.status,
    amountCents: r.amount ? parseDecimalToCents(r.amount.value) : null,
    currency: r.amount?.currency_code ?? null,
    invoiceId: r.invoice_id ?? null,
    raw: r,
  };
}
