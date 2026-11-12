// Pure session + CSRF primitives (no Next.js imports, so they are unit-testable).
// Session: HMAC-signed token in an httpOnly, SameSite=Strict cookie.
// CSRF: per-session token = HMAC(secret, "csrf:" + sid), submitted in a hidden form field and
// compared in constant time. Origin header is also checked on every state-changing request.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "rp_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionPayload {
  sid: string;
  sub: "merchant";
  exp: number; // unix seconds
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkPassword(supplied: string, expected: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(supplied), h(expected));
}

export function createSessionToken(secret: string, nowSec = Math.floor(Date.now() / 1000)): { token: string; payload: SessionPayload } {
  const payload: SessionPayload = { sid: randomBytes(16).toString("hex"), sub: "merchant", exp: nowSec + SESSION_TTL_SECONDS };
  const body = b64(JSON.stringify(payload));
  return { token: `${body}.${hmac(secret, body)}`, payload };
}

export function verifySessionToken(secret: string, token: string | undefined | null, nowSec = Math.floor(Date.now() / 1000)): SessionPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!safeEqual(sig, hmac(secret, body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (p.sub !== "merchant" || typeof p.sid !== "string" || typeof p.exp !== "number" || p.exp < nowSec) return null;
    return p;
  } catch {
    return null;
  }
}

export function csrfTokenFor(secret: string, sid: string): string {
  return hmac(secret, `csrf:${sid}`);
}

export function verifyCsrf(secret: string, sid: string, token: unknown): boolean {
  return typeof token === "string" && token.length > 0 && safeEqual(token, csrfTokenFor(secret, sid));
}

/** Same-origin check for state-changing requests. Missing Origin is rejected. */
export function originAllowed(origin: string | null, appBaseUrl: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(appBaseUrl).origin;
  } catch {
    return false;
  }
}
