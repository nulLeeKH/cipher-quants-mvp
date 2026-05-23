// ============================================================================
// Hand-rolled Borsh codecs
// ============================================================================
// Mirrors programs/protocol/src/state/* + events.rs. The Rust side uses the
// `borsh` crate (1.5 dialect, little-endian, no length prefix on fixed arrays);
// the codecs below produce byte-identical output, validated by the golden-bytes
// test in tests/protocol.test.ts.
//
// We hand-roll rather than depending on the `borsh` npm package because:
//   1. We need to interop with `Address(pub(crate) [u8; 32])` from
//      `solana-address` 2.x, which on the wire is just 32 raw bytes. The npm
//      `borsh` package wants a class registry to deserialize fixed structs,
//      adding boilerplate for every account type.
//   2. Buffer size is bounded and known per type, so a 60-line LE reader
//      ships with the SDK instead of the ~30KB `borsh` npm bundle.
// ============================================================================

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// ----------------------------------------------------------------------------
// Low-level cursor reader / writer
// ----------------------------------------------------------------------------

export class Reader {
  private view: DataView;
  private offset = 0;

  constructor(public readonly buffer: Uint8Array) {
    this.view = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );
  }

  get position(): number {
    return this.offset;
  }

  remaining(): number {
    return this.buffer.byteLength - this.offset;
  }

  requireRemaining(n: number, what: string): void {
    if (this.remaining() < n) {
      throw new Error(
        `Borsh decode underflow: need ${n} bytes for ${what}, have ${this.remaining()}`
      );
    }
  }

  u8(): number {
    this.requireRemaining(1, "u8");
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    this.requireRemaining(2, "u16");
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.requireRemaining(4, "u32");
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): BN {
    this.requireRemaining(8, "u64");
    // BN is constructed from a LE byte array so we slice + use `le` endianness.
    const slice = this.buffer.subarray(this.offset, this.offset + 8);
    this.offset += 8;
    return new BN(slice, "le");
  }

  pubkey(): PublicKey {
    this.requireRemaining(32, "pubkey");
    const slice = this.buffer.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(slice);
  }

  bytes(n: number): Uint8Array {
    this.requireRemaining(n, `bytes(${n})`);
    const slice = this.buffer.slice(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  skip(n: number): void {
    this.requireRemaining(n, "skip");
    this.offset += n;
  }
}

export class Writer {
  private chunks: number[] = [];

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) {
      throw new Error(`u8 out of range: ${v}`);
    }
    this.chunks.push(v);
    return this;
  }

  u16(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new Error(`u16 out of range: ${v}`);
    }
    this.chunks.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }

  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
      throw new Error(`u32 out of range: ${v}`);
    }
    this.chunks.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    return this;
  }

  u64(v: BN | bigint | number): this {
    const bn = BN.isBN(v) ? v : new BN(typeof v === "bigint" ? v.toString() : v);
    if (bn.isNeg() || bn.bitLength() > 64) {
      throw new Error(`u64 out of range: ${bn.toString()}`);
    }
    const bytes = bn.toArrayLike(Buffer, "le", 8);
    for (let i = 0; i < 8; i++) this.chunks.push(bytes[i]);
    return this;
  }

  pubkey(p: PublicKey): this {
    const bytes = p.toBytes();
    for (let i = 0; i < 32; i++) this.chunks.push(bytes[i]);
    return this;
  }

  bytes(b: Uint8Array): this {
    for (let i = 0; i < b.length; i++) this.chunks.push(b[i]);
    return this;
  }

  finish(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

// ----------------------------------------------------------------------------
// State structs
// ----------------------------------------------------------------------------

export interface DepthParamsData {
  depthCoefBps: number;
  sizeUnit: BN;
  maxDepthBps: number;
}

export interface SkewParamsData {
  targetBaseBps: number;
  skewCoefBps: number;
  maxSkewOffsetBps: number;
}

function readDepthParams(r: Reader): DepthParamsData {
  const depthCoefBps = r.u32();
  const sizeUnit = r.u64();
  const maxDepthBps = r.u16();
  r.skip(6); // _reserved
  return { depthCoefBps, sizeUnit, maxDepthBps };
}

function writeDepthParams(w: Writer, p: DepthParamsData): void {
  w.u32(p.depthCoefBps);
  w.u64(p.sizeUnit);
  w.u16(p.maxDepthBps);
  for (let i = 0; i < 6; i++) w.u8(0); // _reserved
}

function readSkewParams(r: Reader): SkewParamsData {
  const targetBaseBps = r.u16();
  const skewCoefBps = r.u16();
  const maxSkewOffsetBps = r.u16();
  r.skip(10); // _reserved
  return { targetBaseBps, skewCoefBps, maxSkewOffsetBps };
}

function writeSkewParams(w: Writer, s: SkewParamsData): void {
  w.u16(s.targetBaseBps);
  w.u16(s.skewCoefBps);
  w.u16(s.maxSkewOffsetBps);
  for (let i = 0; i < 10; i++) w.u8(0); // _reserved
}

// ----------------------------------------------------------------------------
// PoolState
// ----------------------------------------------------------------------------
// Account size = 8 (disc) + 323 (body). See programs/protocol/src/state/pool.rs.
//
// The decoder reads the first 259 body bytes (6 pubkeys + scalars + depth +
// skew + slot + nonce + 5×u8) and ignores the trailing 64-byte `_reserved`
// slot. Buffers must be at least 8 + 259 bytes; on-chain always allocates
// the full 8 + 323.

const POOL_STATE_BODY_BYTES = 323;
const POOL_STATE_MIN_READABLE = 291; // bytes actually consumed by the decoder

export const POOL_STATE_DISCRIMINATOR: Uint8Array = new Uint8Array([
  0x01, 0, 0, 0, 0, 0, 0, 0,
]);

export interface PoolStateData {
  admin: PublicKey;
  authorizedOracleSigner: PublicKey;
  /** ed25519 signer used for RFQ quote messages. Separate hot key from
   *  authorizedOracleSigner so a compromise of the api server doesn't leak
   *  the on-chain push capability. Rotated via rotate_quote_signer. */
  authorizedQuoteSigner: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  fairValue: BN;
  spreadBps: number;
  depthCurveParams: DepthParamsData;
  inventorySkewParams: SkewParamsData;
  lastOracleUpdateSlot: BN;
  oracleNonce: BN;
  currentModeTtl: number;
  bump: number;
  baseVaultBump: number;
  quoteVaultBump: number;
  paused: boolean;
}

export function decodePoolState(data: Uint8Array): PoolStateData {
  if (data.length < 8 + POOL_STATE_MIN_READABLE) {
    throw new Error(
      `PoolState: data too short (${data.length} < ${8 + POOL_STATE_MIN_READABLE})`
    );
  }
  // Sanity-check that the on-chain allocation matched the expected total
  // (allows future _reserved expansions without breaking older buffers).
  if (data.length === 8 + 232) {
    throw new Error(
      `PoolState: data length ${data.length} matches the obsolete 232-byte body — ` +
        `please redeploy with the corrected ${POOL_STATE_BODY_BYTES}-byte layout.`
    );
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== POOL_STATE_DISCRIMINATOR[i]) {
      throw new Error("PoolState: discriminator mismatch");
    }
  }
  const r = new Reader(data.subarray(8));
  const admin = r.pubkey();
  const authorizedOracleSigner = r.pubkey();
  const authorizedQuoteSigner = r.pubkey();
  const baseMint = r.pubkey();
  const quoteMint = r.pubkey();
  const baseVault = r.pubkey();
  const quoteVault = r.pubkey();
  const fairValue = r.u64();
  const spreadBps = r.u16();
  const depthCurveParams = readDepthParams(r);
  const inventorySkewParams = readSkewParams(r);
  const lastOracleUpdateSlot = r.u64();
  const oracleNonce = r.u64();
  const currentModeTtl = r.u8();
  const bump = r.u8();
  const baseVaultBump = r.u8();
  const quoteVaultBump = r.u8();
  const pausedRaw = r.u8();
  // _reserved[32] left unread.

  return {
    admin,
    authorizedOracleSigner,
    authorizedQuoteSigner,
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    fairValue,
    spreadBps,
    depthCurveParams,
    inventorySkewParams,
    lastOracleUpdateSlot,
    oracleNonce,
    currentModeTtl,
    bump,
    baseVaultBump,
    quoteVaultBump,
    paused: pausedRaw !== 0,
  };
}

