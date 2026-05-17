import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import { Reader, Writer } from "./borsh.js";

describe("Writer / Reader round-trip", () => {
  it("u8", () => {
    const w = new Writer();
    w.u8(0);
    w.u8(255);
    const r = new Reader(w.finish());
    expect(r.u8()).toBe(0);
    expect(r.u8()).toBe(255);
  });

  it("u16 little-endian", () => {
    const w = new Writer();
    w.u16(0x0102);
    const bytes = w.finish();
    expect(Array.from(bytes)).toEqual([0x02, 0x01]);
    expect(new Reader(bytes).u16()).toBe(0x0102);
  });

  it("u32 little-endian", () => {
    const w = new Writer();
    w.u32(0x01020304);
    const bytes = w.finish();
    expect(Array.from(bytes)).toEqual([0x04, 0x03, 0x02, 0x01]);
    expect(new Reader(bytes).u32()).toBe(0x01020304);
  });

  it("u64 via BN (LE)", () => {
    const w = new Writer();
    w.u64(new BN("0807060504030201", 16));
    const bytes = w.finish();
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = new Reader(bytes).u64();
    expect(out.toString(16)).toBe("807060504030201");
  });

  it("pubkey is a 32-byte raw write", () => {
    const pk = new PublicKey(new Uint8Array(32).map((_, i) => i + 1));
    const w = new Writer();
    w.pubkey(pk);
    const bytes = w.finish();
    expect(bytes.length).toBe(32);
    expect(new Reader(bytes).pubkey().equals(pk)).toBe(true);
  });

  it("fixed-size byte array (no length prefix)", () => {
    const data = new Uint8Array([10, 20, 30]);
    const w = new Writer();
    w.bytes(data);
    const bytes = w.finish();
    expect(bytes.length).toBe(3);
    expect(Array.from(new Reader(bytes).bytes(3))).toEqual([10, 20, 30]);
  });
});

describe("Writer — input validation", () => {
  it("u8 rejects out-of-range", () => {
    expect(() => new Writer().u8(-1)).toThrow();
    expect(() => new Writer().u8(256)).toThrow();
  });

  it("u16 rejects out-of-range", () => {
    expect(() => new Writer().u16(-1)).toThrow();
    expect(() => new Writer().u16(65536)).toThrow();
  });

  it("u32 rejects out-of-range", () => {
    expect(() => new Writer().u32(-1)).toThrow();
    expect(() => new Writer().u32(2 ** 32)).toThrow();
  });
});

describe("Reader — bounds checking", () => {
  it("u8 underflow throws", () => {
    expect(() => new Reader(new Uint8Array(0)).u8()).toThrow();
  });

  it("u16/u32/u64 underflow throws", () => {
    expect(() => new Reader(new Uint8Array(1)).u16()).toThrow();
    expect(() => new Reader(new Uint8Array(3)).u32()).toThrow();
    expect(() => new Reader(new Uint8Array(7)).u64()).toThrow();
  });

  it("pubkey underflow throws", () => {
    expect(() => new Reader(new Uint8Array(31)).pubkey()).toThrow();
  });
});
