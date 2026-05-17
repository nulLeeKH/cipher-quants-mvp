import { Keypair, PublicKey } from "@solana/web3.js";

import {
  buildSignedQuoteWithVerifyIx,
  serializeSignedQuoteMessage,
} from "./quote.js";
import { SIDE_BUY_TAG, SIDE_SELL_TAG } from "./constants/index.js";

describe("serializeSignedQuoteMessage — 97-byte canonical layout", () => {
  const pool = new PublicKey(new Uint8Array(32).fill(0x01));
  const user = new PublicKey(new Uint8Array(32).fill(0x02));

  it("produces exactly 97 bytes", () => {
    const out = serializeSignedQuoteMessage({
      pool,
      user,
      direction: "buy",
      inputAmount: 1n,
      price: 1n,
      expirySlot: 1n,
      nonce: 1n,
    });
    expect(out.length).toBe(97);
  });

  it("places pool / user / direction byte at correct offsets", () => {
    const out = serializeSignedQuoteMessage({
      pool,
      user,
      direction: "sell",
      inputAmount: 0n,
      price: 0n,
      expirySlot: 0n,
      nonce: 0n,
    });
    expect(Array.from(out.slice(0, 32))).toEqual(new Array(32).fill(0x01));
    expect(Array.from(out.slice(32, 64))).toEqual(new Array(32).fill(0x02));
    expect(out[64]).toBe(SIDE_SELL_TAG);
  });

  it("direction byte: buy → 0, sell → 1", () => {
    const buyOut = serializeSignedQuoteMessage({
      pool, user, direction: "buy",
      inputAmount: 0n, price: 0n, expirySlot: 0n, nonce: 0n,
    });
    const sellOut = serializeSignedQuoteMessage({
      pool, user, direction: "sell",
      inputAmount: 0n, price: 0n, expirySlot: 0n, nonce: 0n,
    });
    expect(buyOut[64]).toBe(SIDE_BUY_TAG);
    expect(sellOut[64]).toBe(SIDE_SELL_TAG);
  });

  it("u64 fields write little-endian at the canonical offsets", () => {
    const out = serializeSignedQuoteMessage({
      pool, user, direction: "buy",
      inputAmount: 0x0807060504030201n,
      price: 0x1817161514131211n,
      expirySlot: 0x2827262524232221n,
      nonce: 0x3837363534333231n,
    });
    expect(Array.from(out.slice(65, 73))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(out.slice(73, 81))).toEqual([0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18]);
    expect(Array.from(out.slice(81, 89))).toEqual([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28]);
    expect(Array.from(out.slice(89, 97))).toEqual([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38]);
  });

  it("rejects out-of-range u64 values", () => {
    const base = {
      pool, user, direction: "buy" as const,
      inputAmount: 0n, price: 0n, expirySlot: 0n, nonce: 0n,
    };
    expect(() => serializeSignedQuoteMessage({ ...base, inputAmount: -1n })).toThrow(/out of u64 range/);
    expect(() => serializeSignedQuoteMessage({ ...base, price: 1n << 64n })).toThrow(/out of u64 range/);
  });

  it("rejects non-bigint numeric fields (defensive against accidental Number)", () => {
    const base = { pool, user, direction: "buy" as const, price: 0n, expirySlot: 0n, nonce: 0n } as const;
    // deno-lint-ignore no-explicit-any
    expect(() => serializeSignedQuoteMessage({ ...base, inputAmount: 1 as any })).toThrow(/must be a bigint/);
  });
});

describe("buildSignedQuoteWithVerifyIx", () => {
  it("returns a 64-byte signature + matching message bytes", () => {
    const oracle = Keypair.generate();
    const pool = new PublicKey(new Uint8Array(32).fill(0x01));
    const user = new PublicKey(new Uint8Array(32).fill(0x02));
    const { signedQuote, verifyIx, messageBytes } = buildSignedQuoteWithVerifyIx(
      oracle,
      {
        pool,
        user,
        direction: "buy",
        inputAmount: 1_000n,
        price: 100_000_000n,
        expirySlot: 200n,
        nonce: 42n,
      },
    );
    expect(messageBytes.length).toBe(97);
    expect(signedQuote.signature.length).toBe(64);
    expect(verifyIx.programId.toBase58()).toBe("Ed25519SigVerify111111111111111111111111111");
  });

  it("signed quote echoes the input fields", () => {
    const oracle = Keypair.generate();
    const pool = new PublicKey(new Uint8Array(32).fill(0x03));
    const user = new PublicKey(new Uint8Array(32).fill(0x04));
    const { signedQuote } = buildSignedQuoteWithVerifyIx(oracle, {
      pool, user, direction: "sell",
      inputAmount: 7n, price: 8n, expirySlot: 9n, nonce: 10n,
    });
    expect(signedQuote.pool.equals(pool)).toBe(true);
    expect(signedQuote.user.equals(user)).toBe(true);
    expect(signedQuote.inputAmount.toString()).toBe("7");
    expect(signedQuote.price.toString()).toBe("8");
    expect(signedQuote.expirySlot.toString()).toBe("9");
    expect(signedQuote.nonce.toString()).toBe("10");
  });
});
