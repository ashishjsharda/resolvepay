# ResolvePay: Devpost draft

## Inspiration
Refund requests are a daily chore for small online shops. Reading the complaint and checking the policy is tedious; actually sending money back is where mistakes cost real dollars. We wanted AI to take the tedious part without ever being trusted with the risky part.

## What it does
ResolvePay is a returns-and-refunds copilot for a small PayPal merchant:

1. A customer complaint arrives with its order.
2. An LLM (Claude or Gemini, selectable) reads it, identifies the affected items, quotes the exact store-policy passages that apply, lists what's unverified or missing, flags manipulation attempts, recommends refund / decline / escalate, and drafts a reply.
3. ResolvePay checks every quote against the real policy, prices the refund itself from order data in integer cents, and applies hard rules (return window, remaining balance, injection detection).
4. The merchant approves an exact amount for an exact PayPal capture.
5. ResolvePay re-checks the capture with PayPal, issues the refund through the PayPal sandbox with an idempotency key, and reconciles the result through verified webhooks before marking it done.

Every step lands in an append-only audit timeline.

## How we built it
- **PayPal (sandbox):** OAuth2, Orders v2 create/capture (to create real demo payments), Payments v2 show capture / refund capture / show refund, and webhook signature verification.
- **Claude (Anthropic API) or Google Gemini:** a forced tool/function call with one shared strict JSON schema; output from either provider is validated with Zod and the same deterministic guards.
- Next.js 15 + TypeScript, Tailwind, PostgreSQL with Prisma, Vitest. Deployable on Render with the included Blueprint.

## Implemented (working today)
- Three demo scenarios: damaged item partial refund, outside-window escalation, prompt-injection attempt.
- Evidence verification: quotes must appear verbatim in the policy.
- Application-side pricing in integer cents; the model has no amount field and never sees prices.
- Approval bound to case, capture, currency, amount, and proposal version; any change invalidates it.
- Exactly-once refund execution under concurrent clicks (DB unique lock + conditional state transition).
- Uncertain outcomes (timeouts, 5xx) never trigger a new refund; reconciliation replays the same `PayPal-Request-Id` or reads the refund by ID.
- Webhooks: signature verification, dedupe, order-independent reconciliation by re-fetching refund state.
- Session auth, CSRF tokens, same-origin checks; no public refund endpoint.
- Fixture mode (clearly labeled) for development and tests; no silent fallback to mock success.
- Provider-agnostic AI layer: swap Claude or Gemini with one setting; the safety checks don't change.
- 77 automated tests including concurrency, failure injection, webhook replay, and a deliberately compromised model.

## Challenges
Designing for the case where we don't know whether money moved. A timeout after PayPal processes a refund looks identical to one before it. We persist the idempotency key before the call, classify outcomes as definite or ambiguous, and only ever replay the same request.

## What we learned
The safest AI payment flow is one where the model's output can only make things *more* conservative. Structured output plus deterministic checks let the AI be genuinely useful without being trusted with authority.

## What's next (not built yet)
- Live-money mode with PayPal partner onboarding for multiple merchants.
- Photo evidence for damage claims.
- Email/helpdesk intake and sending approved replies.
- Policy-to-rules extraction with merchant review, instead of hand-mirrored rules.
- Multi-user roles and per-merchant approval limits.
- Disputes and chargebacks.

## Built with
paypal, anthropic, claude, gemini, nextjs, typescript, tailwindcss, postgresql, prisma, zod, vitest, render
