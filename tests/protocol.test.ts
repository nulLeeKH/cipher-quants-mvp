import * as anchor from "@coral-xyz/anchor";
import { getAccount, transfer } from "@solana/spl-token";

import {
  setupTestContext,
  fundAccount,
  createTestMint,
  sortMints,
  getOrCreateATA,
  mintTokensTo,
  derivePoolState,
  deriveVault,
  deriveQuoteNonceMarker,
  defaultDepthParams,
  defaultSkewParams,
  buildSignedQuoteWithVerifyIx,
  PRICE_SCALE,
  TOKEN_PROGRAM_ID,
  TestContext,
} from "./helpers/setup";

const FAIR = new anchor.BN(100_000_000); // $100 × PRICE_SCALE(1e6)
const SPREAD_BPS = 20;
const TTL_MODE_B = 3;

describe("Protocol", () => {
  let ctx: TestContext;
  let admin: anchor.web3.Keypair;
  let oracleSigner: anchor.web3.Keypair;
  let user: anchor.web3.Keypair;

  // Sorted such that base < quote.
  let baseMint: anchor.web3.PublicKey;
  let quoteMint: anchor.web3.PublicKey;
  let poolState: anchor.web3.PublicKey;
  let baseVault: anchor.web3.PublicKey;
  let quoteVault: anchor.web3.PublicKey;
  let adminBaseAta: anchor.web3.PublicKey;
  let adminQuoteAta: anchor.web3.PublicKey;
  let userBaseAta: anchor.web3.PublicKey;
  let userQuoteAta: anchor.web3.PublicKey;

  beforeAll(async () => {
    ctx = await setupTestContext();
    admin = anchor.web3.Keypair.generate();
    oracleSigner = anchor.web3.Keypair.generate();
    user = anchor.web3.Keypair.generate();

    await Promise.all([
      fundAccount(ctx.provider, admin.publicKey, 50),
      fundAccount(ctx.provider, user.publicKey, 50),
    ]);

    // Create 2 mints, sorted base < quote.
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
    [baseMint, quoteMint] = sortMints(mintA, mintB);

    [poolState] = derivePoolState(
      ctx.program.programId,
      baseMint,
      quoteMint
    );
    [baseVault] = deriveVault(ctx.program.programId, poolState, baseMint);
    [quoteVault] = deriveVault(ctx.program.programId, poolState, quoteMint);

    // Admin/user ATAs
    adminBaseAta = await getOrCreateATA(
      ctx.provider,
      baseMint,
      admin.publicKey,
      ctx.payer
    );
    adminQuoteAta = await getOrCreateATA(
      ctx.provider,
      quoteMint,
      admin.publicKey,
      ctx.payer
    );
    userBaseAta = await getOrCreateATA(
      ctx.provider,
      baseMint,
      user.publicKey,
      ctx.payer
    );
    userQuoteAta = await getOrCreateATA(
      ctx.provider,
      quoteMint,
      user.publicKey,
      ctx.payer
    );

    // Mint initial supply.
    await mintTokensTo(
      ctx.provider,
      ctx.payer,
      baseMint,
      adminBaseAta,
      1_000_000_000n
    );
    await mintTokensTo(
      ctx.provider,
      ctx.payer,
      quoteMint,
      adminQuoteAta,
      1_000_000_000n
    );
    await mintTokensTo(
      ctx.provider,
      ctx.payer,
      baseMint,
      userBaseAta,
      100_000_000n
    );
    await mintTokensTo(
      ctx.provider,
      ctx.payer,
      quoteMint,
      userQuoteAta,
      100_000_000_000n
    );
  });

  // ==========================================================================
  // init_pool
  // ==========================================================================
  describe("init_pool", () => {
    it("creates pool with valid params", async () => {
      await ctx.program.methods
        .initPool(
          oracleSigner.publicKey,
          FAIR,
          SPREAD_BPS,
          defaultDepthParams(),
          defaultSkewParams(),
          0 // Start in Mode C.
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

      const pool: any = await ctx.program.account.poolState.fetch(poolState);
      expect(pool.admin.toString()).toBe(admin.publicKey.toString());
      expect(pool.authorizedOracleSigner.toString()).toBe(
        oracleSigner.publicKey.toString()
      );
      expect(pool.fairValue.toString()).toBe(FAIR.toString());
      expect(pool.spreadBps).toBe(SPREAD_BPS);
      expect(pool.currentModeTtl).toBe(0);
      expect(pool.paused).toBe(false);
      expect(pool.oracleNonce.toString()).toBe("0");
    });

    it("rejects duplicate init", async () => {
      await expect(
        ctx.program.methods
          .initPool(
            oracleSigner.publicKey,
            FAIR,
            SPREAD_BPS,
            defaultDepthParams(),
            defaultSkewParams(),
            0
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
          .rpc()
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // update_oracle
  // ==========================================================================
  describe("update_oracle", () => {
    it("updates with monotonic nonce", async () => {
      await ctx.program.methods
        .updateOracle(
          FAIR,
          SPREAD_BPS,
          defaultDepthParams(),
          defaultSkewParams(),
          new anchor.BN(1), // nonce
          TTL_MODE_B // Mode B
        )
        .accountsPartial({
          oracleSigner: oracleSigner.publicKey,
          poolState,
        })
        .signers([oracleSigner])
        .rpc();

      const pool: any = await ctx.program.account.poolState.fetch(poolState);
      expect(pool.oracleNonce.toString()).toBe("1");
      expect(pool.currentModeTtl).toBe(TTL_MODE_B);
    });

    it("rejects non-monotonic nonce", async () => {
      await expect(
        ctx.program.methods
          .updateOracle(
            FAIR,
            SPREAD_BPS,
            defaultDepthParams(),
            defaultSkewParams(),
            new anchor.BN(1), // already 1 — violates the monotonic rule
            TTL_MODE_B
          )
          .accountsPartial({
            oracleSigner: oracleSigner.publicKey,
            poolState,
          })
          .signers([oracleSigner])
          .rpc()
      ).rejects.toThrow(/NonceNotMonotonic/);
    });

    it("rejects unauthorized signer", async () => {
      const fake = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, fake.publicKey, 1);
      await expect(
        ctx.program.methods
          .updateOracle(
            FAIR,
            SPREAD_BPS,
            defaultDepthParams(),
            defaultSkewParams(),
            new anchor.BN(2),
            TTL_MODE_B
          )
          .accountsPartial({
            oracleSigner: fake.publicKey,
            poolState,
          })
          .signers([fake])
          .rpc()
      ).rejects.toThrow(/UnauthorizedOracle/);
    });
  });

  // ==========================================================================
  // Vault deposit (admin → vault via SPL Token transfer)
  // ==========================================================================
  describe("vault deposit", () => {
    it("admin can deposit base + quote into vaults", async () => {
      await transfer(
        ctx.provider.connection,
        admin,
        adminBaseAta,
        baseVault,
        admin,
        500_000_000n
      );
      await transfer(
        ctx.provider.connection,
        admin,
        adminQuoteAta,
        quoteVault,
        admin,
        500_000_000n
      );

      const baseVaultAcc = await getAccount(ctx.provider.connection, baseVault);
      const quoteVaultAcc = await getAccount(
        ctx.provider.connection,
        quoteVault
      );
      expect(baseVaultAcc.amount).toBe(500_000_000n);
      expect(quoteVaultAcc.amount).toBe(500_000_000n);
    });
  });

  // ==========================================================================
  // execute_swap — Curve path
  // ==========================================================================
  describe("execute_swap (curve fresh)", () => {
    beforeAll(async () => {
      // Bump oracle freshness for curve path. Applies Mode B (TTL=3).
      await ctx.program.methods
        .updateOracle(
          FAIR,
          SPREAD_BPS,
          defaultDepthParams(),
          defaultSkewParams(),
          new anchor.BN(10), // nonce jump (still satisfies monotonic constraint)
          TTL_MODE_B
        )
        .accountsPartial({
          oracleSigner: oracleSigner.publicKey,
          poolState,
        })
        .signers([oracleSigner])
        .rpc();
    });

    it("Buy succeeds (input quote → output base)", async () => {
      const inputAmount = new anchor.BN(100_000); // 0.1 quote
      const minOutput = new anchor.BN(0);

      const userBaseBefore = (
        await getAccount(ctx.provider.connection, userBaseAta)
      ).amount;
      const userQuoteBefore = (
        await getAccount(ctx.provider.connection, userQuoteAta)
      ).amount;

      await ctx.program.methods
        .executeSwap(inputAmount, { buy: {} }, minOutput, null)
        .accountsPartial({
          user: user.publicKey,
          poolState,
          baseVault,
          quoteVault,
          userBaseAta,
          userQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([user])
        .rpc();

      const userBaseAfter = (
        await getAccount(ctx.provider.connection, userBaseAta)
      ).amount;
      const userQuoteAfter = (
        await getAccount(ctx.provider.connection, userQuoteAta)
      ).amount;

      // Buy: pay quote, receive base.
      expect(userQuoteAfter).toBeLessThan(userQuoteBefore);
      expect(userBaseAfter).toBeGreaterThan(userBaseBefore);
      expect(userQuoteBefore - userQuoteAfter).toBe(BigInt(inputAmount.toString()));
    });

    it("Sell succeeds (input base → output quote)", async () => {
      const inputAmount = new anchor.BN(1_000); // 0.001 base
      const minOutput = new anchor.BN(0);

      const userBaseBefore = (
        await getAccount(ctx.provider.connection, userBaseAta)
      ).amount;
      const userQuoteBefore = (
        await getAccount(ctx.provider.connection, userQuoteAta)
      ).amount;

      await ctx.program.methods
        .executeSwap(inputAmount, { sell: {} }, minOutput, null)
        .accountsPartial({
          user: user.publicKey,
          poolState,
          baseVault,
          quoteVault,
          userBaseAta,
          userQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([user])
        .rpc();

      const userBaseAfter = (
        await getAccount(ctx.provider.connection, userBaseAta)
      ).amount;
      const userQuoteAfter = (
        await getAccount(ctx.provider.connection, userQuoteAta)
      ).amount;

      // Sell: pay base, receive quote.
      expect(userBaseAfter).toBeLessThan(userBaseBefore);
      expect(userQuoteAfter).toBeGreaterThan(userQuoteBefore);
      expect(userBaseBefore - userBaseAfter).toBe(BigInt(inputAmount.toString()));
    });

    it("rejects slippage (min_output too high)", async () => {
      const inputAmount = new anchor.BN(1_000);
      const minOutput = new anchor.BN(10n ** 18n); // unreasonable

      await expect(
        ctx.program.methods
          .executeSwap(inputAmount, { sell: {} }, minOutput, null)
          .accountsPartial({
            user: user.publicKey,
            poolState,
            baseVault,
            quoteVault,
            userBaseAta,
            userQuoteAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
            instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .signers([user])
          .rpc()
      ).rejects.toThrow(/SlippageExceeded/);
    });
  });

  // ==========================================================================
  // execute_swap — RFQ path
  // ==========================================================================
  describe("execute_swap (RFQ, curve stale)", () => {
    beforeAll(async () => {
      // Force stale via Mode C (TTL=0)
      await ctx.program.methods
        .updateOracle(
          FAIR,
          SPREAD_BPS,
          defaultDepthParams(),
          defaultSkewParams(),
          new anchor.BN(20),
          0 // Mode C — force the curve stale
        )
        .accountsPartial({
          oracleSigner: oracleSigner.publicKey,
          poolState,
        })
        .signers([oracleSigner])
        .rpc();
    });

    it("rejects swap without signed quote (curve stale)", async () => {
      await expect(
        ctx.program.methods
          .executeSwap(new anchor.BN(1_000), { sell: {} }, new anchor.BN(0), null)
          .accountsPartial({
            user: user.publicKey,
            poolState,
            baseVault,
            quoteVault,
            userBaseAta,
            userQuoteAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
            instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .signers([user])
          .rpc()
      ).rejects.toThrow(/NoFreshPriceSource/);
    });

    it("Sell via signed quote + ed25519 verify", async () => {
      const slot = await ctx.provider.connection.getSlot();
      const inputAmount = 1_000n;
      const price = 100_000_000n; // 1 base = 100 quote (PRICE_SCALE=1e6)
      const expirySlot = BigInt(slot + 200);
      const nonce = 1n;

      const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
        oracleSigner,
        {
          pool: poolState,
          user: user.publicKey,
          direction: "sell",
          inputAmount,
          price,
          expirySlot,
          nonce,
        }
      );

      const [marker] = deriveQuoteNonceMarker(
        ctx.program.programId,
        poolState,
        nonce
      );

      const swapIx = await ctx.program.methods
        .executeSwap(
          new anchor.BN(inputAmount.toString()),
          { sell: {} },
          new anchor.BN(0),
          signedQuote
        )
        .accountsPartial({
          user: user.publicKey,
          poolState,
          baseVault,
          quoteVault,
          userBaseAta,
          userQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: marker, isSigner: false, isWritable: true },
        ])
        .instruction();

      const tx = new anchor.web3.Transaction().add(verifyIx).add(swapIx);
      await ctx.provider.sendAndConfirm(tx, [user]);

      // The quote_nonce_marker has been initialized (replay block in place).
      const markerAcc = await ctx.program.account.quoteNonceMarker.fetch(
        marker
      );
      expect((markerAcc as any).nonce.toString()).toBe("1");
    });

    it("rejects replay (same nonce)", async () => {
      const slot = await ctx.provider.connection.getSlot();
      const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
        oracleSigner,
        {
          pool: poolState,
          user: user.publicKey,
          direction: "sell",
          inputAmount: 1_000n,
          price: 100_000_000n,
          expirySlot: BigInt(slot + 200),
          nonce: 1n, // nonce that was already consumed
        }
      );

      const [marker] = deriveQuoteNonceMarker(
        ctx.program.programId,
        poolState,
        1n
      );

      const swapIx = await ctx.program.methods
        .executeSwap(
          new anchor.BN(1_000),
          { sell: {} },
          new anchor.BN(0),
          signedQuote
        )
        .accountsPartial({
          user: user.publicKey,
          poolState,
          baseVault,
          quoteVault,
          userBaseAta,
          userQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: marker, isSigner: false, isWritable: true },
        ])
        .instruction();

      const tx = new anchor.web3.Transaction().add(verifyIx).add(swapIx);
      await expect(
        ctx.provider.sendAndConfirm(tx, [user])
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // set_paused
  // ==========================================================================
  describe("set_paused", () => {
    it("admin can pause/unpause", async () => {
      await ctx.program.methods
        .setPaused(true)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();
      let pool: any = await ctx.program.account.poolState.fetch(poolState);
      expect(pool.paused).toBe(true);

      await ctx.program.methods
        .setPaused(false)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();
      pool = await ctx.program.account.poolState.fetch(poolState);
      expect(pool.paused).toBe(false);
    });

    it("rejects non-admin", async () => {
      const fake = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, fake.publicKey, 1);
      await expect(
        ctx.program.methods
          .setPaused(true)
          .accountsPartial({ admin: fake.publicKey, poolState })
          .signers([fake])
          .rpc()
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // rotate_oracle_signer
  // ==========================================================================
  describe("rotate_oracle_signer", () => {
    it("admin rotates signer", async () => {
      const newSigner = anchor.web3.Keypair.generate();
      await ctx.program.methods
        .rotateOracleSigner(newSigner.publicKey)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();

      const pool: any = await ctx.program.account.poolState.fetch(poolState);
      expect(pool.authorizedOracleSigner.toString()).toBe(
        newSigner.publicKey.toString()
      );

      // Restore (later tests still rely on oracleSigner).
      await ctx.program.methods
        .rotateOracleSigner(oracleSigner.publicKey)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();
    });
  });

  // ==========================================================================
  // admin_withdraw_inventory
  // ==========================================================================
  describe("admin_withdraw_inventory", () => {
    it("withdraws base from vault", async () => {
      const vaultBefore = (
        await getAccount(ctx.provider.connection, baseVault)
      ).amount;
      const adminBefore = (
        await getAccount(ctx.provider.connection, adminBaseAta)
      ).amount;

      const withdrawAmt = 1_000n;
      await ctx.program.methods
        .adminWithdrawInventory(new anchor.BN(withdrawAmt.toString()), new anchor.BN(0))
        .accountsPartial({
          admin: admin.publicKey,
          poolState,
          baseVault,
          quoteVault,
          adminBaseAta,
          adminQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      const vaultAfter = (
        await getAccount(ctx.provider.connection, baseVault)
      ).amount;
      const adminAfter = (
        await getAccount(ctx.provider.connection, adminBaseAta)
      ).amount;
      expect(vaultBefore - vaultAfter).toBe(withdrawAmt);
      expect(adminAfter - adminBefore).toBe(withdrawAmt);
    });

    it("rejects non-admin", async () => {
      const fake = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, fake.publicKey, 1);
      await expect(
        ctx.program.methods
          .adminWithdrawInventory(new anchor.BN(1), new anchor.BN(0))
          .accountsPartial({
            admin: fake.publicKey,
            poolState,
            baseVault,
            quoteVault,
            adminBaseAta,
            adminQuoteAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([fake])
          .rpc()
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // close_expired_nonce
  // ==========================================================================
  describe("close_expired_nonce", () => {
    it("rejects close before expiry+buffer", async () => {
      const [marker] = deriveQuoteNonceMarker(
        ctx.program.programId,
        poolState,
        1n // marker initialized by the RFQ test
      );

      // expiry+buffer has not elapsed yet (right after the RFQ test)
      await expect(
        ctx.program.methods
          .closeExpiredNonce()
          .accountsPartial({
            closer: admin.publicKey,
            poolState,
            quoteNonceMarker: marker,
          })
          .signers([admin])
          .rpc()
      ).rejects.toThrow(/NonceNotYetClosable/);
    });
  });
});
