import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { checkPassword, createSessionToken, originAllowed, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";

// Naive in-memory throttle; adequate for a single-merchant demo, not for production.
const attempts = new Map<string, { n: number; until: number }>();

export async function POST(req: NextRequest) {
  const cfg = config();
  const login = new URL("/login", cfg.APP_BASE_URL);
  if (!originAllowed(req.headers.get("origin"), cfg.APP_BASE_URL)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) {
    login.searchParams.set("err", "Too many attempts. Wait a minute.");
    return NextResponse.redirect(login, 303);
  }
  const form = await req.formData();
  const pw = String(form.get("password") ?? "");
  if (!checkPassword(pw, cfg.MERCHANT_PASSWORD)) {
    const n = (a?.n ?? 0) + 1;
    attempts.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    login.searchParams.set("err", "Incorrect password.");
    return NextResponse.redirect(login, 303);
  }
  attempts.delete(ip);
  const { token } = createSessionToken(cfg.SESSION_SECRET);
  const res = NextResponse.redirect(new URL("/", cfg.APP_BASE_URL), 303);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: cfg.APP_BASE_URL.startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
