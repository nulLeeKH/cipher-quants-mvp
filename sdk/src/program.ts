// ============================================================================
// Program shim (Anchor-compatible surface on top of the Pinocchio dispatch)
// ============================================================================
// The on-chain program has dropped Anchor 0.32.1 for Pinocchio 0.11. The new
// dispatch uses a 1-byte tag + Borsh args instead of Anchor's 8-byte sighash.
//
// To minimize churn for downstream callers (keeper / api / app / tests), this
// module exposes the subset of the Anchor `Program` API they actually use:
//
//   program.methods.X(args...).accountsPartial({...}).signers([...]).rpc()
//   program.methods.X(...).instruction()
//   program.account.poolState.fetch(addr)
//   program.addEventListener(name, cb) / removeEventListener(id)
//   program.programId, program.provider
//
// Everything routes through the new dispatch internally. Callers don't need
// to know that Anchor is gone.

import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

import {
  decodeAdminRotationProposal,
  decodePoolState,
  decodeQuoteNonceMarker,
  encodeAcceptAdmin,
  encodeAdminWithdrawInventory,
  encodeCancelAdminProposal,
  encodeCloseExpiredNonce,
  encodeExecuteSwap,
  encodeInitPool,
  encodeProposeAdmin,
  encodeRotateAdmin,
  encodeRotateOracleSigner,
  encodeSetPaused,
  encodeUpdateOracle,
  type DepthParamsData,
  type PoolStateData,
  type QuoteNonceMarkerData,
  type AdminRotationProposalData,
  type Side,
  type SignedQuoteArg,
  type SkewParamsData,
} from "./borsh.js";
import {
  ADMIN_PROPOSAL_SEED,
  POOL_SEED,
  VAULT_SEED,
} from "./constants/index.js";
import { errorCodeToName } from "./errors.js";
import { decodeEventLog, type DecodedEvent, type ProtocolEventName } from "./events.js";

export const PROGRAM_ID: PublicKey = new PublicKey(
  "3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy"
);

// ----------------------------------------------------------------------------
// Provider-compatible types
// ----------------------------------------------------------------------------
// Anchor's `Wallet` / `AnchorProvider` interface is duck-typed here so callers
// can keep using their existing wallet adapters (`useAnchorWallet`, the keeper's
// `JsonFileKeypairProvider`, etc.) without re-typing.

export interface WalletLike {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction = Transaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction = Transaction>(
    txs: T[]
  ): Promise<T[]>;
  /** Optional — Anchor's Wallet exposes the secret key. Tests / keeper rely
   *  on it; pure user wallets (Phantom / Ledger) do not provide this. */
  readonly payer?: Keypair;
}

export interface ProviderLike {
  readonly connection: Connection;
  readonly wallet: WalletLike;
}

/** Minimal Anchor-shape Wallet wrapping a Keypair. */
export class Wallet implements WalletLike {
  constructor(public readonly payer: Keypair) {}
  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }
  async signTransaction<T extends Transaction = Transaction>(tx: T): Promise<T> {
    tx.partialSign(this.payer);
    return tx;
  }
  async signAllTransactions<T extends Transaction = Transaction>(
    txs: T[]
  ): Promise<T[]> {
    for (const tx of txs) tx.partialSign(this.payer);
    return txs;
  }
}

/** Minimal Anchor-shape provider — just bundles connection + wallet. */
export class AnchorProvider implements ProviderLike {
  constructor(
    public readonly connection: Connection,
    public readonly wallet: WalletLike,
    public readonly opts: { commitment?: string; preflightCommitment?: string } = {}
  ) {}

  static env(): AnchorProvider {
    // Test environment shim — keeper / api / app construct their own.
    throw new Error(
      "AnchorProvider.env() is not supported in the Pinocchio SDK. " +
        "Construct an AnchorProvider explicitly with (connection, wallet)."
    );
  }

