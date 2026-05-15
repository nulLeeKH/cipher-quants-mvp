import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";

// ============================================================================
// TEST CONTEXT
// ============================================================================
// Central test infrastructure. All test files should use this context
// to ensure consistent setup and avoid PDA collisions.
//
// PDA Seed ID Ranges (to prevent collisions in parallel tests):
//   | Test File          | Seed Range | Description     |
//   |--------------------|------------|-----------------|
//   | (add your tests)   | 100-199    | First feature   |
//   |                    | 200-299    | Second feature  |
//   |                    | 300-399    | Third feature   |
//   |                    | 400-499    | Fourth feature  |
//
// Update CLAUDE.md's Testing section when adding new test files.
// ============================================================================

/**
 * Shared test context for all integration tests.
 * Extend this interface as your program grows.
 */
export interface TestContext {
  provider: anchor.AnchorProvider;
  program: anchor.Program;
  payer: anchor.web3.Keypair;
  // Add program-specific accounts here:
  // e.g., poolStatePDA: anchor.web3.PublicKey;
}

/**
 * Creates a basic test context with funded payer.
 *
 * @param seedId - Unique seed identifier for this test (use assigned range)
 */
export async function setupTestContext(
  seedId: number = 100
): Promise<TestContext> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load program from workspace
  // TODO: Replace 'protocol' with your program name from Anchor.toml
  const program = anchor.workspace.Protocol;

  const payer = anchor.web3.Keypair.generate();

  // Airdrop SOL to payer
  const airdropSig = await provider.connection.requestAirdrop(
    payer.publicKey,
    10 * anchor.web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(airdropSig, "confirmed");

  return {
    provider,
    program,
    payer,
  };
}

/**
 * Gets or creates an Associated Token Account.
 */
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
    // ATA doesn't exist, create it
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
