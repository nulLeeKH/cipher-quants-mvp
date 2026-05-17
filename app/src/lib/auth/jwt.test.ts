/**
 * @jest-environment node
 */
// JWT helper tests. The module reads process.env.JWT_SECRET — set it before
// importing. `jose` ships an ESM-only browser bundle that jsdom resolves to;
// the node env picks up jose's CJS build cleanly.

describe("auth/jwt — issue/verify round-trips", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = "test-secret-with-enough-length-1234";
    (process.env as Record<string, string | undefined>).NODE_ENV = undefined;
  });

  it("issue + verify challenge token", async () => {
    const { issueChallenge, verifyChallenge } = require("./jwt");
    const token = await issueChallenge("nonce-abc", "pool-xyz");
    const claims = await verifyChallenge(token);
    expect(claims.nonce).toBe("nonce-abc");
    expect(claims.pool).toBe("pool-xyz");
    expect(claims.aud).toBe("admin-challenge");
  });

  it("issue + verify session token", async () => {
    const { issueSession, verifySession } = require("./jwt");
    const token = await issueSession("admin-pubkey", "pool-xyz");
    const claims = await verifySession(token);
    expect(claims.sub).toBe("admin-pubkey");
    expect(claims.pool).toBe("pool-xyz");
    expect(claims.aud).toBe("admin-session");
  });

  it("verifyChallenge rejects a session token (aud mismatch)", async () => {
    const { issueSession, verifyChallenge } = require("./jwt");
    const session = await issueSession("admin", "p");
    await expect(verifyChallenge(session)).rejects.toThrow();
  });

  it("verifySession rejects a challenge token (aud mismatch)", async () => {
    const { issueChallenge, verifySession } = require("./jwt");
    const ch = await issueChallenge("n", "p");
    await expect(verifySession(ch)).rejects.toThrow();
  });

  it("verify rejects a token signed with a different secret", async () => {
    const { issueSession } = require("./jwt");
    const token = await issueSession("admin");
    // Switch the secret and re-require.
    jest.resetModules();
    process.env.JWT_SECRET = "a-different-secret-that-is-long-enough";
    const { verifySession } = require("./jwt");
    await expect(verifySession(token)).rejects.toThrow();
  });

  it("assertJwtSecretValid throws when secret missing", () => {
    jest.resetModules();
    delete process.env.JWT_SECRET;
    const { assertJwtSecretValid } = require("./jwt");
    expect(() => assertJwtSecretValid()).toThrow(/JWT_SECRET/);
  });

  it("assertJwtSecretValid throws when secret too short (<16)", () => {
    jest.resetModules();
    process.env.JWT_SECRET = "tooshort";
    const { assertJwtSecretValid } = require("./jwt");
    expect(() => assertJwtSecretValid()).toThrow(/16 characters/);
  });

  it("issueSession honors the SESSION_EXP_HOURS env", async () => {
    jest.resetModules();
    process.env.JWT_SECRET = "test-secret-with-enough-length-1234";
    process.env.ADMIN_JWT_EXP_HOURS = "2";
    const { issueSession, verifySession, SESSION_EXP_SECONDS } = require("./jwt");
    expect(SESSION_EXP_SECONDS).toBe(2 * 60 * 60);
    const tok = await issueSession("admin");
    const c = await verifySession(tok);
    if (typeof c.exp !== "number") throw new Error("exp missing");
    // exp - iat should be ~ 2 h (within a few seconds).
    expect(c.exp - (c.iat as number)).toBe(2 * 60 * 60);
  });
});
