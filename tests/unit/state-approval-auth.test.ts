import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, nextOpState, opStateFromPayPalStatus, TransitionError } from "@/lib/stateMachine";
import { checkApprovalBinding, type ApprovalRecord, type CurrentState } from "@/lib/approval";
import { approvalFingerprint } from "@/lib/proposal";
import { checkPassword, createSessionToken, csrfTokenFor, originAllowed, verifyCsrf, verifySessionToken } from "@/lib/auth";

describe("case state machine", () => {
  it("allows the happy path", () => {
    for (const [a, b] of [
      ["NEW", "AWAITING_REVIEW"],
      ["AWAITING_REVIEW", "APPROVED"],
      ["APPROVED", "EXECUTING"],
      ["EXECUTING", "REFUNDED"],
    ] as const) {
      expect(canTransition(a, b)).toBe(true);
    }
  });
  it("forbids skipping approval or leaving REFUNDED", () => {
    expect(() => assertTransition("AWAITING_REVIEW", "EXECUTING")).toThrow(TransitionError);
    expect(() => assertTransition("ESCALATED", "EXECUTING")).toThrow(TransitionError);
    expect(() => assertTransition("NEW", "APPROVED")).toThrow(TransitionError);
    expect(() => assertTransition("REFUNDED", "AWAITING_REVIEW")).toThrow(TransitionError);
    expect(() => assertTransition("EXECUTING", "APPROVED")).toThrow(TransitionError);
  });
});

describe("refund op states", () => {
  it("maps PayPal statuses and treats unknown statuses as UNKNOWN (never success)", () => {
    expect(opStateFromPayPalStatus("COMPLETED")).toBe("COMPLETED");
    expect(opStateFromPayPalStatus("PENDING")).toBe("PAYPAL_PENDING");
    expect(opStateFromPayPalStatus("SOMETHING_NEW")).toBe("UNKNOWN");
    expect(opStateFromPayPalStatus(undefined)).toBe("UNKNOWN");
  });
  it("never moves backward out of a terminal state (out-of-order events)", () => {
    expect(nextOpState("COMPLETED", "PAYPAL_PENDING")).toBe("COMPLETED");
    expect(nextOpState("FAILED", "COMPLETED")).toBe("FAILED");
    expect(nextOpState("PAYPAL_PENDING", "COMPLETED")).toBe("COMPLETED");
    expect(nextOpState("SUBMITTED", "UNKNOWN")).toBe("UNKNOWN");
    expect(nextOpState("PAYPAL_PENDING", "UNKNOWN")).toBe("PAYPAL_PENDING");
  });
});

describe("approval binding / invalidation after proposal changes", () => {
  const fp = approvalFingerprint({ caseId: "c1", captureId: "CAP", currency: "USD", amountCents: 4800, proposalId: "p1", proposalVersion: 1 });
  const approval: ApprovalRecord = { proposalId: "p1", proposalVersion: 1, captureId: "CAP", currency: "USD", amountCents: 4800, fingerprint: fp, invalidatedAt: null };
  const current: CurrentState = {
    caseId: "c1",
    latestProposal: { id: "p1", version: 1, action: "REFUND", amountCents: 4800, currency: "USD", supersededAt: null },
    payment: { captureId: "CAP", currency: "USD" },
  };
  it("accepts an exact match", () => expect(checkApprovalBinding(approval, current)).toEqual({ ok: true }));
  it("rejects a new proposal version", () => {
    const r = checkApprovalBinding(approval, { ...current, latestProposal: { ...current.latestProposal!, id: "p2", version: 2 } });
    expect(r.ok).toBe(false);
  });
  it("rejects changed amount, capture, currency, superseded or invalidated", () => {
    expect(checkApprovalBinding(approval, { ...current, latestProposal: { ...current.latestProposal!, amountCents: 13500 } }).ok).toBe(false);
    expect(checkApprovalBinding(approval, { ...current, payment: { captureId: "OTHER", currency: "USD" } }).ok).toBe(false);
    expect(checkApprovalBinding(approval, { ...current, payment: { captureId: "CAP", currency: "EUR" } }).ok).toBe(false);
    expect(checkApprovalBinding(approval, { ...current, latestProposal: { ...current.latestProposal!, supersededAt: new Date() } }).ok).toBe(false);
    expect(checkApprovalBinding({ ...approval, invalidatedAt: new Date() }, current).ok).toBe(false);
    expect(checkApprovalBinding({ ...approval, fingerprint: "forged" }, current).ok).toBe(false);
  });
  it("rejects when the proposal is not a refund", () => {
    expect(checkApprovalBinding(approval, { ...current, latestProposal: { ...current.latestProposal!, action: "ESCALATE" } }).ok).toBe(false);
  });
});

describe("authentication and CSRF (unauthorized approval attempts)", () => {
  const secret = "x".repeat(40);
  it("verifies a valid session and rejects missing, forged, tampered, or expired tokens", () => {
    const { token } = createSessionToken(secret, 1000);
    expect(verifySessionToken(secret, token, 1001)?.sub).toBe("merchant");
    expect(verifySessionToken(secret, undefined, 1001)).toBeNull();
    expect(verifySessionToken("y".repeat(40), token, 1001)).toBeNull();
    const [body, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ sid: "a", sub: "merchant", exp: 99999999999 })).toString("base64url");
    expect(verifySessionToken(secret, `${forgedBody}.${sig}`, 1001)).toBeNull();
    expect(verifySessionToken(secret, `${body}.${sig}x`, 1001)).toBeNull();
    expect(verifySessionToken(secret, token, 1000 + 9 * 3600)).toBeNull();
  });
  it("binds CSRF tokens to the session", () => {
    const t = csrfTokenFor(secret, "sid-1");
    expect(verifyCsrf(secret, "sid-1", t)).toBe(true);
    expect(verifyCsrf(secret, "sid-2", t)).toBe(false);
    expect(verifyCsrf(secret, "sid-1", "")).toBe(false);
    expect(verifyCsrf(secret, "sid-1", undefined)).toBe(false);
  });
  it("requires same-origin requests", () => {
    expect(originAllowed("http://localhost:3000", "http://localhost:3000")).toBe(true);
    expect(originAllowed("https://evil.example", "http://localhost:3000")).toBe(false);
    expect(originAllowed(null, "http://localhost:3000")).toBe(false);
  });
  it("compares passwords", () => {
    expect(checkPassword("correct horse", "correct horse")).toBe(true);
    expect(checkPassword("wrong", "correct horse")).toBe(false);
  });
});
