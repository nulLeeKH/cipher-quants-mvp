import * as anchor from "@coral-xyz/anchor";
import { getAccount, transfer } from "@solana/spl-token";

import {
  setupTestContext,
  fundAccount,
  createTestMint,
  getOrCreateATA,
  mintTokensTo,
  defaultDepthParams,
  defaultSkewParams,
  TOKEN_PROGRAM_ID,
  TestContext,
} from "./helpers/setup";
// Import SDK directly — no duplicate helpers.
import {
  derivePoolState,
  deriveVault,
  deriveQuoteNonceMarker,
  sortMints,
  buildSignedQuoteWithVerifyIx,
  parseEventsFromTx,
  simulateSwap,
  serializeSignedQuoteMessage,
  PRICE_SCALE,
} from "../sdk/dist";

const FAIR = new anchor.BN(100_000_000); // $100 × PRICE_SCALE(1e6)
const SPREAD_BPS = 20;
const TTL_MODE_B = 3;

// ============================================================================
// Borsh parity: SDK ↔ on-chain SignedQuoteMessage byte-for-byte
// ============================================================================
// Uses the same fixture as the `signed_quote_message_golden_bytes` test in
// programs/protocol/src/state/quote.rs. Both sides must pass for RFQ
// signature verification to work; if either drifts, the entire RFQ path is
// silently rejected on-chain.
describe("Borsh parity (SignedQuoteMessage)", () => {
  it("SDK serializer matches the golden bytes used by on-chain Rust test", () => {
    const pool = new anchor.web3.PublicKey(new Uint8Array(32).fill(0x01));
    const user = new anchor.web3.PublicKey(new Uint8Array(32).fill(0x02));
    const bytes = serializeSignedQuoteMessage({
      pool,
      user,
      direction: "sell",
      inputAmount: 1_000n,
      price: 100_000_000n,
      expirySlot: 200n,
      nonce: 1n,
    });

    expect(bytes.length).toBe(97);

    const expected = new Uint8Array(97);
    expected.fill(0x01, 0, 32);
    expected.fill(0x02, 32, 64);
    expected[64] = 0x01; // Side::Sell
    const view = new DataView(expected.buffer);
    view.setBigUint64(65, 1_000n, true);
    view.setBigUint64(73, 100_000_000n, true);
    view.setBigUint64(81, 200n, true);
    view.setBigUint64(89, 1n, true);

    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it("Side::Buy = 0 (matches on-chain Borsh enum discriminant)", () => {
    const pool = new anchor.web3.PublicKey(new Uint8Array(32).fill(0));
    const user = new anchor.web3.PublicKey(new Uint8Array(32).fill(0));
    const bytes = serializeSignedQuoteMessage({
      pool,
      user,
      direction: "buy",
      inputAmount: 0n,
      price: 0n,
      expirySlot: 0n,
      nonce: 0n,
    });
    expect(bytes[64]).toBe(0x00);
  });
});

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

    [poolState] = derivePoolState(baseMint, quoteMint);
    [baseVault] = deriveVault(poolState, baseMint);
    [quoteVault] = deriveVault(poolState, quoteMint);

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

    it("rejects mints not sorted (base > quote)", async () => {
      // Try a different admin/mint pair, but with swapped order → MintsNotSorted.
      const otherAdmin = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, otherAdmin.publicKey, 20);
      const mintA = await createTestMint(ctx.provider, ctx.payer, 6, ctx.payer.publicKey);
      const mintB = await createTestMint(ctx.provider, ctx.payer, 6, ctx.payer.publicKey);
      const [b, q] = sortMints(mintA, mintB);
      // Intentionally init in (quote, base) order to provoke the error.
      const [wrongPool] = derivePoolState(q, b);
      const [wrongBaseVault] = deriveVault(wrongPool, q);
      const [wrongQuoteVault] = deriveVault(wrongPool, b);

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
            admin: otherAdmin.publicKey,
            poolState: wrongPool,
            baseMint: q,
            quoteMint: b,
            baseVault: wrongBaseVault,
            quoteVault: wrongQuoteVault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([otherAdmin])
          .rpc()
      ).rejects.toThrow(/MintsNotSorted/);
    });

    it("rejects fair_value = 0", async () => {
      const otherAdmin = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, otherAdmin.publicKey, 20);
      const mintA = await createTestMint(ctx.provider, ctx.payer, 6, ctx.payer.publicKey);
      const mintB = await createTestMint(ctx.provider, ctx.payer, 6, ctx.payer.publicKey);
      const [b, q] = sortMints(mintA, mintB);
      const [pool] = derivePoolState(b, q);
      const [bv] = deriveVault(pool, b);
      const [qv] = deriveVault(pool, q);

      await expect(
        ctx.program.methods
          .initPool(
            oracleSigner.publicKey,
            new anchor.BN(0),
            SPREAD_BPS,
            defaultDepthParams(),
            defaultSkewParams(),
            0
          )
          .accountsPartial({
            admin: otherAdmin.publicKey,
            poolState: pool,
            baseMint: b,
            quoteMint: q,
            baseVault: bv,
            quoteVault: qv,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([otherAdmin])
          .rpc()
      ).rejects.toThrow(/InvalidFairValue/);
    });

    it("rejects spread > MAX_SPREAD_BPS", async () => {
      const otherAdmin = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, otherAdmin.publicKey, 20);
      const mintA = await createTestMint(ctx.provider, ctx.payer, 6, ctx.payer.publicKey);
      const mintB = await createTestMint(ctx.provider, ctx.payer, 6, ctx.payer.publicKey);
      const [b, q] = sortMints(mintA, mintB);
      const [pool] = derivePoolState(b, q);
      const [bv] = deriveVault(pool, b);
      const [qv] = deriveVault(pool, q);

      await expect(
        ctx.program.methods
          .initPool(
            oracleSigner.publicKey,
            FAIR,
            5000, // MAX_SPREAD_BPS = 1000
            defaultDepthParams(),
            defaultSkewParams(),
            0
          )
          .accountsPartial({
            admin: otherAdmin.publicKey,
            poolState: pool,
            baseMint: b,
            quoteMint: q,
            baseVault: bv,
            quoteVault: qv,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([otherAdmin])
          .rpc()
      ).rejects.toThrow(/InvalidSpread/);
    });

    it("emits PoolInitialized event", async () => {
      const newAdmin = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, newAdmin.publicKey, 20);
      const mintA = await createTestMint(ctx.provider, ctx.payer, 6, ctx.payer.publicKey);
      const mintB = await createTestMint(ctx.provider, ctx.payer, 6, ctx.payer.publicKey);
      const [b, q] = sortMints(mintA, mintB);
      const [pool] = derivePoolState(b, q);
      const [bv] = deriveVault(pool, b);
      const [qv] = deriveVault(pool, q);

      const sig = await ctx.program.methods
        .initPool(
          oracleSigner.publicKey,
          FAIR,
          SPREAD_BPS,
          defaultDepthParams(),
          defaultSkewParams(),
          0
        )
        .accountsPartial({
          admin: newAdmin.publicKey,
          poolState: pool,
          baseMint: b,
          quoteMint: q,
          baseVault: bv,
          quoteVault: qv,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([newAdmin])
        .rpc();

      const events = await parseEventsFromTx(ctx.provider, sig);
      const initEvent = events.find((e) => e.name === "PoolInitialized");
      expect(initEvent).toBeDefined();
      const data: any = initEvent!.data;
      expect(data.pool.toString()).toBe(pool.toString());
      expect(data.admin.toString()).toBe(newAdmin.publicKey.toString());
      const fairVal = data.initialFairValue ?? data.initial_fair_value;
      expect(fairVal.toString()).toBe(FAIR.toString());
      const spread = data.initialSpreadBps ?? data.initial_spread_bps;
      expect(spread).toBe(SPREAD_BPS);
      const ttl = data.initialModeTtl ?? data.initial_mode_ttl;
      expect(ttl).toBe(0);
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
    // Mode B (TTL=3 ≈ 1.2s) risks going stale between `it`s (~hundreds of ms each in jest).
    // Re-push oracle right before each `it` to guarantee curve_age==0; nonce is a monotonic counter.
    let oracleNonceCounter = 10;

    beforeEach(async () => {
      oracleNonceCounter += 1;
      await ctx.program.methods
        .updateOracle(
          FAIR,
          SPREAD_BPS,
          defaultDepthParams(),
          defaultSkewParams(),
          new anchor.BN(oracleNonceCounter),
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

    it("rejects input_amount = 0", async () => {
      await expect(
        ctx.program.methods
          .executeSwap(new anchor.BN(0), { sell: {} }, new anchor.BN(0), null)
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
      ).rejects.toThrow(/InvalidSize/);
    });

    it("SDK simulateSwap matches on-chain swap output (bit-for-bit)", async () => {
      // Verify the SDK's client-side simulate matches on-chain execute_swap output.
      // (simulateSwap in helpers/setup.ts is an inline port of sdk/src/math/curve.ts.)
      const pool: any = await ctx.program.account.poolState.fetch(poolState);
      const baseVaultAcc = await getAccount(ctx.provider.connection, baseVault);
      const quoteVaultAcc = await getAccount(ctx.provider.connection, quoteVault);

      const inputAmount = 2_000n;
      const expected = simulateSwap({
        fairValue: BigInt(pool.fairValue.toString()),
        spreadBps: BigInt(pool.spreadBps),
        depth: {
          depthCoefBps: BigInt(pool.depthCurveParams.depthCoefBps),
          sizeUnit: BigInt(pool.depthCurveParams.sizeUnit.toString()),
          maxDepthBps: BigInt(pool.depthCurveParams.maxDepthBps),
        },
        skew: {
          targetBaseBps: BigInt(pool.inventorySkewParams.targetBaseBps),
          skewCoefBps: BigInt(pool.inventorySkewParams.skewCoefBps),
          maxSkewOffsetBps: BigInt(pool.inventorySkewParams.maxSkewOffsetBps),
        },
        reservesBase: baseVaultAcc.amount,
        reservesQuote: quoteVaultAcc.amount,
        inputAmount,
        direction: "sell",
      });

      const userQuoteBefore = (
        await getAccount(ctx.provider.connection, userQuoteAta)
      ).amount;
      await ctx.program.methods
        .executeSwap(
          new anchor.BN(inputAmount.toString()),
          { sell: {} },
          new anchor.BN(0),
          null
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
        .signers([user])
        .rpc();
      const userQuoteAfter = (
        await getAccount(ctx.provider.connection, userQuoteAta)
      ).amount;
      const actualOutput = userQuoteAfter - userQuoteBefore;

      expect(actualOutput).toBe(expected.outputAmount);
    });

    it("emits SwapExecuted event with mode=0 (curve)", async () => {
      const inputAmount = new anchor.BN(1_000);
      const sig = await ctx.program.methods
        .executeSwap(inputAmount, { sell: {} }, new anchor.BN(0), null)
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

      const events = await parseEventsFromTx(ctx.provider, sig);
      const swap = events.find((e) => e.name === "SwapExecuted");
      expect(swap).toBeDefined();
      const d: any = swap!.data;
      expect(d.pool.toString()).toBe(poolState.toString());
      expect(d.user.toString()).toBe(user.publicKey.toString());
      expect(d.direction).toBe(1); // Sell
      expect(d.mode).toBe(0); // curve
      const input = d.inputAmount ?? d.input_amount;
      expect(input.toString()).toBe(inputAmount.toString());
      const price = d.executionPrice ?? d.execution_price;
      expect(price.gtn(0)).toBe(true);
      const qNonce = d.quoteNonce ?? d.quote_nonce;
      expect(qNonce.toString()).toBe("0"); // curve path
    });
  });

  // ==========================================================================
  // execute_swap — §3.1 decision check: when the curve is fresh, signed_quote is ignored.
  // ==========================================================================
  // **Honest pattern**: bundle update_oracle + execute_swap in the same tx so curve_age=0
  // is guaranteed. We use the operating value Mode B (TTL=3) directly rather than
  // artificially inflating TTL to dodge timing — freshness comes from instruction ordering.
  describe("execute_swap (3.1 policy: curve overrides quote)", () => {
    it("when curve is fresh, attaching signed_quote still executes via curve and the quote_nonce_marker is NOT initialized", async () => {
      const slot = await ctx.provider.connection.getSlot();
      const nonce = 9999n;
      const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
        oracleSigner,
        {
          pool: poolState,
          user: user.publicKey,
          direction: "sell",
          inputAmount: 1_000n,
          price: 999_999_999n, // intentionally different from the curve price
          expirySlot: BigInt(slot + 200),
          nonce,
        }
      );
      const [marker] = deriveQuoteNonceMarker(poolState, nonce);

      // Bundle oracle push + swap in the same tx → both land in the same slot → curve_age = 0 → TTL=3 fresh.
      const oracleIx = await ctx.program.methods
        .updateOracle(
          FAIR,
          SPREAD_BPS,
          defaultDepthParams(),
          defaultSkewParams(),
          new anchor.BN(30), // safely larger than the curve-fresh describe's beforeEach counter (~16)
          TTL_MODE_B         // **operating value: Mode B=3**
        )
        .accountsPartial({
          oracleSigner: oracleSigner.publicKey,
          poolState,
        })
        .instruction();

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

      // Order: oracleIx(0) → verifyIx(1) → swapIx(2). swapIx's previous instruction is verifyIx.
      const tx = new anchor.web3.Transaction()
        .add(oracleIx)
        .add(verifyIx)
        .add(swapIx);
      const sig = await ctx.provider.sendAndConfirm(tx, [oracleSigner, user]);

      // Verify the quote was ignored:
      // 1. quote_nonce_marker is NOT initialized (curve path does not create the marker).
      const markerAccount =
        await ctx.provider.connection.getAccountInfo(marker);
      expect(markerAccount).toBeNull();

      // 2. The SwapExecuted event mode is 0 (curve).
      const events = await parseEventsFromTx(ctx.provider, sig);
      const swap = events.find((e) => e.name === "SwapExecuted");
      expect(swap).toBeDefined();
      expect((swap!.data as any).mode).toBe(0);
      const qNonce = (swap!.data as any).quoteNonce ?? (swap!.data as any).quote_nonce;
      expect(qNonce.toString()).toBe("0");
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
          new anchor.BN(35), // > 30 (the §3.1 describe's oracleIx nonce)
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

      const [marker] = deriveQuoteNonceMarker(poolState, nonce);

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

    it("rejects RFQ with wrong user", async () => {
      const slot = await ctx.provider.connection.getSlot();
      const nonce = 1001n;
      const fakeUser = anchor.web3.Keypair.generate();
      const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
        oracleSigner,
        {
          pool: poolState,
          user: fakeUser.publicKey, // wrong user
          direction: "sell",
          inputAmount: 1_000n,
          price: 100_000_000n,
          expirySlot: BigInt(slot + 200),
          nonce,
        }
      );
      const [marker] = deriveQuoteNonceMarker(poolState, nonce);
      const swapIx = await ctx.program.methods
        .executeSwap(new anchor.BN(1_000), { sell: {} }, new anchor.BN(0), signedQuote)
        .accountsPartial({
          user: user.publicKey, // actual tx signer is `user`, which mismatches the quote's user
          poolState,
          baseVault,
          quoteVault,
          userBaseAta,
          userQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([{ pubkey: marker, isSigner: false, isWritable: true }])
        .instruction();
      const tx = new anchor.web3.Transaction().add(verifyIx).add(swapIx);
      await expect(ctx.provider.sendAndConfirm(tx, [user])).rejects.toThrow();
    });

    it("rejects RFQ with wrong direction", async () => {
      const slot = await ctx.provider.connection.getSlot();
      const nonce = 1003n;
      // quote is signed as sell but the instruction is buy
      const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
        oracleSigner,
        {
          pool: poolState,
          user: user.publicKey,
          direction: "sell",
          inputAmount: 1_000n,
          price: 100_000_000n,
          expirySlot: BigInt(slot + 200),
          nonce,
        }
      );
      const [marker] = deriveQuoteNonceMarker(poolState, nonce);
      const swapIx = await ctx.program.methods
        .executeSwap(
          new anchor.BN(1_000),
          { buy: {} }, // direction mismatch
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
        .remainingAccounts([{ pubkey: marker, isSigner: false, isWritable: true }])
        .instruction();
      const tx = new anchor.web3.Transaction().add(verifyIx).add(swapIx);
      await expect(ctx.provider.sendAndConfirm(tx, [user])).rejects.toThrow(
        /QuoteDirectionMismatch/
      );
    });

    it("rejects RFQ without ed25519 verify instruction prepended", async () => {
      const slot = await ctx.provider.connection.getSlot();
      const nonce = 1004n;
      const { signedQuote } = buildSignedQuoteWithVerifyIx(oracleSigner, {
        pool: poolState,
        user: user.publicKey,
        direction: "sell",
        inputAmount: 1_000n,
        price: 100_000_000n,
        expirySlot: BigInt(slot + 200),
        nonce,
      });
      const [marker] = deriveQuoteNonceMarker(poolState, nonce);
      const swapIx = await ctx.program.methods
        .executeSwap(new anchor.BN(1_000), { sell: {} }, new anchor.BN(0), signedQuote)
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
        .remainingAccounts([{ pubkey: marker, isSigner: false, isWritable: true }])
        .instruction();
      // verifyIx is intentionally NOT attached
      const tx = new anchor.web3.Transaction().add(swapIx);
      await expect(ctx.provider.sendAndConfirm(tx, [user])).rejects.toThrow(
        /QuoteSignatureInvalid/
      );
    });

    it("rejects RFQ quote signed by wrong key", async () => {
      const slot = await ctx.provider.connection.getSlot();
      const nonce = 1005n;
      const fakeSigner = anchor.web3.Keypair.generate();
      const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
        fakeSigner, // a key other than authorized_oracle_signer
        {
          pool: poolState,
          user: user.publicKey,
          direction: "sell",
          inputAmount: 1_000n,
          price: 100_000_000n,
          expirySlot: BigInt(slot + 200),
          nonce,
        }
      );
      const [marker] = deriveQuoteNonceMarker(poolState, nonce);
      const swapIx = await ctx.program.methods
        .executeSwap(new anchor.BN(1_000), { sell: {} }, new anchor.BN(0), signedQuote)
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
        .remainingAccounts([{ pubkey: marker, isSigner: false, isWritable: true }])
        .instruction();
      const tx = new anchor.web3.Transaction().add(verifyIx).add(swapIx);
      await expect(ctx.provider.sendAndConfirm(tx, [user])).rejects.toThrow(
        /QuoteSignatureInvalid/
      );
    });

    it("rejects expired RFQ quote", async () => {
      const slot = await ctx.provider.connection.getSlot();
      const nonce = 1002n;
      const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
        oracleSigner,
        {
          pool: poolState,
          user: user.publicKey,
          direction: "sell",
          inputAmount: 1_000n,
          price: 100_000_000n,
          expirySlot: BigInt(slot - 10), // already expired
          nonce,
        }
      );
      const [marker] = deriveQuoteNonceMarker(poolState, nonce);
      const swapIx = await ctx.program.methods
        .executeSwap(new anchor.BN(1_000), { sell: {} }, new anchor.BN(0), signedQuote)
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
        .remainingAccounts([{ pubkey: marker, isSigner: false, isWritable: true }])
        .instruction();
      const tx = new anchor.web3.Transaction().add(verifyIx).add(swapIx);
      await expect(ctx.provider.sendAndConfirm(tx, [user])).rejects.toThrow(/QuoteExpired/);
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

      const [marker] = deriveQuoteNonceMarker(poolState, 1n);

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

    it("paused state blocks execute_swap + update_oracle (but not admin ops)", async () => {
      // pause
      await ctx.program.methods
        .setPaused(true)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();

      // execute_swap is rejected
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
      ).rejects.toThrow(/PoolPaused/);

      // update_oracle is rejected
      await expect(
        ctx.program.methods
          .updateOracle(
            FAIR,
            SPREAD_BPS,
            defaultDepthParams(),
            defaultSkewParams(),
            new anchor.BN(100),
            8
          )
          .accountsPartial({
            oracleSigner: oracleSigner.publicKey,
            poolState,
          })
          .signers([oracleSigner])
          .rpc()
      ).rejects.toThrow(/PoolPaused/);

      // unpause (so later tests still work)
      await ctx.program.methods
        .setPaused(false)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();
    });
  });

  // ==========================================================================
  // rotate_oracle_signer
  // ==========================================================================
  describe("rotate_oracle_signer", () => {
    it("admin rotates signer + old signer immediately rejected", async () => {
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

      // **Rotation effectiveness check**: update_oracle with the old signer must fail with UnauthorizedOracle.
      await expect(
        ctx.program.methods
          .updateOracle(
            FAIR,
            SPREAD_BPS,
            defaultDepthParams(),
            defaultSkewParams(),
            new anchor.BN(50), // monotonic
            8
          )
          .accountsPartial({
            oracleSigner: oracleSigner.publicKey, // old
            poolState,
          })
          .signers([oracleSigner])
          .rpc()
      ).rejects.toThrow(/UnauthorizedOracle/);

      // Restore (later tests still rely on oracleSigner).
      await ctx.program.methods
        .rotateOracleSigner(oracleSigner.publicKey)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();
    });
  });

  // ==========================================================================
  // rotate_admin
  // ==========================================================================
  describe("rotate_admin", () => {
    it("admin rotates to new admin and back", async () => {
      const newAdmin = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, newAdmin.publicKey, 5);

      // 1) admin → newAdmin
      await ctx.program.methods
        .rotateAdmin(newAdmin.publicKey)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();

      let pool: any = await ctx.program.account.poolState.fetch(poolState);
      expect(pool.admin.toString()).toBe(newAdmin.publicKey.toString());

      // 2) newAdmin → admin (restore)
      await ctx.program.methods
        .rotateAdmin(admin.publicKey)
        .accountsPartial({ admin: newAdmin.publicKey, poolState })
        .signers([newAdmin])
        .rpc();

      pool = await ctx.program.account.poolState.fetch(poolState);
      expect(pool.admin.toString()).toBe(admin.publicKey.toString());
    });

    it("rejects non-admin", async () => {
      const fake = anchor.web3.Keypair.generate();
      await fundAccount(ctx.provider, fake.publicKey, 1);
      await expect(
        ctx.program.methods
          .rotateAdmin(fake.publicKey)
          .accountsPartial({ admin: fake.publicKey, poolState })
          .signers([fake])
          .rpc()
      ).rejects.toThrow();
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

    it("withdraws quote only", async () => {
      const vaultBefore = (await getAccount(ctx.provider.connection, quoteVault)).amount;
      const withdrawAmt = 500n;
      await ctx.program.methods
        .adminWithdrawInventory(new anchor.BN(0), new anchor.BN(withdrawAmt.toString()))
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
      const vaultAfter = (await getAccount(ctx.provider.connection, quoteVault)).amount;
      expect(vaultBefore - vaultAfter).toBe(withdrawAmt);
    });

    it("withdraws even when pool is paused (intended behavior)", async () => {
      // pause
      await ctx.program.methods
        .setPaused(true)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();

      // admin_withdraw succeeds even when paused
      await ctx.program.methods
        .adminWithdrawInventory(new anchor.BN(100), new anchor.BN(0))
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

      // unpause (so later tests still work)
      await ctx.program.methods
        .setPaused(false)
        .accountsPartial({ admin: admin.publicKey, poolState })
        .signers([admin])
        .rpc();
    });
  });

  // ==========================================================================
  // close_expired_nonce
  // ==========================================================================
  describe("close_expired_nonce", () => {
    it("rejects close before expiry+buffer", async () => {
      const [marker] = deriveQuoteNonceMarker(poolState, 1n); // marker initialized by the RFQ test

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
