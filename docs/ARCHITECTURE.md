# Architecture and trust boundaries

## Components

```
 Browser (merchant)                      Next.js server (Node)                         External
 ─────────────────                       ─────────────────────                         ────────
 HTML forms (no client JS needed) ──POST─▶ route handler
   session cookie (httpOnly,              │ merchantAction(): session ✓ origin ✓ CSRF ✓
   SameSite=Strict) + CSRF field          ▼
                                         services/cases.ts  ── the only place state changes
                                          │   analyzeCase ──────────────▶ ai/analyze.ts ──▶ Anthropic or Gemini API
                                          │      └─ ai/guards.ts (Zod + deterministic checks)
                                          │   reviseProposal / approveProposal / declineCase
                                          │   executeRefund / reconcileOperation ──▶ paypal/sandbox.ts ──▶ PayPal sandbox
                                          │   linkCapture                            (or paypal/fixture.ts: local ledger)
                                          ▼
                                         PostgreSQL (Prisma): cases, proposals, approvals,
                                          refund operations, webhook events, audit log

 PayPal ──POST /api/webhooks/paypal──▶ handlePayPalWebhook(): verify signature with PayPal,
                                        dedupe by event id, reconcile by re-fetching the refund
```

## Trust boundaries

| Source | Trust | How it's handled |
|---|---|---|
| Customer complaint text | **Untrusted** | Escaped and wrapped in `<customer_message>`; system prompt says it's data. Independent regex heuristic flags injection. Rendered as plain text in the UI. |
| Model output (either provider) | **Untrusted** | Forced tool/function call → strict Zod parse (extra fields rejected) → quotes checked verbatim against policy → line items checked against the order → escalation rules. The model never sees prices and has no field for an amount. |
| Order, line items, policy text, `MERCHANT_RULES` | Trusted (seeded by merchant) | Source of all prices and the return window. |
| Merchant browser requests | Trusted only after checks | HMAC-signed session cookie, same-origin `Origin` header, session-bound CSRF token, explicit confirmation, and exact proposal id/version/amount. |
| PayPal API responses | Authoritative for payment state | Parsed with Zod; amounts converted to integer cents without floats. Ambiguous transport outcomes are never treated as success or failure. |
| Webhook requests | **Untrusted** until verified | Verified via PayPal's `verify-webhook-signature` with our `PAYPAL_WEBHOOK_ID`. Unverified events are not stored in the dedupe table (so a forged event can't block a real one). Even verified events only trigger a re-fetch; their payload status is not applied. |
| Fixture ledger / simulator | Simulated | Separate tables (`FixtureCapture`, `FixtureRefund`), `FIXTURE-` ID prefixes, `source=fixture-simulator`, and a banner on every page. Sandbox mode rejects `FIXTURE-` IDs. |

## Credentials
All secrets (PayPal client secret, Anthropic or Gemini key, session secret) are read only in server modules marked `import "server-only"`. Nothing is sent to the browser; pages are server-rendered.

## Money
Integer cents everywhere (`src/lib/money.ts`). PayPal decimal strings are parsed with a regex and integer math; formatting uses integer division. Amounts are computed only by `priceSelection()` from trusted order data.

## State machines
Case: `NEW → AWAITING_REVIEW | ESCALATED | ANALYSIS_FAILED → APPROVED → EXECUTING → REFUNDED | REFUND_PENDING | NEEDS_RECONCILIATION | REFUND_FAILED`, plus `DECLINED`. All transitions go through `assertTransition` and a conditional `UPDATE ... WHERE status = <from>`.

Refund operation: `CREATED → SUBMITTED → COMPLETED | PAYPAL_PENDING | UNKNOWN | FAILED | CANCELLED`. Terminal states never regress.

## Concurrency and idempotency
- **One active refund per case:** `RefundOperation.activeLock` is set to the case id while non-terminal and has a unique index.
- **One execution per approval:** `RefundOperation.approvalId` is unique.
- **Claim step** runs in a `SERIALIZABLE` transaction with a conditional status update.
- **PayPal idempotency:** `PayPal-Request-Id` is generated and persisted before the call; every retry or reconciliation replays the same id.
- **Webhook dedupe:** unique `paypalEventId`; an event stored but not finished (crash) is processed on PayPal's retry.

## Approval binding
`approvalFingerprint = sha256([caseId, captureId, currency, amountCents, proposalId, proposalVersion])`. Execution recomputes it from current data. Creating a new proposal version, relinking the capture, declining, or a failed pre-flight all invalidate open approvals.
