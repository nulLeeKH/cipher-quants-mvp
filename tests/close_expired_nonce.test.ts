import {
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, transfer } from "@solana/spl-token";

import {
  setupTestContext,
  setupPool,
  TestContext,
} from "./helpers/setup";
import {
  BN,
  buildSignedQuoteWithVerifyIx,
  deriveQuoteNonceMarker,
  parseEventsFromTx,
} from "../sdk/dist";

// ============================================================================
// close_expired_nonce — happy path
// docs/SPECIFICATION.md §3.8
//
// Seed range 200–299. Requires the `test-feature` cargo feature to be
// enabled (SAFETY_BUFFER_SLOTS = 5 instead of 150). `scripts/test.sh` always
// passes `--features test-feature` when building the .so, so this is the
// default for `pnpm test`.
// ============================================================================

const SAFETY_BUFFER_TEST = 5n; // mirrors the cfg(feature = "test-feature") value

const SEED_BASE = 200;
let seedCounter = SEED_BASE;
const nextSeed = () => seedCounter++;

async function waitForSlot(
  connection: any,
  target: bigint,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cur = BigInt(await connection.getSlot("confirmed"));
    if (cur > target) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`slot did not reach ${target} within ${timeoutMs}ms`);
}

describe("close_expired_nonce — happy path (test-feature buffer)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  it("any signer can close after expiry + SAFETY_BUFFER_SLOTS elapses", async () => {
    const fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 0 });

    // ----- Fund the vaults so the RFQ swap can actually settle. -----
    // admin's base/quote ATA → pool vault PDA (SPL Token transfer, admin signs).
    await transfer(
      ctx.provider.connection,
      ctx.payer,
      fx.adminBaseAta,
      fx.baseVault,
      fx.admin,
      1_000_000_000n
    );
    await transfer(
      ctx.provider.connection,
      ctx.payer,
      fx.adminQuoteAta,
      fx.quoteVault,
      fx.admin,
      1_000_000_000n
    );

    // ----- Build a signed quote that will expire 1 slot later. -----
    const currentSlot = await ctx.provider.connection.getSlot();
    const inputAmount = 1_000n;
    const price = 100_000_000n; // PRICE_SCALE
    const expirySlot = BigInt(currentSlot + 1);
    const nonce = BigInt(Date.now()); // unique per test run

    const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
      fx.quoteSigner,
      {
        pool: fx.poolState,
        user: fx.user.publicKey,
        direction: "sell",
        inputAmount,
        price,
        expirySlot,
        nonce,
      }
    );

    const [marker] = deriveQuoteNonceMarker(fx.poolState, nonce);

    // ----- Execute the RFQ swap → marker PDA gets initialized. -----
    const swapIx = await ctx.program.methods
      .executeSwap(
        new BN(inputAmount.toString()),
        { sell: {} },
        new BN(0),
        signedQuote
      )
      .accountsPartial({
        user: fx.user.publicKey,
        poolState: fx.poolState,
        baseVault: fx.baseVault,
        quoteVault: fx.quoteVault,
        userBaseAta: fx.userBaseAta,
        userQuoteAta: fx.userQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: marker, isSigner: false, isWritable: true },
      ])
      .instruction();

    const swapTx = new Transaction().add(verifyIx).add(swapIx);
    await ctx.provider.sendAndConfirm(swapTx, [fx.user]);

    // Sanity-check the marker now exists.
    const before = await ctx.provider.connection.getAccountInfo(marker);
    expect(before).not.toBeNull();
    expect(before!.lamports).toBeGreaterThan(0);

    // ----- Wait for current_slot > expiry + SAFETY_BUFFER. -----
    await waitForSlot(
      ctx.provider.connection,
      expirySlot + SAFETY_BUFFER_TEST
    );

    // ----- Close. Closer = the same user (rent goes back to them). -----
    const closerBalanceBefore = await ctx.provider.connection.getBalance(
      fx.user.publicKey
    );

    const sig = await ctx.program.methods
      .closeExpiredNonce()
      .accountsPartial({
        closer: fx.user.publicKey,
        poolState: fx.poolState,
        quoteNonceMarker: marker,
      })
      .signers([fx.user])
      .rpc();

    // Marker is gone.
    const after = await ctx.provider.connection.getAccountInfo(marker);
    expect(after).toBeNull();

    // Rent was reclaimed by closer (minus the tx fee).
    const closerBalanceAfter = await ctx.provider.connection.getBalance(
      fx.user.publicKey
    );
    expect(closerBalanceAfter).toBeGreaterThan(closerBalanceBefore);

    // QuoteMarkerClosed event emitted.
    const events = await parseEventsFromTx(ctx.provider, sig);
    const ev = events.find((e) => e.name === "QuoteMarkerClosed");
    expect(ev).toBeDefined();
    const data: any = ev!.data;
    expect(data.pool.toString()).toBe(fx.poolState.toString());
    expect(data.closer.toString()).toBe(fx.user.publicKey.toString());
    expect(data.nonce.toString()).toBe(nonce.toString());
    expect(data.expirySlot.toString()).toBe(expirySlot.toString());
  });

  it("a non-owner can close (permissionless) — rent always flows to the closer", async () => {
    const fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 0 });
    await transfer(
      ctx.provider.connection,
      ctx.payer,
      fx.adminBaseAta,
      fx.baseVault,
      fx.admin,
      1_000_000_000n
    );
    await transfer(
      ctx.provider.connection,
      ctx.payer,
      fx.adminQuoteAta,
      fx.quoteVault,
      fx.admin,
      1_000_000_000n
    );

    const currentSlot = await ctx.provider.connection.getSlot();
    const inputAmount = 1_000n;
    const expirySlot = BigInt(currentSlot + 1);
    const nonce = BigInt(Date.now()) + 1n;

    const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
      fx.quoteSigner,
      {
        pool: fx.poolState,
        user: fx.user.publicKey,
        direction: "sell",
        inputAmount,
        price: 100_000_000n,
        expirySlot,
        nonce,
      }
    );
    const [marker] = deriveQuoteNonceMarker(fx.poolState, nonce);

    const swapIx = await ctx.program.methods
      .executeSwap(
        new BN(inputAmount.toString()),
        { sell: {} },
        new BN(0),
        signedQuote
      )
      .accountsPartial({
        user: fx.user.publicKey,
        poolState: fx.poolState,
        baseVault: fx.baseVault,
        quoteVault: fx.quoteVault,
        userBaseAta: fx.userBaseAta,
        userQuoteAta: fx.userQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: marker, isSigner: false, isWritable: true },
      ])
      .instruction();

    await ctx.provider.sendAndConfirm(
      new Transaction().add(verifyIx).add(swapIx),
      [fx.user]
    );

    await waitForSlot(
      ctx.provider.connection,
      expirySlot + SAFETY_BUFFER_TEST
    );

    // Use the admin as the closer (different from the user who initialized).
    // Rent should go to admin (the closer), demonstrating permissionless close.
    const before = await ctx.provider.connection.getBalance(fx.admin.publicKey);
    await ctx.program.methods
      .closeExpiredNonce()
      .accountsPartial({
        closer: fx.admin.publicKey,
        poolState: fx.poolState,
        quoteNonceMarker: marker,
      })
      .signers([fx.admin])
      .rpc();
    const after = await ctx.provider.connection.getBalance(fx.admin.publicKey);

    expect(after).toBeGreaterThan(before);
    expect(
      await ctx.provider.connection.getAccountInfo(marker)
    ).toBeNull();
  });
});