// ----------------------------------------------------------------------------
// QuoteNonceMarker
// ----------------------------------------------------------------------------

export const QUOTE_NONCE_MARKER_DISCRIMINATOR: Uint8Array = new Uint8Array([
  0x02, 0, 0, 0, 0, 0, 0, 0,
]);

export interface QuoteNonceMarkerData {
  pool: PublicKey;
  nonce: BN;
  expirySlot: BN;
  bump: number;
}

export function decodeQuoteNonceMarker(data: Uint8Array): QuoteNonceMarkerData {
  if (data.length < 8 + 56) {
    throw new Error(
      `QuoteNonceMarker: data too short (${data.length} < ${8 + 56})`
    );
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== QUOTE_NONCE_MARKER_DISCRIMINATOR[i]) {
      throw new Error("QuoteNonceMarker: discriminator mismatch");
    }
  }
  const r = new Reader(data.subarray(8));
  const pool = r.pubkey();
  const nonce = r.u64();
  const expirySlot = r.u64();
  const bump = r.u8();
  return { pool, nonce, expirySlot, bump };
}

// ----------------------------------------------------------------------------
// AdminRotationProposal
// ----------------------------------------------------------------------------

export const ADMIN_ROTATION_PROPOSAL_DISCRIMINATOR: Uint8Array = new Uint8Array([
  0x03, 0, 0, 0, 0, 0, 0, 0,
]);

