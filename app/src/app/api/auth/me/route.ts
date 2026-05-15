import { NextResponse } from "next/server";

import { verifySession } from "@/lib/auth/jwt";
import { readSessionCookie } from "@/lib/auth/cookies";

export async function GET(req: Request) {
  const token = readSessionCookie(req);
  if (!token) {
    return NextResponse.json({ error: "No session" }, { status: 401 });
  }
  try {
    const claims = await verifySession(token);
    return NextResponse.json({
      pubkey: claims.sub,
      pool: claims.pool,
      exp: claims.exp,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 401 });
  }
}
