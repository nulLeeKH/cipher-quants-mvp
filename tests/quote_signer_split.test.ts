import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, transfer } from "@solana/spl-token";
import {
  BN,
  buildSignedQuoteWithVerifyIx,
  derivePoolState,
  deriveQuoteNonceMarker,
  deriveVault,
  sortMints,
} from "../sdk/dist";

import {
  setupTestContext,
  setupPool,
  fundAccount,
  defaultDepthParams,
  defaultSkewParams,
  createTestMint,
  TestContext,
} from "./helpers/setup";

// ============================================================================
// Quote-signer split — verifies that pool.authorized_quote_signer is the key
// checked by execute_swap RFQ path, NOT pool.authorized_oracle_signer.
// Also covers the rotate_quote_signer instruction (admin-only, mirrors
// rotate_oracle_signer).
//
// Seed range 400–499.
// ============================================================================

const SEED_BASE = 400;
let seedCounter = SEED_BASE;
const nextSeed = () => seedCounter++;

async function fundVaults(
  ctx: TestContext,
  fx: Awaited<ReturnType<typeof setupPool>>,
  amount = 1_000_000_000n
): Promise<void> {
  await transfer(
    ctx.provider.connection,
    ctx.payer,
    fx.adminBaseAta,
    fx.baseVault,
    fx.admin,
    amount
  );
  await transfer(
    ctx.provider.connection,
    ctx.payer,
    fx.adminQuoteAta,
    fx.quoteVault,
    fx.admin,
    amount
  );
}

