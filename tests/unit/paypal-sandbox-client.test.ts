// Contract tests for the real sandbox client with a mocked fetch. These prove request shape and
// error classification; they do NOT prove connectivity to PayPal (see README "Verification status").
import { describe, expect, it } from "vitest";
import { PayPalSandboxAdapter } from "@/lib/paypal/sandbox";
import { PaymentsError } from "@/lib/paypal/types";

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const base = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "secret", webhookId: "WH1" };

describe("PayPal sandbox client", () => {
  it("refuses non-sandbox hosts", () => {
    expect(() => new PayPalSandboxAdapter({ ...base, baseUrl: "https://api-m.paypal.com" })).toThrow();
  });

  it("sends a partial refund with idempotency key and decimal amount", async () => {
    const { f, calls } = mockFetch(() => Response.json({ id: "REF1", status: "COMPLETED", amount: { value: "48.00", currency_code: "USD" }, invoice_id: "RP-1" }));
    const pp = new PayPalSandboxAdapter({ ...base, fetchImpl: f });
    const r = await pp.refundCapture({ captureId: "CAP123", amountCents: 4800, currency: "USD", requestId: "req-1", invoiceId: "RP-1", customId: "case_a", noteToPayer: "hi" });
    expect(r).toMatchObject({ id: "REF1", status: "COMPLETED", amountCents: 4800 });
    const call = calls.find((c) => c.url.includes("/refund"))!;
    expect(call.url).toBe("https://api-m.sandbox.paypal.com/v2/payments/captures/CAP123/refund");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["PayPal-Request-Id"]).toBe("req-1");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(call.init.body as string)).toMatchObject({ amount: { value: "48.00", currency_code: "USD" }, invoice_id: "RP-1" });
  });

  it("classifies 5xx and network errors as AMBIGUOUS", async () => {
    const pp1 = new PayPalSandboxAdapter({ ...base, fetchImpl: mockFetch(() => new Response("oops", { status: 503 })).f });
    await expect(pp1.refundCapture({ captureId: "C", amountCents: 1, currency: "USD", requestId: "r", invoiceId: "i", customId: "c", noteToPayer: "n" })).rejects.toMatchObject({
      kind: "AMBIGUOUS",
    });
    const pp2 = new PayPalSandboxAdapter({
      ...base,
      fetchImpl: mockFetch(() => {
        throw new TypeError("socket hang up");
      }).f,
    });
    await expect(pp2.getRefund("R")).rejects.toMatchObject({ kind: "AMBIGUOUS" });
  });

  it("classifies 422 as DEFINITE and keeps PayPal's error name", async () => {
    const pp = new PayPalSandboxAdapter({
      ...base,
      fetchImpl: mockFetch(() => Response.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] }, { status: 422 })).f,
    });
    const err = await pp.refundCapture({ captureId: "C", amountCents: 1, currency: "USD", requestId: "r", invoiceId: "i", customId: "c", noteToPayer: "n" }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentsError);
    expect(err.kind).toBe("DEFINITE");
    expect(err.message).toContain("REFUND_AMOUNT_EXCEEDED");
  });

  it("parses capture details into integer cents", async () => {
    const pp = new PayPalSandboxAdapter({ ...base, fetchImpl: mockFetch(() => Response.json({ id: "CAP", status: "COMPLETED", amount: { value: "80.00", currency_code: "USD" } })).f });
    expect(await pp.getCapture("CAP")).toMatchObject({ amountCents: 8000, currency: "USD", status: "COMPLETED" });
  });

  it("verifies webhooks via PayPal and requires all transmission headers", async () => {
    const { f, calls } = mockFetch(() => Response.json({ verification_status: "SUCCESS" }));
    const pp = new PayPalSandboxAdapter({ ...base, fetchImpl: f });
    const h = { transmissionId: "t", transmissionTime: "now", certUrl: "https://api.sandbox.paypal.com/cert", authAlgo: "SHA256withRSA", transmissionSig: "sig" };
    expect(await pp.verifyWebhookSignature(h, { id: "WH-EVT" })).toBe(true);
    const body = JSON.parse(calls.at(-1)!.init.body as string);
    expect(body).toMatchObject({ webhook_id: "WH1", transmission_id: "t", auth_algo: "SHA256withRSA", webhook_event: { id: "WH-EVT" } });
    expect(await pp.verifyWebhookSignature({ ...h, transmissionSig: null }, {})).toBe(false);

    const failing = new PayPalSandboxAdapter({ ...base, fetchImpl: mockFetch(() => Response.json({ verification_status: "FAILURE" })).f });
    expect(await failing.verifyWebhookSignature(h, {})).toBe(false);
  });
});
