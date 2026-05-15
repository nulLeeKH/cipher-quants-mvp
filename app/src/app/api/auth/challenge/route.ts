import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { issueChallenge } from "@/lib/auth/jwt";

export async function POST(req: Request) {
  let body: { pool?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is allowed
  }
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  const token = await issueChallenge(nonce, body.pool);
  return NextResponse.json({ token, nonce, issuedAt });
}