  async sendAndConfirm(
    tx: Transaction,
    signers: Keypair[] = []
  ): Promise<string> {
    tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
    tx.recentBlockhash = (
      await this.connection.getLatestBlockhash("confirmed")
    ).blockhash;
    if (signers.length > 0) tx.partialSign(...signers);
    await this.wallet.signTransaction(tx);
    let sig: string;
    try {
      sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
    } catch (err) {
      throw enrichProgramError(err);
    }
    try {
      await this.connection.confirmTransaction(sig, "confirmed");
    } catch (err) {
      throw enrichProgramError(err);
    }
    return sig;
  }
}

/**
 * Annotate any `custom program error: 0x<hex>` mention with the ProtocolError
 * variant name so tests can keep matching on `.toThrow(/Name/)`. Anchor used
 * the IDL for this — we re-create it here.
 *
 * `@solana/web3.js`'s `SendTransactionError` exposes `message` + `logs` as
 * getter-only, so we can't mutate the original. Instead, when the message
 * contains a custom-error hex code, we throw a fresh `Error` whose message
 * already has the variant names interpolated and whose `logs` are likewise
 * annotated. The original error is attached via `cause` so the underlying
 * `SendTransactionError` is recoverable for callers that want to inspect it.
 *
 * If the input is not a recognised error shape (no custom-error hex anywhere),
 * the original is returned untouched.
 */
function enrichProgramError(err: unknown): unknown {
  if (err == null || typeof err !== "object") return err;
  const e = err as { message?: string; logs?: unknown };

  const HEX_RE = /custom program error:\s*0x([0-9a-fA-F]+)/g;
  const annotate = (s: string): string =>
    s.replace(HEX_RE, (full, hex: string) => {
      const code = parseInt(hex, 16);
      const name = errorCodeToName(code);
      return name ? `${full} (${name} = ${code})` : full;
    });

  const origMessage = typeof e.message === "string" ? e.message : "";
  const origLogs: string[] = Array.isArray(e.logs)
    ? (e.logs as unknown[]).filter((l): l is string => typeof l === "string")
    : [];

  const messageHasCode = HEX_RE.test(origMessage);
  HEX_RE.lastIndex = 0; // .test() leaves the lastIndex advanced.
  const anyLogHasCode = origLogs.some((l) => HEX_RE.test(l));
  HEX_RE.lastIndex = 0;
  if (!messageHasCode && !anyLogHasCode) return err;

  const newMessage = annotate(origMessage);
  const newLogs = origLogs.map(annotate);

  // Build a plain Error whose `.logs` is a regular property (not getter-only).
  // Tests use `.rejects.toThrow(/regex/)` which calls `String(error.message)`
  // — the annotated text is in newMessage so the assertion matches.
  const wrapped = new Error(newMessage);
  (wrapped as Error & { logs: string[]; cause: unknown }).logs = newLogs;
  (wrapped as Error & { logs: string[]; cause: unknown }).cause = err;
  return wrapped;
}

// ----------------------------------------------------------------------------
// PDA derivation helpers (re-imported by accounts/index.ts for back-compat)
// ----------------------------------------------------------------------------

export function derivePoolStatePda(
  baseMint: PublicKey,
  quoteMint: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_SEED, baseMint.toBuffer(), quoteMint.toBuffer()],
    programId
  );
}

export function deriveVaultPda(
  poolState: PublicKey,
  mint: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, poolState.toBuffer(), mint.toBuffer()],
    programId
  );
}

export function deriveAdminProposalPda(
  poolState: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ADMIN_PROPOSAL_SEED, poolState.toBuffer()],
    programId
  );
}

// ----------------------------------------------------------------------------
// Method builder
// ----------------------------------------------------------------------------
// Each method spec defines (a) the positional account names in order and
// (b) the optional defaults that `accountsPartial` should auto-fill.

interface AccountSpec {
  name: string;
  isSigner: boolean;
  isWritable: boolean;
  /** Auto-default this account if accountsPartial omits it. */
  default?: PublicKey;
}

