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
// TEST CONTEXT
// ============================================================================

export interface TestContext {
  provider: anchor.AnchorProvider;
  program: any; // PoC omits anchor.Program<Protocol> typing (would require importing target/types).
  payer: anchor.web3.Keypair;
}

/**
 * Creates a basic test context with funded payer.
 */
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
// MINT & ATA HELPERS
// ============================================================================

export async function createTestMint(
  provider: anchor.AnchorProvider,
  payer: anchor.web3.Keypair,
  decimals: number,
  mintAuthority: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey> {
  return createMint(
    provider.connection,
    payer,
    mintAuthority,
    null,
    decimals
  );
}

/**
 * Returns [base, quote] with base.toBuffer() < quote.toBuffer() (lexicographic).
 * Pool PDA seed invariant.
 */
export function sortMints(
  mintA: anchor.web3.PublicKey,
  mintB: anchor.web3.PublicKey
): [anchor.web3.PublicKey, anchor.web3.PublicKey] {
  const a = mintA.toBuffer();
  const b = mintB.toBuffer();
  return Buffer.compare(a, b) < 0 ? [mintA, mintB] : [mintB, mintA];
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
  await mintTo(
    provider.connection,
    payer,
    mint,
    destination,
    payer, // mint authority (same as payer in tests)
    amount
  );
}

// ============================================================================
// PDA DERIVATION
// ============================================================================

export function derivePoolState(
  programId: anchor.web3.PublicKey,
  baseMint: anchor.web3.PublicKey,
  quoteMint: anchor.web3.PublicKey
): [anchor.web3.PublicKey, number] {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()],
    programId
  );
}

export function deriveVault(
  programId: anchor.web3.PublicKey,
  poolState: anchor.web3.PublicKey,
  mint: anchor.web3.PublicKey
): [anchor.web3.PublicKey, number] {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolState.toBuffer(), mint.toBuffer()],
    programId
  );
}

export function deriveQuoteNonceMarker(
  programId: anchor.web3.PublicKey,
  poolState: anchor.web3.PublicKey,
  nonce: bigint
): [anchor.web3.PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("quote_used"), poolState.toBuffer(), nonceBuf],
    programId
  );
}

// ============================================================================
// PARAMS (defaults)
// ============================================================================

export const PRICE_SCALE = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;

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
// SignedQuote canonical serialization (97 bytes)
// ============================================================================

export type Direction = "buy" | "sell";

export interface SignedQuoteData {
  pool: anchor.web3.PublicKey;
  user: anchor.web3.PublicKey;
  direction: Direction;
  inputAmount: bigint;
  price: bigint;
  expirySlot: bigint;
  nonce: bigint;
}

/**
 * Borsh serialize SignedQuoteMessage → 97 bytes.
 * Field order: pool, user, direction, input_amount, price, expiry_slot, nonce.
 */
export function serializeSignedQuoteMessage(data: SignedQuoteData): Buffer {
  const buf = Buffer.alloc(97);
  data.pool.toBuffer().copy(buf, 0); // 32
  data.user.toBuffer().copy(buf, 32); // 32
  buf[64] = data.direction === "buy" ? 0 : 1; // 1 (Borsh enum)
  buf.writeBigUInt64LE(data.inputAmount, 65); // 8
  buf.writeBigUInt64LE(data.price, 73); // 8
  buf.writeBigUInt64LE(data.expirySlot, 81); // 8
  buf.writeBigUInt64LE(data.nonce, 89); // 8
  return buf;
}

/**
 * Build a SignedQuote (with ed25519 signature) + the ed25519 verify instruction
 * to prepend to the transaction. Returns both so caller can construct tx.
 */
export function buildSignedQuoteWithVerifyIx(
  oracleSigner: anchor.web3.Keypair,
  data: SignedQuoteData
): {
  signedQuote: any;
  verifyIx: anchor.web3.TransactionInstruction;
  messageBytes: Buffer;
} {
  const messageBytes = serializeSignedQuoteMessage(data);

  // Ed25519Program signs internally; signature is extracted from the instruction data.
  const verifyIx = anchor.web3.Ed25519Program.createInstructionWithPrivateKey({
    privateKey: oracleSigner.secretKey,
    message: messageBytes,
  });

  // ed25519 program data layout: signature_offset at bytes 2-3 (u16 LE),
  // signature 64 bytes from sigOffset.
  const sigOffset = verifyIx.data.readUInt16LE(2);
  const signature = verifyIx.data.slice(sigOffset, sigOffset + 64);
  if (signature.length !== 64) {
    throw new Error(`expected 64-byte signature, got ${signature.length}`);
  }

  const signedQuote = {
    pool: data.pool,
    user: data.user,
    direction: data.direction === "buy" ? { buy: {} } : { sell: {} },
    inputAmount: new anchor.BN(data.inputAmount.toString()),
    price: new anchor.BN(data.price.toString()),
    expirySlot: new anchor.BN(data.expirySlot.toString()),
    nonce: new anchor.BN(data.nonce.toString()),
    signature: Array.from(signature),
  };

  return { signedQuote, verifyIx, messageBytes: Buffer.from(messageBytes) };
}

// ============================================================================
// Re-exports
// ============================================================================
export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };
