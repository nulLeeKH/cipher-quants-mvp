import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  mintTo,
} from "@solana/spl-token";

// ============================================================================
// TEST CONTEXT — only test-only utilities live here.
// PDA derivation / quote signing / event parsing / curve simulate are all
// provided by the SDK and imported directly from `../sdk/dist`.
// (Project rule: no duplicate implementations.)
// ============================================================================

export interface TestContext {
  provider: anchor.AnchorProvider;
  program: any;
  payer: anchor.web3.Keypair;
}

export async function setupTestContext(): Promise<TestContext> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program: any = anchor.workspace.Protocol;

  const payer = anchor.web3.Keypair.generate();
  await fundAccount(provider, payer.publicKey, 100);

  return { provider, program, payer };
}

export async function fundAccount(
  provider: anchor.AnchorProvider,
  pubkey: anchor.web3.PublicKey,
  sol: number
): Promise<void> {
  const sig = await provider.connection.requestAirdrop(
    pubkey,
    sol * anchor.web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(sig, "confirmed");
}

// ============================================================================
// MINT & ATA HELPERS (validator/SPL Token specific, outside SDK scope)
// ============================================================================

export async function createTestMint(
  provider: anchor.AnchorProvider,
  payer: anchor.web3.Keypair,
  decimals: number,
  mintAuthority: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey> {
  return createMint(provider.connection, payer, mintAuthority, null, decimals);
}

export async function getOrCreateATA(
  provider: anchor.AnchorProvider,
  mint: anchor.web3.PublicKey,
  owner: anchor.web3.PublicKey,
  payer: anchor.web3.Keypair
): Promise<anchor.web3.PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    await getAccount(provider.connection, ata);
  } catch {
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint
    );
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
  }
  return ata;
}

export async function mintTokensTo(
  provider: anchor.AnchorProvider,
  payer: anchor.web3.Keypair,
  mint: anchor.web3.PublicKey,
  destination: anchor.web3.PublicKey,
  amount: bigint | number
): Promise<void> {
  await mintTo(provider.connection, payer, mint, destination, payer, amount);
}

// ============================================================================
// Test fixtures (default params — the SDK ships no fixtures; these are test-only)
// ============================================================================

export function defaultDepthParams() {
  return {
    depthCoefBps: 0,
    sizeUnit: new anchor.BN(1_000_000),
    maxDepthBps: 100,
    reserved: Array(6).fill(0),
  };
}

export function defaultSkewParams() {
  return {
    targetBaseBps: 5_000,
    skewCoefBps: 0,
    maxSkewOffsetBps: 100,
    reserved: Array(10).fill(0),
  };
}

// ============================================================================
// Isolated pool fixture (recommended for new test files)
// ============================================================================
// The original protocol.test.ts uses a single global pool shared across every
// describe — convenient but order-dependent. New test files should call
// `setupPool(ctx, seedId)` to obtain a fresh pool + funded admin/oracle/user
// keys + funded ATAs, all keyed off a unique numeric seed.
//
// SEED RANGE CONVENTION (assign one block per test file; document below):
//
//   protocol.test.ts           — global state (no setupPool, legacy)
//   future-feature.test.ts     — 100..199
//   another-feature.test.ts    — 200..299
//
// PDA collisions are avoided because `setupPool` creates fresh random mints
// (so the (base_mint, quote_mint) pair is globally unique), but seedId is
// still useful for deterministic logging and per-file run scope.

import {
  derivePoolState,
  deriveVault,
  sortMints,
} from "../../sdk/dist";

export interface PoolFixture {
  seedId: number;
  admin: anchor.web3.Keypair;
  oracleSigner: anchor.web3.Keypair;
  user: anchor.web3.Keypair;
  baseMint: anchor.web3.PublicKey;
  quoteMint: anchor.web3.PublicKey;
  poolState: anchor.web3.PublicKey;
  baseVault: anchor.web3.PublicKey;
  quoteVault: anchor.web3.PublicKey;
  adminBaseAta: anchor.web3.PublicKey;
  adminQuoteAta: anchor.web3.PublicKey;
  userBaseAta: anchor.web3.PublicKey;
  userQuoteAta: anchor.web3.PublicKey;
}