class MethodBuilder {
  private accountMap: Record<string, PublicKey> = {};
  private extraSigners: Keypair[] = [];
  private preIxs: TransactionInstruction[] = [];
  private remaining: AccountMeta[] = [];

  constructor(
    private readonly program: Program,
    private readonly data: Uint8Array,
    private readonly spec: AccountSpec[]
  ) {}

  accountsPartial(map: Record<string, PublicKey>): this {
    for (const [k, v] of Object.entries(map)) {
      if (v) this.accountMap[k] = v;
    }
    return this;
  }

  /** Alias kept for callers ported from Anchor 0.30+ (`accounts({})`). */
  accounts(map: Record<string, PublicKey>): this {
    return this.accountsPartial(map);
  }

  signers(keys: Keypair[]): this {
    this.extraSigners.push(...keys);
    return this;
  }

  preInstructions(ixs: TransactionInstruction[]): this {
    this.preIxs.push(...ixs);
    return this;
  }

  remainingAccounts(metas: AccountMeta[]): this {
    this.remaining.push(...metas);
    return this;
  }

  private buildKeys(): AccountMeta[] {
    const keys: AccountMeta[] = [];
    for (const s of this.spec) {
      const pk = this.accountMap[s.name] ?? s.default;
      if (!pk) {
        throw new Error(
          `Missing required account "${s.name}" — pass it via .accountsPartial({...})`
        );
      }
      keys.push({ pubkey: pk, isSigner: s.isSigner, isWritable: s.isWritable });
    }
    keys.push(...this.remaining);
    return keys;
  }

  instruction(): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.program.programId,
      keys: this.buildKeys(),
      data: Buffer.from(this.data),
    });
  }

  async transaction(): Promise<Transaction> {
    const tx = new Transaction();
    for (const ix of this.preIxs) tx.add(ix);
    tx.add(this.instruction());
    return tx;
  }

  async rpc(): Promise<string> {
    const tx = await this.transaction();
    return this.program.provider.sendAndConfirm(tx, this.extraSigners);
  }
}

// ----------------------------------------------------------------------------
// Account namespace
// ----------------------------------------------------------------------------
// `program.account.poolState.fetch(addr)` etc. We don't enforce structural
// compat with Anchor's `ProgramAccount<T>` wrapper — just return the decoded
// data directly, which matches what every consumer reads.

interface AccountFetcher<T> {
  fetch(addr: PublicKey): Promise<T>;
  fetchNullable(addr: PublicKey): Promise<T | null>;
}