describe("quote_signer split", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  it("init_pool stores oracleSigner and quoteSigner as distinct keys", async () => {
    const fx = await setupPool(ctx, nextSeed());
    expect(fx.oracleSigner.publicKey.toBase58()).not.toEqual(
      fx.quoteSigner.publicKey.toBase58()
    );
    const pool: any = await ctx.program.account.poolState.fetch(fx.poolState);
    expect(pool.authorizedOracleSigner.toBase58()).toEqual(
      fx.oracleSigner.publicKey.toBase58()
    );
    expect(pool.authorizedQuoteSigner.toBase58()).toEqual(
      fx.quoteSigner.publicKey.toBase58()
    );
  });

  it("init_pool rejects zero pubkey as quote_signer (InvalidQuoteSignerKey / 6111)", async () => {
    const admin = Keypair.generate();
    const oracleSigner = Keypair.generate();
    await fundAccount(ctx.provider, admin.publicKey, 5);
    const mintA = await createTestMint(
      ctx.provider,
      ctx.payer,
      6,
      ctx.payer.publicKey
    );
    const mintB = await createTestMint(
      ctx.provider,
      ctx.payer,
      6,
      ctx.payer.publicKey
    );
    const [base, quote] = sortMints(mintA, mintB);
    const [poolState] = derivePoolState(base, quote);
    const [baseVault] = deriveVault(poolState, base);
    const [quoteVault] = deriveVault(poolState, quote);
    await expect(
      ctx.program.methods
        .initPool(
          oracleSigner.publicKey,
          PublicKey.default, // zero quote signer
          new BN(100_000_000),
          20,
          defaultDepthParams(),
          defaultSkewParams(),
          0
        )
        .accountsPartial({
          admin: admin.publicKey,
          poolState,
          baseMint: base,
          quoteMint: quote,
          baseVault,
          quoteVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc()
    ).rejects.toThrow(/InvalidQuoteSignerKey|0x17df/); // 6111 = 0x17df
  });

  it("execute_swap RFQ path: signing with oracleSigner is rejected", async () => {
    // TTL=0 forces curve-stale → RFQ path mandatory.
    const fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 0 });
    await fundVaults(ctx, fx);

    const currentSlot = await ctx.provider.connection.getSlot();
    const nonce = BigInt(Date.now()) + 1n;

    // Sign with the WRONG key (oracleSigner). pool.authorized_quote_signer
    // is fx.quoteSigner, so the on-chain check rejects.
    const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
      fx.oracleSigner,
      {
        pool: fx.poolState,
        user: fx.user.publicKey,
        direction: "sell",
        inputAmount: 1_000n,
        price: 100_000_000n,
        expirySlot: BigInt(currentSlot + 200),
        nonce,
      }
    );
    const [marker] = deriveQuoteNonceMarker(fx.poolState, nonce);

    await expect(
      ctx.program.methods
        .executeSwap(new BN(1_000), { sell: {} }, new BN(0), signedQuote)
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
        .remainingAccounts([{ pubkey: marker, isSigner: false, isWritable: true }])
        .preInstructions([verifyIx])
        .signers([fx.user])
        .rpc()
    ).rejects.toThrow(/QuoteSignatureInvalid|0x18a2/); // 6306
  });

  it("rotate_quote_signer: new key accepted, old key rejected", async () => {
    const fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 0 });
    await fundVaults(ctx, fx);

    const newQuoteSigner = Keypair.generate();
    await ctx.program.methods
      .rotateQuoteSigner(newQuoteSigner.publicKey)
      .accountsPartial({ admin: fx.admin.publicKey, poolState: fx.poolState })
      .signers([fx.admin])
      .rpc();

    const pool: any = await ctx.program.account.poolState.fetch(fx.poolState);
    expect(pool.authorizedQuoteSigner.toBase58()).toEqual(
      newQuoteSigner.publicKey.toBase58()
    );
    // Oracle signer field unchanged.
    expect(pool.authorizedOracleSigner.toBase58()).toEqual(
      fx.oracleSigner.publicKey.toBase58()
    );

    const slot = await ctx.provider.connection.getSlot();

    // Quotes signed by the OLD quoteSigner are now invalid.
    const stale = buildSignedQuoteWithVerifyIx(fx.quoteSigner, {
      pool: fx.poolState,
      user: fx.user.publicKey,
      direction: "sell",
      inputAmount: 1_000n,
      price: 100_000_000n,
      expirySlot: BigInt(slot + 200),
      nonce: BigInt(Date.now()) + 100n,
    });
    const [staleMarker] = deriveQuoteNonceMarker(
      fx.poolState,
      BigInt(stale.signedQuote.nonce.toString())
    );
    await expect(
      ctx.program.methods
        .executeSwap(new BN(1_000), { sell: {} }, new BN(0), stale.signedQuote)
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
          { pubkey: staleMarker, isSigner: false, isWritable: true },
        ])
        .preInstructions([stale.verifyIx])
        .signers([fx.user])
        .rpc()
    ).rejects.toThrow(/QuoteSignatureInvalid|0x18a2/); // 6306

    // Quotes signed by the NEW quoteSigner go through.
    const fresh = buildSignedQuoteWithVerifyIx(newQuoteSigner, {
      pool: fx.poolState,
      user: fx.user.publicKey,
      direction: "sell",
      inputAmount: 1_000n,
      price: 100_000_000n,
      expirySlot: BigInt(slot + 200),
      nonce: BigInt(Date.now()) + 200n,
    });
    const [freshMarker] = deriveQuoteNonceMarker(
      fx.poolState,
      BigInt(fresh.signedQuote.nonce.toString())
    );
    await ctx.program.methods
      .executeSwap(new BN(1_000), { sell: {} }, new BN(0), fresh.signedQuote)
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
        { pubkey: freshMarker, isSigner: false, isWritable: true },
      ])
      .preInstructions([fresh.verifyIx])
      .signers([fx.user])
      .rpc();
  });

  it("rotate_quote_signer: non-admin rejected (UnauthorizedAdmin / 6201)", async () => {
    const fx = await setupPool(ctx, nextSeed());
    const attacker = Keypair.generate();
    await fundAccount(ctx.provider, attacker.publicKey, 2);
    const newKey = Keypair.generate().publicKey;
    await expect(
      ctx.program.methods
        .rotateQuoteSigner(newKey)
        .accountsPartial({ admin: attacker.publicKey, poolState: fx.poolState })
        .signers([attacker])
        .rpc()
    ).rejects.toThrow(/UnauthorizedAdmin|0x1839/); // 6201
  });

  it("rotate_quote_signer: zero pubkey rejected (InvalidQuoteSignerKey)", async () => {
    const fx = await setupPool(ctx, nextSeed());
    await expect(
      ctx.program.methods
        .rotateQuoteSigner(PublicKey.default)
        .accountsPartial({ admin: fx.admin.publicKey, poolState: fx.poolState })
        .signers([fx.admin])
        .rpc()
    ).rejects.toThrow(/InvalidQuoteSignerKey|0x17df/);
  });

  it("rotating quote signer does NOT affect update_oracle", async () => {
    const fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 3 });
    const newQuoteSigner = Keypair.generate();
    await ctx.program.methods
      .rotateQuoteSigner(newQuoteSigner.publicKey)
      .accountsPartial({ admin: fx.admin.publicKey, poolState: fx.poolState })
      .signers([fx.admin])
      .rpc();

    // Original oracleSigner still authoritative for update_oracle.
    await ctx.program.methods
      .updateOracle(
        new BN(101_000_000),
        20,
        defaultDepthParams(),
        defaultSkewParams(),
        new BN(1),
        3
      )
      .accountsPartial({
        oracleSigner: fx.oracleSigner.publicKey,
        poolState: fx.poolState,
      })
      .signers([fx.oracleSigner])
      .rpc();

    const pool: any = await ctx.program.account.poolState.fetch(fx.poolState);
    expect(pool.fairValue.toString()).toBe("101000000");
  });
});