export interface SetupPoolOpts {
  /** Initial fair_value (PRICE_SCALE units). Default: $100. */
  initialFairValue?: anchor.BN;
  /** Initial spread (bps). Default: 20. */
  initialSpreadBps?: number;
  /** Initial mode TTL. Default: 0 (Mode C). */
  initialModeTtl?: number;
  /** Admin SOL balance. Default: 50. */
  adminSol?: number;
  /** User SOL balance. Default: 50. */
  userSol?: number;
  /** Token decimals. Default: 6. */
  decimals?: number;
  /** Initial mint amount per ATA. Default: 1_000_000_000. */
  initialMintAmount?: bigint;
}

/**
 * Create a fully-initialized, isolated pool with its own admin / oracle / user
 * keys, mints, vaults, and ATAs. Calls `init_pool` so the pool exists on
 * chain. Use this from `beforeAll` / `beforeEach` in new test files to avoid
 * the legacy shared-state pattern.
 */
export async function setupPool(
  ctx: TestContext,
  seedId: number,
  opts: SetupPoolOpts = {}
): Promise<PoolFixture> {
  const initialFairValue = opts.initialFairValue ?? new anchor.BN(100_000_000);
  const initialSpreadBps = opts.initialSpreadBps ?? 20;
  const initialModeTtl = opts.initialModeTtl ?? 0;
  const adminSol = opts.adminSol ?? 50;
  const userSol = opts.userSol ?? 50;
  const decimals = opts.decimals ?? 6;
  const initialMintAmount = opts.initialMintAmount ?? 1_000_000_000n;

  const admin = anchor.web3.Keypair.generate();
  const oracleSigner = anchor.web3.Keypair.generate();
  const user = anchor.web3.Keypair.generate();

  await Promise.all([
    fundAccount(ctx.provider, admin.publicKey, adminSol),
    fundAccount(ctx.provider, user.publicKey, userSol),
  ]);

  const mintA = await createTestMint(ctx.provider, ctx.payer, decimals, ctx.payer.publicKey);
  const mintB = await createTestMint(ctx.provider, ctx.payer, decimals, ctx.payer.publicKey);
  const [baseMint, quoteMint] = sortMints(mintA, mintB);

  const [poolState] = derivePoolState(baseMint, quoteMint);
  const [baseVault] = deriveVault(poolState, baseMint);
  const [quoteVault] = deriveVault(poolState, quoteMint);

  const adminBaseAta = await getOrCreateATA(ctx.provider, baseMint, admin.publicKey, ctx.payer);
  const adminQuoteAta = await getOrCreateATA(ctx.provider, quoteMint, admin.publicKey, ctx.payer);
  const userBaseAta = await getOrCreateATA(ctx.provider, baseMint, user.publicKey, ctx.payer);
  const userQuoteAta = await getOrCreateATA(ctx.provider, quoteMint, user.publicKey, ctx.payer);

  await mintTokensTo(ctx.provider, ctx.payer, baseMint, adminBaseAta, initialMintAmount);
  await mintTokensTo(ctx.provider, ctx.payer, quoteMint, adminQuoteAta, initialMintAmount);
  await mintTokensTo(ctx.provider, ctx.payer, baseMint, userBaseAta, initialMintAmount / 10n);
  await mintTokensTo(
    ctx.provider,
    ctx.payer,
    quoteMint,
    userQuoteAta,
    initialMintAmount * 100n
  );

  await ctx.program.methods
    .initPool(
      oracleSigner.publicKey,
      initialFairValue,
      initialSpreadBps,
      defaultDepthParams(),
      defaultSkewParams(),
      initialModeTtl
    )
    .accountsPartial({
      admin: admin.publicKey,
      poolState,
      baseMint,
      quoteMint,
      baseVault,
      quoteVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([admin])
    .rpc();

  return {
    seedId,
    admin,
    oracleSigner,
    user,
    baseMint,
    quoteMint,
    poolState,
    baseVault,
    quoteVault,
    adminBaseAta,
    adminQuoteAta,
    userBaseAta,
    userQuoteAta,
  };
}

// ============================================================================
// Re-exports
// ============================================================================
export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };
