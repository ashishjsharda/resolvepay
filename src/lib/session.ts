// Next.js glue for auth: reading the session cookie in pages and guarding mutating route handlers.
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "./config";
import { csrfTokenFor, originAllowed, SESSION_COOKIE, verifyCsrf, verifySessionToken, type SessionPayload } from "./auth";
import { ServiceError } from "./services/cases";
import { ProposalError } from "./proposal";
import { MoneyError } from "./money";
import { TransitionError } from "./stateMachine";

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  return verifySessionToken(config().SESSION_SECRET, jar.get(SESSION_COOKIE)?.value);
}

/** For pages: returns the session and its CSRF token, or redirects to /login. */
export async function requireMerchantPage(): Promise<{ session: SessionPayload; csrf: string }> {
  const session = await getSession();
  if (!session) redirect("/login");
  return { session, csrf: csrfTokenFor(config().SESSION_SECRET, session.sid) };
}

export function back(req: NextRequest, path: string, params: Record<string, string> = {}) {
  const url = new URL(path, config().APP_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v.slice(0, 400));
  return NextResponse.redirect(url, 303);
}

/**
 * Wrap a mutating POST handler: requires a valid session cookie, a same-origin request,
 * and a CSRF token bound to the session. Converts ServiceErrors into a redirect with a message.
 */
export function merchantAction(
  returnTo: (req: NextRequest, form: FormData, params: Record<string, string>) => string,
  fn: (args: { req: NextRequest; form: FormData; params: Record<string, string>; actor: string }) => Promise<NextResponse | { msg: string } | void>,
) {
  return async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
    const params = await ctx.params;
    const cfg = config();
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const session = verifySessionToken(cfg.SESSION_SECRET, token);
    if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    if (!originAllowed(req.headers.get("origin"), cfg.APP_BASE_URL)) {
      return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
    }
    const form = await req.formData();
    if (!verifyCsrf(cfg.SESSION_SECRET, session.sid, form.get("csrf"))) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }
    const target = returnTo(req, form, params);
    try {
      const out = await fn({ req, form, params, actor: `merchant:${session.sid.slice(0, 8)}` });
      if (out instanceof NextResponse) return out;
      return back(req, target, out?.msg ? { msg: out.msg } : {});
    } catch (e) {
      if (e instanceof ServiceError || e instanceof ProposalError || e instanceof MoneyError || e instanceof TransitionError) {
        return back(req, target, { err: e.message });
      }
      console.error("[resolvepay] action failed", e);
      return back(req, target, { err: "Unexpected error. Nothing was marked as refunded; check the audit timeline." });
    }
  };
}
