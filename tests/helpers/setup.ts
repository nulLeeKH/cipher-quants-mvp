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
// Re-exports
// ============================================================================
export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };
