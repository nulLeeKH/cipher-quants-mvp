// ============================================================================
// JWT helpers (HS256) — server-only
// ============================================================================
//
// JWT_SECRET MUST be provided via env (>= 16 chars). We fail fast on misuse
// rather than fall back to a public default — a leaked default secret means
// anyone can mint a valid admin session.

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

let cachedSecret: Uint8Array | null = null;

function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 16) {
    throw new Error(
      "JWT_SECRET environment variable is required (min 16 characters). " +
        "Set it in app/.env.local before starting the server."
    );
  }
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

const CHALLENGE_EXP_MIN = Number(process.env.ADMIN_CHALLENGE_EXP_MIN ?? "5");
const SESSION_EXP_HOURS = Number(process.env.ADMIN_JWT_EXP_HOURS ?? "1");

const CHALLENGE_AUDIENCE = "admin-challenge";
const SESSION_AUDIENCE = "admin-session";

export const SESSION_EXP_SECONDS = SESSION_EXP_HOURS * 60 * 60;

export interface ChallengeClaims extends JWTPayload {
  nonce: string;
  pool?: string;
  aud: typeof CHALLENGE_AUDIENCE;
}

export interface SessionClaims extends JWTPayload {
  sub: string; // admin pubkey
  pool?: string;
  aud: typeof SESSION_AUDIENCE;
}

export async function issueChallenge(nonce: string, pool?: string): Promise<string> {
  return await new SignJWT({ nonce, pool })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(CHALLENGE_AUDIENCE)
    .setExpirationTime(`${CHALLENGE_EXP_MIN}m`)
    .sign(getSecret());
}

export async function verifyChallenge(token: string): Promise<ChallengeClaims> {
  const { payload } = await jwtVerify(token, getSecret(), { audience: CHALLENGE_AUDIENCE });
  return payload as ChallengeClaims;
}

export async function issueSession(adminPubkey: string, pool?: string): Promise<string> {
  return await new SignJWT({ pool })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(adminPubkey)
    .setAudience(SESSION_AUDIENCE)
    .setExpirationTime(`${SESSION_EXP_HOURS}h`)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, getSecret(), { audience: SESSION_AUDIENCE });
  return payload as SessionClaims;
}
