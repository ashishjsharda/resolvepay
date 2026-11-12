import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { config } from "@/lib/config";
import { merchantAction } from "@/lib/session";

export const POST = merchantAction(
  () => "/login",
  async () => {
    const res = NextResponse.redirect(new URL("/login", config().APP_BASE_URL), 303);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  },
);
