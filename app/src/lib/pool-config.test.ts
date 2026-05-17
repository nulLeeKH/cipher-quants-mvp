/**
 * @jest-environment node
 */
// pool-config reads env at module load. Test by re-requiring with different
// process.env states. Because Next.js inlines NEXT_PUBLIC_ at build time we
// can mutate process.env here in tests.
//
// `@solana/web3.js` ships an ESM browser bundle that jsdom resolves to;
// running this file in `node` env sidesteps the transform mess.

describe("POOL_CONFIG / API_BASE_URL — env-driven", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("returns nulls when NEXT_PUBLIC_*_MINT envs are unset", () => {
    delete process.env.NEXT_PUBLIC_BASE_MINT;
    delete process.env.NEXT_PUBLIC_QUOTE_MINT;
    const { POOL_CONFIG } = require("./pool-config");
    expect(POOL_CONFIG.baseMint).toBeNull();
    expect(POOL_CONFIG.quoteMint).toBeNull();
  });

  it("parses valid pubkeys", () => {
    process.env.NEXT_PUBLIC_BASE_MINT = "So11111111111111111111111111111111111111112";
    process.env.NEXT_PUBLIC_QUOTE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const { POOL_CONFIG } = require("./pool-config");
    expect(POOL_CONFIG.baseMint!.toBase58()).toBe(
      "So11111111111111111111111111111111111111112",
    );
    expect(POOL_CONFIG.quoteMint!.toBase58()).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  it("silently returns null for malformed pubkey env values", () => {
    process.env.NEXT_PUBLIC_BASE_MINT = "not-a-pubkey";
    delete process.env.NEXT_PUBLIC_QUOTE_MINT;
    const { POOL_CONFIG } = require("./pool-config");
    expect(POOL_CONFIG.baseMint).toBeNull();
  });

  it("API_BASE_URL defaults to localhost when unset", () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    const { API_BASE_URL } = require("./pool-config");
    expect(API_BASE_URL).toBe("http://localhost:8080");
  });

  it("API_BASE_URL respects env override", () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.com";
    const { API_BASE_URL } = require("./pool-config");
    expect(API_BASE_URL).toBe("https://api.example.com");
  });
});