export interface AdminRotationProposalData {
  pool: PublicKey;
  proposedBy: PublicKey;
  newAdmin: PublicKey;
  createdSlot: BN;
  bump: number;
}

export function decodeAdminRotationProposal(
  data: Uint8Array
): AdminRotationProposalData {
  if (data.length < 8 + 112) {
    throw new Error(
      `AdminRotationProposal: data too short (${data.length} < ${8 + 112})`
    );
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== ADMIN_ROTATION_PROPOSAL_DISCRIMINATOR[i]) {
      throw new Error("AdminRotationProposal: discriminator mismatch");
    }
  }
  const r = new Reader(data.subarray(8));
  const pool = r.pubkey();
  const proposedBy = r.pubkey();
  const newAdmin = r.pubkey();
  const createdSlot = r.u64();
  const bump = r.u8();
  return { pool, proposedBy, newAdmin, createdSlot, bump };
}

// ----------------------------------------------------------------------------
// Instruction arg encoders
// ----------------------------------------------------------------------------
//
// These match the Rust `#[derive(BorshDeserialize)] struct XArgs` in each
// instruction handler. The on-chain dispatcher reads:
//
//   instruction_data[0]    : 1-byte tag (see INSTRUCTION_TAG_*)
//   instruction_data[1..]  : Borsh-encoded XArgs
//
// We write tag + args concatenated, in this order.

export const INSTRUCTION_TAG_INIT_POOL = 0;
export const INSTRUCTION_TAG_UPDATE_ORACLE = 1;
export const INSTRUCTION_TAG_EXECUTE_SWAP = 2;
export const INSTRUCTION_TAG_SET_PAUSED = 3;
export const INSTRUCTION_TAG_ROTATE_ORACLE_SIGNER = 4;
export const INSTRUCTION_TAG_ROTATE_ADMIN = 5;
export const INSTRUCTION_TAG_ADMIN_WITHDRAW_INVENTORY = 6;
export const INSTRUCTION_TAG_CLOSE_EXPIRED_NONCE = 7;
export const INSTRUCTION_TAG_PROPOSE_ADMIN = 8;
export const INSTRUCTION_TAG_ACCEPT_ADMIN = 9;
export const INSTRUCTION_TAG_CANCEL_ADMIN_PROPOSAL = 10;
export const INSTRUCTION_TAG_ROTATE_QUOTE_SIGNER = 11;

export interface InitPoolArgs {
  authorizedOracleSigner: PublicKey;
  /** RFQ ed25519 signer. Required. Set equal to `authorizedOracleSigner` for
   *  the PoC same-key default; production should pass a distinct key. */
  authorizedQuoteSigner: PublicKey;
  initialFairValue: BN;
  initialSpreadBps: number;
  initialDepthParams: DepthParamsData;
  initialSkewParams: SkewParamsData;
  initialModeTtl: number;
}

export function encodeInitPool(args: InitPoolArgs): Uint8Array {
  const w = new Writer();
  w.u8(INSTRUCTION_TAG_INIT_POOL);
  w.pubkey(args.authorizedOracleSigner);
  w.pubkey(args.authorizedQuoteSigner);
  w.u64(args.initialFairValue);
  w.u16(args.initialSpreadBps);
  writeDepthParams(w, args.initialDepthParams);
  writeSkewParams(w, args.initialSkewParams);
  w.u8(args.initialModeTtl);
  return w.finish();
}

export interface UpdateOracleArgs {
  newFairValue: BN;
  newSpreadBps: number;
  newDepthParams: DepthParamsData;
  newSkewParams: SkewParamsData;
  newNonce: BN;
  newTtl: number;
}

