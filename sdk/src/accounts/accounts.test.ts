import { PublicKey } from "@solana/web3.js";

import {
  derivePoolState,
  deriveQuoteNonceMarker,
  deriveVault,
  deriveAdminProposal,
  sortMints,
} from "./index.js";
import { PROGRAM_ID } from "../program.js";

describe("PDA derivation — deterministic + matches expected seed shape", () => {
  const mintA = new PublicKey(new Uint8Array(32).fill(0x01));
  const mintB = new PublicKey(new Uint8Array(32).fill(0x02));

  it("derivePoolState — same inputs yield same address + bump", () => {
    const [pdaA, bumpA] = derivePoolState(mintA, mintB);
    const [pdaB, bumpB] = derivePoolState(mintA, mintB);
    expect(pdaA.equals(pdaB)).toBe(true);
    expect(bumpA).toBe(bumpB);
  });

  it("derivePoolState — order matters (base ≠ quote)", () => {
    const [a] = derivePoolState(mintA, mintB);
    const [b] = derivePoolState(mintB, mintA);
    expect(a.equals(b)).toBe(false);
  });

  it("deriveVault — pool/mint composition", () => {
    const [pool] = derivePoolState(mintA, mintB);
    const [v1] = deriveVault(pool, mintA);
    const [v2] = deriveVault(pool, mintB);
    expect(v1.equals(v2)).toBe(false);
  });

  it("deriveQuoteNonceMarker — nonce LE encoding produces distinct PDAs per nonce", () => {
    const [pool] = derivePoolState(mintA, mintB);
    const [m1] = deriveQuoteNonceMarker(pool, 1n);
    const [m2] = deriveQuoteNonceMarker(pool, 2n);
    const [m1b] = deriveQuoteNonceMarker(pool, 1n);
    expect(m1.equals(m2)).toBe(false);
    expect(m1.equals(m1b)).toBe(true);
  });

  it("deriveAdminProposal — single PDA per pool (no proposal index)", () => {
    const [pool] = derivePoolState(mintA, mintB);
    const [p1, b1] = deriveAdminProposal(pool);
    const [p2, b2] = deriveAdminProposal(pool);
    expect(p1.equals(p2)).toBe(true);
    expect(b1).toBe(b2);
  });

  it("PDA helpers respect a custom program id override", () => {
    const otherProgram = new PublicKey(new Uint8Array(32).fill(0xff));
    const [defaultPda] = derivePoolState(mintA, mintB);
    const [overriddenPda] = derivePoolState(mintA, mintB, otherProgram);
    expect(defaultPda.equals(overriddenPda)).toBe(false);
    expect(defaultPda.equals(derivePoolState(mintA, mintB, PROGRAM_ID)[0])).toBe(true);
  });
});

describe("sortMints — cross-runtime lexicographic comparison (no Buffer.compare)", () => {
  it("returns inputs unchanged when first < second", () => {
    const a = new PublicKey(new Uint8Array(32).fill(0x01));
    const b = new PublicKey(new Uint8Array(32).fill(0x02));
    const [base, quote] = sortMints(a, b);
    expect(base.equals(a)).toBe(true);
    expect(quote.equals(b)).toBe(true);
  });

  it("swaps when first > second", () => {
    const a = new PublicKey(new Uint8Array(32).fill(0x02));
    const b = new PublicKey(new Uint8Array(32).fill(0x01));
    const [base, quote] = sortMints(a, b);
    expect(base.equals(b)).toBe(true);
    expect(quote.equals(a)).toBe(true);
  });

  it("differentiates on the first differing byte", () => {
    const a = new PublicKey(new Uint8Array(32).map((_, i) => (i === 5 ? 0x10 : 0x05)));
    const b = new PublicKey(new Uint8Array(32).map((_, i) => (i === 5 ? 0x20 : 0x05)));
    const [base] = sortMints(a, b);
    expect(base.equals(a)).toBe(true);
  });

  it("returns originals when bytes are equal (pubkey collision — caller must reject)", () => {
    const a = new PublicKey(new Uint8Array(32).fill(0x07));
    const b = new PublicKey(new Uint8Array(32).fill(0x07));
    const [base, quote] = sortMints(a, b);
    expect(base.equals(a)).toBe(true);
    expect(quote.equals(b)).toBe(true);
  });
});
