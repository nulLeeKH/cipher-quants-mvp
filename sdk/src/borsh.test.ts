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

// ============================================================================
// quote_signer split — new field coverage (PoolState body + InitPool args +
// rotate_quote_signer encoder).
// ============================================================================

import {
  decodePoolState,
  encodeInitPool,
  encodeRotateOracleSigner,
  encodeRotateQuoteSigner,
  INSTRUCTION_TAG_INIT_POOL,
  INSTRUCTION_TAG_ROTATE_QUOTE_SIGNER,
} from "./borsh.js";

const POOL_STATE_DISCRIMINATOR = new Uint8Array([0x01, 0, 0, 0, 0, 0, 0, 0]);

function makePoolStateBytes(opts: {
  admin: PublicKey;
  oracleSigner: PublicKey;
  quoteSigner: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  fairValue: bigint;
  spreadBps: number;
  paused: number;
}): Uint8Array {
  const w = new Writer();
  // 7 pubkeys
  w.pubkey(opts.admin);
  w.pubkey(opts.oracleSigner);
  w.pubkey(opts.quoteSigner);
  w.pubkey(opts.baseMint);
  w.pubkey(opts.quoteMint);
  w.pubkey(opts.baseVault);
  w.pubkey(opts.quoteVault);
  w.u64(new BN(opts.fairValue.toString()));
  w.u16(opts.spreadBps);
  // DepthParams (depth_coef_bps:u32, size_unit:u64, max_depth_bps:u16, reserved[6])
  const dummy = new Uint8Array(20);
  for (let i = 0; i < 20; i++) w.u8(dummy[i]);
  // SkewParams (target_base_bps:u16, skew_coef_bps:u16, max_skew_offset_bps:u16, reserved[10])
  const dummy2 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) w.u8(dummy2[i]);
  w.u64(new BN(0)); // last_oracle_update_slot
  w.u64(new BN(0)); // oracle_nonce
  w.u8(0); // current_mode_ttl
  w.u8(255); // bump
  w.u8(255); // base_vault_bump
  w.u8(255); // quote_vault_bump
  w.u8(opts.paused);
  // _reserved[32]
  for (let i = 0; i < 32; i++) w.u8(0);
  const body = w.finish();
  // prepend 8-byte discriminator
  const full = new Uint8Array(8 + body.length);
  full.set(POOL_STATE_DISCRIMINATOR, 0);
  full.set(body, 8);
  return full;
}

describe("decodePoolState — quote_signer split", () => {
  it("decodes authorizedQuoteSigner as a distinct field from authorizedOracleSigner", () => {
    const admin = new PublicKey("11111111111111111111111111111112");
    const oracle = new PublicKey("11111111111111111111111111111113");
    const quote = new PublicKey("11111111111111111111111111111114");
    const baseMint = new PublicKey("11111111111111111111111111111115");
    const quoteMint = new PublicKey("11111111111111111111111111111116");
    const baseVault = new PublicKey("11111111111111111111111111111117");
    const quoteVault = new PublicKey("11111111111111111111111111111118");
    const bytes = makePoolStateBytes({
      admin,
      oracleSigner: oracle,
      quoteSigner: quote,
      baseMint,
      quoteMint,
      baseVault,
      quoteVault,
      fairValue: 100_000_000n,
      spreadBps: 20,
      paused: 0,
    });
    const decoded = decodePoolState(bytes);
    expect(decoded.admin.toBase58()).toBe(admin.toBase58());
    expect(decoded.authorizedOracleSigner.toBase58()).toBe(oracle.toBase58());
    expect(decoded.authorizedQuoteSigner.toBase58()).toBe(quote.toBase58());
    expect(decoded.authorizedQuoteSigner.toBase58()).not.toBe(
      decoded.authorizedOracleSigner.toBase58()
    );
    expect(decoded.spreadBps).toBe(20);
    expect(decoded.fairValue.toString()).toBe("100000000");
    expect(decoded.paused).toBe(false);
  });
});

describe("encodeInitPool — quote_signer in payload", () => {
  it("writes oracle_signer then quote_signer (2 pubkeys = 64 bytes after tag)", () => {
    const oracle = new PublicKey("11111111111111111111111111111113");
    const quote = new PublicKey("11111111111111111111111111111114");
    const buf = encodeInitPool({
      authorizedOracleSigner: oracle,
      authorizedQuoteSigner: quote,
      initialFairValue: new BN(100_000_000),
      initialSpreadBps: 20,
      initialDepthParams: {
        depthCoefBps: 2,
        sizeUnit: new BN(1_000_000),
        maxDepthBps: 100,
        _reserved: [0, 0, 0, 0, 0, 0],
      } as any,
      initialSkewParams: {
        targetBaseBps: 5_000,
        skewCoefBps: 50,
        maxSkewOffsetBps: 100,
        _reserved: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      } as any,
      initialModeTtl: 0,
    });
    // [0] = ix tag
    expect(buf[0]).toBe(INSTRUCTION_TAG_INIT_POOL);
    // [1..33] = oracle pubkey
    const oracleBytes = buf.slice(1, 33);
    expect(Buffer.from(oracleBytes).equals(oracle.toBuffer())).toBe(true);
    // [33..65] = quote pubkey
    const quoteBytes = buf.slice(33, 65);
    expect(Buffer.from(quoteBytes).equals(quote.toBuffer())).toBe(true);
  });
});

describe("encodeRotateQuoteSigner", () => {
  it("emits ix tag 11 + pubkey (33 bytes total)", () => {
    const newKey = new PublicKey("11111111111111111111111111111114");
    const buf = encodeRotateQuoteSigner(newKey);
    expect(buf.length).toBe(33);
    expect(buf[0]).toBe(INSTRUCTION_TAG_ROTATE_QUOTE_SIGNER);
    expect(buf[0]).toBe(11);
    expect(Buffer.from(buf.slice(1)).equals(newKey.toBuffer())).toBe(true);
  });

  it("distinct from encodeRotateOracleSigner (different tag byte)", () => {
    const k = new PublicKey("11111111111111111111111111111114");
    const oracleBuf = encodeRotateOracleSigner(k);
    const quoteBuf = encodeRotateQuoteSigner(k);
    expect(oracleBuf[0]).toBe(4); // INSTRUCTION_TAG_ROTATE_ORACLE_SIGNER
    expect(quoteBuf[0]).toBe(11);
    // pubkey bytes identical
    expect(Buffer.from(oracleBuf.slice(1)).equals(Buffer.from(quoteBuf.slice(1)))).toBe(true);
  });
});