export function encodeUpdateOracle(args: UpdateOracleArgs): Uint8Array {
  const w = new Writer();
  w.u8(INSTRUCTION_TAG_UPDATE_ORACLE);
  w.u64(args.newFairValue);
  w.u16(args.newSpreadBps);
  writeDepthParams(w, args.newDepthParams);
  writeSkewParams(w, args.newSkewParams);
  w.u64(args.newNonce);
  w.u8(args.newTtl);
  return w.finish();
}

// ExecuteSwap. `Side` is a 1-byte Borsh enum (Buy=0, Sell=1). The optional
// `signed_quote_opt` is a Borsh `Option<SignedQuote>` — 1-byte tag (0=None,
// 1=Some) followed by the SignedQuote body if Some.

export type Side = "buy" | "sell";

export interface SignedQuoteArg {
  pool: PublicKey;
  user: PublicKey;
  direction: Side;
  inputAmount: BN;
  price: BN;
  expirySlot: BN;
  nonce: BN;
  signature: number[] | Uint8Array; // 64 bytes
}

export interface ExecuteSwapArgs {
  inputAmount: BN;
  direction: Side;
  minOutput: BN;
  signedQuote: SignedQuoteArg | null;
}

function writeSide(w: Writer, s: Side): void {
  w.u8(s === "buy" ? 0 : 1);
}

function writeSignedQuote(w: Writer, q: SignedQuoteArg): void {
  w.pubkey(q.pool);
  w.pubkey(q.user);
  writeSide(w, q.direction);
  w.u64(q.inputAmount);
  w.u64(q.price);
  w.u64(q.expirySlot);
  w.u64(q.nonce);
  if (q.signature.length !== 64) {
    throw new Error(`signature must be 64 bytes, got ${q.signature.length}`);
  }
  const sig =
    q.signature instanceof Uint8Array ? q.signature : Uint8Array.from(q.signature);
  w.bytes(sig);
}

export function encodeExecuteSwap(args: ExecuteSwapArgs): Uint8Array {
  const w = new Writer();
  w.u8(INSTRUCTION_TAG_EXECUTE_SWAP);
  w.u64(args.inputAmount);
  writeSide(w, args.direction);
  w.u64(args.minOutput);
  if (args.signedQuote) {
    w.u8(1); // Option::Some
    writeSignedQuote(w, args.signedQuote);
  } else {
    w.u8(0); // Option::None
  }
  return w.finish();
}

export function encodeSetPaused(paused: boolean): Uint8Array {
  return new Writer().u8(INSTRUCTION_TAG_SET_PAUSED).u8(paused ? 1 : 0).finish();
}

export function encodeRotateOracleSigner(
  newAuthorizedOracleSigner: PublicKey
): Uint8Array {
  return new Writer()
    .u8(INSTRUCTION_TAG_ROTATE_ORACLE_SIGNER)
    .pubkey(newAuthorizedOracleSigner)
    .finish();
}

export function encodeRotateAdmin(newAdmin: PublicKey): Uint8Array {
  return new Writer().u8(INSTRUCTION_TAG_ROTATE_ADMIN).pubkey(newAdmin).finish();
}

export function encodeAdminWithdrawInventory(args: {
  withdrawBaseAmount: BN;
  withdrawQuoteAmount: BN;
}): Uint8Array {
  return new Writer()
    .u8(INSTRUCTION_TAG_ADMIN_WITHDRAW_INVENTORY)
    .u64(args.withdrawBaseAmount)
    .u64(args.withdrawQuoteAmount)
    .finish();
}

export function encodeCloseExpiredNonce(): Uint8Array {
  return new Writer().u8(INSTRUCTION_TAG_CLOSE_EXPIRED_NONCE).finish();
}

export function encodeProposeAdmin(newAdmin: PublicKey): Uint8Array {
  return new Writer()
    .u8(INSTRUCTION_TAG_PROPOSE_ADMIN)
    .pubkey(newAdmin)
    .finish();
}

export function encodeAcceptAdmin(): Uint8Array {
  return new Writer().u8(INSTRUCTION_TAG_ACCEPT_ADMIN).finish();
}

export function encodeCancelAdminProposal(): Uint8Array {
  return new Writer().u8(INSTRUCTION_TAG_CANCEL_ADMIN_PROPOSAL).finish();
}

export function encodeRotateQuoteSigner(
  newAuthorizedQuoteSigner: PublicKey
): Uint8Array {
  return new Writer()
    .u8(INSTRUCTION_TAG_ROTATE_QUOTE_SIGNER)
    .pubkey(newAuthorizedQuoteSigner)
    .finish();
}
