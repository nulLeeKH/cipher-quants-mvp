import { formatChallengeMessage } from "./message";

describe("formatChallengeMessage — deterministic, server-reconstructable", () => {
  it("includes pubkey + nonce + issued + pool", () => {
    const msg = formatChallengeMessage({
      nonce: "abc123",
      pool: "PoolAddr11111111111111111111111111111111111",
      pubkey: "AdminAddr11111111111111111111111111111111111",
      issuedAt: "2026-05-17T00:00:00.000Z",
    });
    expect(msg).toContain("Cipher Quants — Admin sign-in");
    expect(msg).toContain("Pubkey: AdminAddr11111111111111111111111111111111111");
    expect(msg).toContain("Pool: PoolAddr11111111111111111111111111111111111");
    expect(msg).toContain("Nonce: abc123");
    expect(msg).toContain("Issued: 2026-05-17T00:00:00.000Z");
    expect(msg).toContain("Sign this message to authenticate");
  });

  it("omits the Pool line when pool not provided", () => {
    const msg = formatChallengeMessage({
      nonce: "n",
      pubkey: "P",
      issuedAt: "T",
    });
    expect(msg).not.toContain("Pool:");
  });

  it("identical inputs → identical output (deterministic)", () => {
    const args = { nonce: "n", pubkey: "P", issuedAt: "T", pool: "X" };
    expect(formatChallengeMessage(args)).toBe(formatChallengeMessage(args));
  });
});
