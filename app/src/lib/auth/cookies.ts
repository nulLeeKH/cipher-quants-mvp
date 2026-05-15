// ============================================================================
// Session cookie — server-only helpers
// ============================================================================
// httpOnly, SameSite=Lax cookie. Secure flag when NODE_ENV=production.
// Reads cookie value via NextRequest.cookies or our own raw-header parser
// (so we work in both route handlers and arbitrary fetch flows).

import type { NextResponse } from "next/server";

import { SESSION_EXP_SECONDS } from "./jwt";

export const SESSION_COOKIE_NAME = "cipher-quants-session";

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_EXP_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE_NAME) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}