function makeAccountFetcher<T>(
  program: Program,
  decode: (data: Uint8Array) => T,
  name: string
): AccountFetcher<T> {
  return {
    async fetch(addr: PublicKey): Promise<T> {
      const acc = await program.provider.connection.getAccountInfo(addr, "confirmed");
      if (!acc) {
        throw new Error(`Account does not exist or has no data ${addr.toBase58()}`);
      }
      if (!acc.owner.equals(program.programId)) {
        throw new Error(
          `Account ${addr.toBase58()} is not owned by ${program.programId.toBase58()} (owner=${acc.owner.toBase58()})`
        );
      }
      try {
        return decode(new Uint8Array(acc.data));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to decode ${name} at ${addr.toBase58()}: ${msg}`);
      }
    },
    async fetchNullable(addr: PublicKey): Promise<T | null> {
      const acc = await program.provider.connection.getAccountInfo(addr, "confirmed");
      if (!acc) return null;
      if (!acc.owner.equals(program.programId)) return null;
      try {
        return decode(new Uint8Array(acc.data));
      } catch {
        return null;
      }
    },
  };
}

// ----------------------------------------------------------------------------
// Program — the public API
// ----------------------------------------------------------------------------

// The `_T` type parameter is unused at runtime — it's kept solely so existing
// Anchor-era callers can keep writing `Program<Protocol>` without a refactor.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class Program<_T = unknown> {
  public readonly programId: PublicKey;
  public readonly provider: AnchorProvider;
  public readonly account: {
    poolState: AccountFetcher<PoolStateData>;
    quoteNonceMarker: AccountFetcher<QuoteNonceMarkerData>;
    adminRotationProposal: AccountFetcher<AdminRotationProposalData>;
  };
  public readonly methods: {
    initPool: (
      authorizedOracleSigner: PublicKey,
      initialFairValue: BN,
      initialSpreadBps: number,
      initialDepthParams: DepthParamsData & { reserved?: number[] },
      initialSkewParams: SkewParamsData & { reserved?: number[] },
      initialModeTtl: number
    ) => MethodBuilder;
    updateOracle: (
      newFairValue: BN,
      newSpreadBps: number,
      newDepthParams: DepthParamsData & { reserved?: number[] },
      newSkewParams: SkewParamsData & { reserved?: number[] },
      newNonce: BN,
      newTtl: number
    ) => MethodBuilder;
    executeSwap: (
      inputAmount: BN,
      direction: SideArg | Side,
      minOutput: BN,
      signedQuote: SignedQuoteArgIxArg | null
    ) => MethodBuilder;
    setPaused: (paused: boolean) => MethodBuilder;
    rotateOracleSigner: (newAuthorizedOracleSigner: PublicKey) => MethodBuilder;
    rotateAdmin: (newAdmin: PublicKey) => MethodBuilder;
    adminWithdrawInventory: (
      withdrawBaseAmount: BN,
      withdrawQuoteAmount: BN
    ) => MethodBuilder;
    closeExpiredNonce: () => MethodBuilder;
    proposeAdmin: (newAdmin: PublicKey) => MethodBuilder;
    acceptAdmin: () => MethodBuilder;
    cancelAdminProposal: () => MethodBuilder;
  };

  /** Event listeners (in-memory subscription registry). */
  private listeners = new Map<
    number,
    { name: ProtocolEventName; cb: (data: unknown, slot: number, sig: string) => void; logsSubId: number }
  >();
  private nextListenerId = 1;

  constructor(provider: AnchorProvider, programId: PublicKey = PROGRAM_ID) {
    this.provider = provider;
    this.programId = programId;

    this.account = {
      poolState: makeAccountFetcher(this, decodePoolState, "PoolState"),
      quoteNonceMarker: makeAccountFetcher(
        this,
        decodeQuoteNonceMarker,
        "QuoteNonceMarker"
      ),
      adminRotationProposal: makeAccountFetcher(
        this,
        decodeAdminRotationProposal,
        "AdminRotationProposal"
      ),
    };

    this.methods = {
      initPool: (oracleSigner, fairValue, spreadBps, depth, skew, ttl) =>
        new MethodBuilder(
          this,
          encodeInitPool({
            authorizedOracleSigner: oracleSigner,
            initialFairValue: fairValue,
            initialSpreadBps: spreadBps,
            initialDepthParams: stripReserved(depth),
            initialSkewParams: stripReserved(skew),
            initialModeTtl: ttl,
          }),
          [
            { name: "admin", isSigner: true, isWritable: true },
            { name: "poolState", isSigner: false, isWritable: true },
            { name: "baseMint", isSigner: false, isWritable: false },
            { name: "quoteMint", isSigner: false, isWritable: false },
            { name: "baseVault", isSigner: false, isWritable: true },
            { name: "quoteVault", isSigner: false, isWritable: true },
            {
              name: "tokenProgram",
              isSigner: false,
              isWritable: false,
              default: TOKEN_PROGRAM_ID,
            },
            {
              name: "systemProgram",
              isSigner: false,
              isWritable: false,
              default: SystemProgram.programId,
            },
            {
              name: "rent",
              isSigner: false,
              isWritable: false,
              default: SYSVAR_RENT_PUBKEY,
            },
          ]
        ),

      updateOracle: (fairValue, spreadBps, depth, skew, newNonce, ttl) =>
        new MethodBuilder(
          this,
          encodeUpdateOracle({
            newFairValue: fairValue,
            newSpreadBps: spreadBps,
            newDepthParams: stripReserved(depth),
            newSkewParams: stripReserved(skew),
            newNonce,
            newTtl: ttl,
          }),
          [
            { name: "oracleSigner", isSigner: true, isWritable: false },
            { name: "poolState", isSigner: false, isWritable: true },
          ]
        ),

      executeSwap: (inputAmount, direction, minOutput, signedQuote) =>
        new MethodBuilder(
          this,
          encodeExecuteSwap({
            inputAmount,
            direction: normalizeSide(direction),
            minOutput,
            signedQuote: signedQuote ? normalizeSignedQuoteArg(signedQuote) : null,
          }),
          [
            { name: "user", isSigner: true, isWritable: true },
            { name: "poolState", isSigner: false, isWritable: true },
            { name: "baseVault", isSigner: false, isWritable: true },
            { name: "quoteVault", isSigner: false, isWritable: true },
            { name: "userBaseAta", isSigner: false, isWritable: true },
            { name: "userQuoteAta", isSigner: false, isWritable: true },
            {
              name: "tokenProgram",
              isSigner: false,
              isWritable: false,
              default: TOKEN_PROGRAM_ID,
            },
            {
              name: "systemProgram",
              isSigner: false,
              isWritable: false,
              default: SystemProgram.programId,
            },
            {
              name: "instructionsSysvar",
              isSigner: false,
              isWritable: false,
              default: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
          ]
        ),

      setPaused: (paused) =>
        new MethodBuilder(this, encodeSetPaused(paused), [
          { name: "admin", isSigner: true, isWritable: false },
          { name: "poolState", isSigner: false, isWritable: true },
        ]),

      rotateOracleSigner: (newSigner) =>
        new MethodBuilder(this, encodeRotateOracleSigner(newSigner), [
          { name: "admin", isSigner: true, isWritable: false },
          { name: "poolState", isSigner: false, isWritable: true },
        ]),

      rotateAdmin: (newAdmin) =>
        new MethodBuilder(this, encodeRotateAdmin(newAdmin), [
          { name: "admin", isSigner: true, isWritable: false },
          { name: "poolState", isSigner: false, isWritable: true },
        ]),

      adminWithdrawInventory: (baseAmount, quoteAmount) =>
        new MethodBuilder(
          this,
          encodeAdminWithdrawInventory({
            withdrawBaseAmount: baseAmount,
            withdrawQuoteAmount: quoteAmount,
          }),
          [
            { name: "admin", isSigner: true, isWritable: false },
            { name: "poolState", isSigner: false, isWritable: false },
            { name: "baseVault", isSigner: false, isWritable: true },
            { name: "quoteVault", isSigner: false, isWritable: true },
            { name: "adminBaseAta", isSigner: false, isWritable: true },
            { name: "adminQuoteAta", isSigner: false, isWritable: true },
            {
              name: "tokenProgram",
              isSigner: false,
              isWritable: false,
              default: TOKEN_PROGRAM_ID,
            },
          ]
        ),

      closeExpiredNonce: () =>
        new MethodBuilder(this, encodeCloseExpiredNonce(), [
          { name: "closer", isSigner: true, isWritable: true },
          { name: "poolState", isSigner: false, isWritable: false },
          { name: "quoteNonceMarker", isSigner: false, isWritable: true },
        ]),

      proposeAdmin: (newAdmin) =>
        new MethodBuilder(this, encodeProposeAdmin(newAdmin), [
          { name: "admin", isSigner: true, isWritable: true },
          { name: "poolState", isSigner: false, isWritable: false },
          { name: "adminProposal", isSigner: false, isWritable: true },
          {
            name: "systemProgram",
            isSigner: false,
            isWritable: false,
            default: SystemProgram.programId,
          },
        ]),

      acceptAdmin: () =>
        new MethodBuilder(this, encodeAcceptAdmin(), [
          { name: "newAdmin", isSigner: true, isWritable: true },
          { name: "poolState", isSigner: false, isWritable: true },
          { name: "adminProposal", isSigner: false, isWritable: true },
        ]),

      cancelAdminProposal: () =>
        new MethodBuilder(this, encodeCancelAdminProposal(), [
          { name: "admin", isSigner: true, isWritable: true },
          { name: "poolState", isSigner: false, isWritable: false },
          { name: "adminProposal", isSigner: false, isWritable: true },
        ]),
    };
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------
  // Events are emitted on-chain as `Program log: EVT:<base64>` lines, where
  // the base64 payload decodes to `[1-byte tag][Borsh body]` (see
  // programs/protocol/src/events.rs). We subscribe to the program's logs,
  // parse each line via decodeEventLog, and dispatch matching events to
  // callbacks.

  addEventListener<TName extends ProtocolEventName>(
    name: TName,
    cb: (data: unknown, slot: number, signature: string) => void
  ): number {
    const id = this.nextListenerId++;
    const logsSubId = this.provider.connection.onLogs(
      this.programId,
      (logs, ctx) => {
        for (const log of logs.logs) {
          const ev = decodeEventLog(log);
          if (!ev) continue;
          if (ev.name !== name) continue;
          cb(ev.data, ctx.slot, logs.signature);
        }
      },
      "confirmed"
    );
    this.listeners.set(id, { name, cb, logsSubId });
    return id;
  }

  async removeEventListener(id: number): Promise<void> {
    const entry = this.listeners.get(id);
    if (!entry) return;
    await this.provider.connection.removeOnLogsListener(entry.logsSubId);
    this.listeners.delete(id);
  }
}

// ----------------------------------------------------------------------------
// Anchor-shape side/quote helpers
// ----------------------------------------------------------------------------

/** Anchor IDL Side enum as a union-object (Borsh enum encoding). */
export type SideArg = { buy: Record<string, never> } | { sell: Record<string, never> };

export interface SignedQuoteArgIxArg {
  pool: PublicKey;
  user: PublicKey;
  /** Either `"buy"` / `"sell"`, or the Anchor union-object form. */
  direction: SideArg | Side;
  inputAmount: BN;
  price: BN;
  expirySlot: BN;
  nonce: BN;
  signature: number[] | Uint8Array;
}

export function sideToArg(side: Side): SideArg {
  return side === "buy" ? { buy: {} } : { sell: {} };
}

function normalizeSide(s: SideArg | Side): Side {
  if (typeof s === "string") return s;
  if ("buy" in s) return "buy";
  if ("sell" in s) return "sell";
  throw new Error("Unknown Side variant");
}

function normalizeSignedQuoteArg(q: SignedQuoteArgIxArg): SignedQuoteArg {
  return {
    pool: q.pool,
    user: q.user,
    direction: normalizeSide(q.direction),
    inputAmount: q.inputAmount,
    price: q.price,
    expirySlot: q.expirySlot,
    nonce: q.nonce,
    signature: q.signature,
  };
}

function stripReserved<T extends { reserved?: number[] }>(
  v: T
): Omit<T, "reserved"> {
  // We accept (and ignore) the legacy `reserved` field that Anchor-era callers
  // included for byte alignment. The new Borsh encoder writes the zero bytes
  // itself, so the caller's slot is purely cosmetic.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { reserved, ...rest } = v;
  return rest;
}

// ----------------------------------------------------------------------------
// Back-compat exports
// ----------------------------------------------------------------------------

/** Stand-in for the Anchor IDL — empty object kept for back-compat. */
export const IDL: Record<string, unknown> = { address: PROGRAM_ID.toBase58() };

/** Stand-in for the Anchor IDL TS type. */
export type Protocol = Program;

/** Build the Program with an existing AnchorProvider (Anchor-era signature). */
export function createProgram(provider: AnchorProvider): Program {
  return new Program(provider);
}
