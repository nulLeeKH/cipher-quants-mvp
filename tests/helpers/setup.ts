import * as web3 from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  AnchorProvider,
  BN,
  derivePoolState,
  deriveVault,
  Program,
  sortMints,
  Wallet,
} from "../../sdk/dist";

// ============================================================================
// TEST CONTEXT — only test-only utilities live here.
// PDA derivation / quote signing / event parsing / curve simulate are all
// provided by the SDK and imported directly from `../sdk/dist`.
// ============================================================================

export interface TestContext {
  provider: AnchorProvider;
  // The test harness uses untyped `program.methods` everywhere, matching the
  // Anchor-era surface. We keep the runtime type loose to avoid threading the
  // typed Program everywhere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any;
  payer: web3.Keypair;
}

/**
 * Build a provider from the same env vars Anchor used (`ANCHOR_PROVIDER_URL`
 * and `ANCHOR_WALLET`). Those names are now de-facto Solana-tooling
 * conventions — `scripts/test.sh` exports them pointing at the local
 * test-validator + the default `~/.config/solana/id.json` keypair, and any
 * developer who already has them set in their shell works without extra
 * config.
 */
function buildProviderFromEnv(): AnchorProvider {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(process.env.HOME ?? "", ".config/solana/id.json");
  const raw = fs.readFileSync(walletPath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));
  const payer = web3.Keypair.fromSecretKey(secret);
  const wallet = new Wallet(payer);
  const connection = new web3.Connection(url, "confirmed");
  return new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

export async function setupTestContext(): Promise<TestContext> {
  const provider = buildProviderFromEnv();
  const program: any = new Program(provider);

  const payer = web3.Keypair.generate();
  await fundAccount(provider, payer.publicKey, 100);

  return { provider, program, payer };
}

export async function fundAccount(
  provider: AnchorProvider,
  pubkey: web3.PublicKey,
  sol: number
): Promise<void> {
  const sig = await provider.connection.requestAirdrop(
    pubkey,
    sol * web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(sig, "confirmed");
}

// ============================================================================
// MINT & ATA HELPERS (validator/SPL Token specific, outside SDK scope)
// ============================================================================

export async function createTestMint(
  provider: AnchorProvider,
  payer: web3.Keypair,
  decimals: number,
  mintAuthority: web3.PublicKey
): Promise<web3.PublicKey> {
  return createMint(provider.connection, payer, mintAuthority, null, decimals);
}

export async function getOrCreateATA(
  provider: AnchorProvider,
  mint: web3.PublicKey,
  owner: web3.PublicKey,
  payer: web3.Keypair
): Promise<web3.PublicKey> {
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
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
  }
  return ata;
}

export async function mintTokensTo(
  provider: AnchorProvider,
  payer: web3.Keypair,
  mint: web3.PublicKey,
  destination: web3.PublicKey,
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
    sizeUnit: new BN(1_000_000),
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
// See seedId convention above. PDA collisions are avoided because each call
// generates fresh random mints (so the (base, quote) pair is globally unique).

export interface PoolFixture {
  seedId: number;
  admin: web3.Keypair;
  oracleSigner: web3.Keypair;
  user: web3.Keypair;
  baseMint: web3.PublicKey;
  quoteMint: web3.PublicKey;
  poolState: web3.PublicKey;
  baseVault: web3.PublicKey;
  quoteVault: web3.PublicKey;
  adminBaseAta: web3.PublicKey;
  adminQuoteAta: web3.PublicKey;
  userBaseAta: web3.PublicKey;
  userQuoteAta: web3.PublicKey;
}

export interface SetupPoolOpts {
  initialFairValue?: BN;
  initialSpreadBps?: number;
  initialModeTtl?: number;
  adminSol?: number;
  userSol?: number;
  decimals?: number;
  initialMintAmount?: bigint;
}

export async function setupPool(
  ctx: TestContext,
  seedId: number,
  opts: SetupPoolOpts = {}
): Promise<PoolFixture> {
  const initialFairValue = opts.initialFairValue ?? new BN(100_000_000);
  const initialSpreadBps = opts.initialSpreadBps ?? 20;
  const initialModeTtl = opts.initialModeTtl ?? 0;
  const adminSol = opts.adminSol ?? 50;
  const userSol = opts.userSol ?? 50;
  const decimals = opts.decimals ?? 6;
  const initialMintAmount = opts.initialMintAmount ?? 1_000_000_000n;

  const admin = web3.Keypair.generate();
  const oracleSigner = web3.Keypair.generate();
  const user = web3.Keypair.generate();

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
      systemProgram: web3.SystemProgram.programId,
      rent: web3.SYSVAR_RENT_PUBKEY,
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
// Re-exports (back-compat with the Anchor-era surface)
// ============================================================================
export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };
