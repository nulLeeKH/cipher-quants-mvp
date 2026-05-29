import { assertEquals } from "@std/assert";

import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "node:buffer";

import { assembleSwapTx, SWAP_CU_LIMIT } from "../../src/swap_tx.ts";

// Build a stub verify ix + stub swap ix with the right programIds so the
// assembler's ordering is exercised without dragging in the full SDK.
function stubVerifyIx(): TransactionInstruction {
  // Use Ed25519Program with a dummy signer so the ix has the right programId.
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: Keypair.generate().secretKey,
    message: new Uint8Array([1, 2, 3]),
  });
}
function stubSwapIx(
  programId: PublicKey,
  user: PublicKey,
  marker: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: marker, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([2]), // execute_swap tag
  });
}

const PROGRAM_ID = new PublicKey(
  "3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy",
);

function makeParams() {
  const user = Keypair.generate().publicKey;
  const marker = Keypair.generate().publicKey;
  const baseMint = new PublicKey("So11111111111111111111111111111111111111112");
  const quoteMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  return {
    userPk: user,
    poolAddr: Keypair.generate().publicKey,
    baseMint,
    quoteMint,
    baseVault: Keypair.generate().publicKey,
    quoteVault: Keypair.generate().publicKey,
    verifyIx: stubVerifyIx(),
    swapIx: stubSwapIx(PROGRAM_ID, user, marker),
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
  };
}

Deno.test("assembleSwapTx — emits 5 ixs in canonical order", () => {
  const r = assembleSwapTx(makeParams());
  assertEquals(r.instructions.length, 5);
  // 0 = ComputeBudget setComputeUnitLimit
  assertEquals(
    r.instructions[0].programId.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
  );
  // CU-limit ix discriminator = 0x02 followed by little-endian u32 for the limit.
  // Quick sanity: data length should be 5 (1 tag + 4 u32 LE).
  assertEquals(r.instructions[0].data.length, 5);
  assertEquals(r.instructions[0].data[0], 2); // SetComputeUnitLimit ix tag
  const cu = r.instructions[0].data.readUInt32LE(1);
  assertEquals(cu, SWAP_CU_LIMIT);

  // 1 + 2 = ATA idempotent creates (programId = ASSOCIATED_TOKEN_PROGRAM_ID)
  assertEquals(
    r.instructions[1].programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  );
  assertEquals(
    r.instructions[2].programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  );
  // idempotent variant = data[0] === 0x01 (standard creates have data[]===[])
  assertEquals(r.instructions[1].data[0], 1);
  assertEquals(r.instructions[2].data[0], 1);

  // 3 = ed25519 verify (must precede execute_swap)
  assertEquals(
    r.instructions[3].programId.toBase58(),
    Ed25519Program.programId.toBase58(),
  );

  // 4 = execute_swap (owned by our program)
  assertEquals(r.instructions[4].programId.toBase58(), PROGRAM_ID.toBase58());
});

Deno.test("assembleSwapTx — ATA addresses match user + mints", () => {
  const params = makeParams();
  const r = assembleSwapTx(params);
  assertEquals(
    r.userBaseAta.toBase58(),
    getAssociatedTokenAddressSync(params.baseMint, params.userPk).toBase58(),
  );
  assertEquals(
    r.userQuoteAta.toBase58(),
    getAssociatedTokenAddressSync(params.quoteMint, params.userPk).toBase58(),
  );
});

Deno.test("assembleSwapTx — base64 deserialises back to a 5-ix VersionedTransaction", () => {
  const r = assembleSwapTx(makeParams());
  const bytes = Buffer.from(r.txBase64, "base64");
  const vtx = VersionedTransaction.deserialize(bytes);
  assertEquals(vtx.message.compiledInstructions.length, 5);
  // Required signer count from the v0 message header.
  assertEquals(vtx.message.header.numRequiredSignatures, 1);
});

Deno.test("assembleSwapTx — fee payer == user (sole signer)", () => {
  const params = makeParams();
  const r = assembleSwapTx(params);
  const bytes = Buffer.from(r.txBase64, "base64");
  const vtx = VersionedTransaction.deserialize(bytes);
  // Account keys[0] is the fee payer in compiled v0 messages.
  assertEquals(
    vtx.message.staticAccountKeys[0].toBase58(),
    params.userPk.toBase58(),
  );
  // Single signature slot, zero-filled placeholder.
  assertEquals(vtx.signatures.length, 1);
  assertEquals(vtx.signatures[0].every((b) => b === 0), true);
});

Deno.test("assembleSwapTx — verify ix immediately precedes execute_swap (on-chain invariant)", () => {
  const r = assembleSwapTx(makeParams());
  const verifyIdx = r.instructions.findIndex(
    (ix) => ix.programId.toBase58() === Ed25519Program.programId.toBase58(),
  );
  const swapIdx = r.instructions.findIndex(
    (ix) => ix.programId.toBase58() === PROGRAM_ID.toBase58(),
  );
  // execute_swap's verify_signed_quote_signature reads "previous ix" from the
  // Instructions sysvar; failing this layout makes every RFQ swap reject
  // on-chain with QuoteSignatureInvalid.
  assertEquals(swapIdx - verifyIdx, 1);
});

Deno.test("SWAP_CU_LIMIT is sized within Solana's 1.4M tx cap", () => {
  // Per Solana runtime, max CU per tx is 1_400_000. Anything close to that
  // suggests we should split ixs. 250k leaves 5.6× headroom.
  if (SWAP_CU_LIMIT > 1_400_000) {
    throw new Error(`SWAP_CU_LIMIT=${SWAP_CU_LIMIT} exceeds runtime cap`);
  }
  if (SWAP_CU_LIMIT < 100_000) {
    throw new Error(
      `SWAP_CU_LIMIT=${SWAP_CU_LIMIT} too low — RFQ path needs ≥~125k`,
    );
  }
});
