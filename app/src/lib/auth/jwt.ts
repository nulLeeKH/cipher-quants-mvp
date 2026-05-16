// ============================================================================
// JWT helpers (HS256) — server-only
// ============================================================================
//
// JWT_SECRET MUST be provided via env (>= 16 chars). We fail fast on misuse
// rather than fall back to a public default — a leaked default secret means
// anyone can mint a valid admin session.
//
// Validation strategy:
//   - In production (`NODE_ENV === "production"`), the secret is validated at
//     module load (eager fail-fast → container exits at boot, not on first
//     auth request).
//   - In dev/test, validation is lazy so unrelated tooling (e.g. typecheck,
//     contributors without admin features wired up) doesn't trip over a
//     missing secret.
//   - Callers that need an explicit "verify before serving" check can call
//     `assertJwtSecretValid()` (e.g. from middleware or a healthcheck).

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

let cachedSecret: Uint8Array | null = null;

function loadAndValidateSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 16) {
    throw new Error(
      "JWT_SECRET environment variable is required (min 16 characters). " +
        "Set it in app/.env.local before starting the server."
    );
  }
  return new TextEncoder().encode(raw);
}

/**
 * Explicit assertion entry point. Call this from middleware / startup-side
 * code to fail fast outside of a request handler.
 */
export function assertJwtSecretValid(): void {
  if (cachedSecret) return;
  cachedSecret = loadAndValidateSecret();
}

function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  cachedSecret = loadAndValidateSecret();
  return cachedSecret;
}

// Production eager-validate: surfaces missing/short JWT_SECRET at container
// boot rather than on the first authenticated request.
if (process.env.NODE_ENV === "production") {
  assertJwtSecretValid();
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
