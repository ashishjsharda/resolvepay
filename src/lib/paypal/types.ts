export type Mode = "FIXTURE" | "SANDBOX";

export interface CaptureInfo {
  id: string;
  status: string; // COMPLETED, PARTIALLY_REFUNDED, REFUNDED, PENDING, DECLINED, FAILED
  amountCents: number;
  currency: string;
  raw: unknown;
}

export interface RefundInfo {
  id: string;
  status: string; // COMPLETED, PENDING, FAILED, CANCELLED
  amountCents: number | null;
  currency: string | null;
  invoiceId: string | null;
  raw: unknown;
}

export interface RefundRequest {
  captureId: string;
  amountCents: number;
  currency: string;
  requestId: string; // PayPal-Request-Id: same id => same refund on replay
  invoiceId: string;
  customId: string;
  noteToPayer: string;
}

export interface WebhookHeaders {
  transmissionId: string | null;
  transmissionTime: string | null;
  certUrl: string | null;
  authAlgo: string | null;
  transmissionSig: string | null;
}

/**
 * DEFINITE: PayPal clearly rejected the request (4xx). Nothing was created.
 * AMBIGUOUS: we cannot know whether PayPal acted (timeout, network error, 5xx). Never retry with a new id.
 */
export class PaymentsError extends Error {
  constructor(
    message: string,
    public readonly kind: "DEFINITE" | "AMBIGUOUS",
    public readonly httpStatus?: number,
    public readonly debugId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface PaymentsAdapter {
  readonly mode: Mode;
  getCapture(captureId: string): Promise<CaptureInfo>;
  refundCapture(req: RefundRequest): Promise<RefundInfo>;
  getRefund(refundId: string): Promise<RefundInfo>;
  /** Returns true only if PayPal confirms the signature. */
  verifyWebhookSignature(headers: WebhookHeaders, event: unknown): Promise<boolean>;
}
