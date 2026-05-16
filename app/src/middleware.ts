// ============================================================================
// Admin route guard — server-side JWT verification at the edge
// ============================================================================
// `AdminGuard` (client component) was the only barrier between an attacker
// with a forged session cookie and admin UI/data. This middleware runs in
// Next.js Edge runtime *before* the page renders, so client bundles never
// load and server-side route handlers stay shielded too.
//
// Notes:
// - Auth API routes (/api/auth/*) are excluded — they're how unauthenticated
//   users obtain a session in the first place.
// - /admin/login itself is excluded; that's where unauthenticated users land.
// - Static assets and _next internals are excluded via the matcher.
//
// `jose` is Edge-compatible, so `verifySession` runs here without Node-only
// modules. Do NOT import anything that pulls `node:crypto` / `node:fs`.

import { NextResponse, type NextRequest } from "next/server";

import { verifySession } from "@/lib/auth/jwt";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";

export const config = {
  matcher: ["/admin/:path*"],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Login page must remain reachable without a session.
  if (pathname === "/admin/login" || pathname.startsWith("/admin/login/")) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return redirectToLogin(req);
  }

  try {
    await verifySession(token);
    return NextResponse.next();
  } catch {
    // Expired / tampered / wrong audience — fall through to login.
    return redirectToLogin(req);
  }
}

function redirectToLogin(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  // Preserve the original target so the login flow can redirect back.
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}
