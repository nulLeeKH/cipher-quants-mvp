import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  mintTo,
  transfer,
} from "@solana/spl-token";

import {
  setupTestContext,
  setupPool,
  fundAccount,
  defaultDepthParams,
  defaultSkewParams,
  TestContext,
  PoolFixture,
} from "./helpers/setup";
import {
  BN,
  buildSignedQuoteWithVerifyIx,
  deriveAdminProposal,
  derivePoolState,
  deriveQuoteNonceMarker,
  deriveVault,
  sortMints,
} from "../sdk/dist";

// ============================================================================
// Security test suite — exhaustively cover every safety helper invocation in
// each instruction. The Pinocchio port removed Anchor's auto-generated
// `#[derive(Accounts)]` checks; each `safety::verify_*` call is now hand-
// written, and any one of them being skipped or mis-wired is a real
// vulnerability. These tests exercise every substitution / mismatch path so
// regressions surface immediately.
//
// Seed range 300–399 (per CLAUDE.md `Seed ID Ranges`).
// One pool fixture per `describe` block — negative tests don't mutate state.
// ============================================================================

const SEED_BASE = 300;
let seedCounter = SEED_BASE;
const nextSeed = () => seedCounter++;

/** Fund both vaults so a swap can settle (used by execute_swap tests). */
async function fundVaults(
  ctx: TestContext,
  fx: PoolFixture,
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

/** Make a fresh mint + ATA pair owned by `owner`. Used to construct
 *  attacker-controlled accounts for substitution tests. */
async function makeOwnedAta(
  ctx: TestContext,
  owner: PublicKey,
  decimals = 6
): Promise<{ mint: PublicKey; ata: PublicKey }> {
  const mint = await createMint(
    ctx.provider.connection,
    ctx.payer,
    ctx.payer.publicKey,
    null,
    decimals
  );
  const ata = getAssociatedTokenAddressSync(mint, owner);
  await ctx.provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountInstruction(
        ctx.payer.publicKey,
        ata,
        owner,
        mint
      )
    ),
    [ctx.payer]
  );
  return { mint, ata };
}

// ============================================================================
// execute_swap — account substitution attacks
// ============================================================================

describe("security — execute_swap substitution", () => {
  let ctx: TestContext;
  let fx: PoolFixture;
  // Curve-fresh path: TTL > 0 and we send the swap immediately so the curve
  // is fresh (init_pool sets last_oracle_update_slot = current slot).
  beforeAll(async () => {
    ctx = await setupTestContext();
    fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 3 });
    await fundVaults(ctx, fx);
  });

  // Helper: build a baseline `execute_swap` ix that succeeds, then swap one
  // account at a time to construct attack scenarios.
  function buildSwapIx(overrides: Record<string, PublicKey> = {}) {
    return ctx.program.methods
      .executeSwap(new BN(1_000), { sell: {} }, new BN(0), null)
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
        ...overrides,
      })
      .signers([fx.user])
      .rpc();
  }

  it("baseline swap succeeds (sanity)", async () => {
    await buildSwapIx();
  });

  it("rejects wrong token_program (WrongAccountAddress / 6509)", async () => {
    await expect(
      buildSwapIx({ tokenProgram: SystemProgram.programId })
    ).rejects.toThrow(/WrongAccountAddress|0x1965/);
  });

  it("rejects wrong instructions_sysvar (WrongAccountAddress)", async () => {
    await expect(
      buildSwapIx({ instructionsSysvar: SYSVAR_RENT_PUBKEY })
    ).rejects.toThrow(/WrongAccountAddress|0x1965/);
  });

  it("rejects wrong base_vault address (WrongAccountAddress)", async () => {
    // Substitute a DIFFERENT pool's vault — same SPL token mint type, but
    // not pool.base_vault.
    const otherPool = await setupPool(ctx, nextSeed(), { initialModeTtl: 3 });
    await expect(
      buildSwapIx({ baseVault: otherPool.baseVault })
    ).rejects.toThrow(/WrongAccountAddress|0x1965/);
  });

  it("rejects wrong quote_vault address (WrongAccountAddress)", async () => {
    const otherPool = await setupPool(ctx, nextSeed(), { initialModeTtl: 3 });
    await expect(
      buildSwapIx({ quoteVault: otherPool.quoteVault })
    ).rejects.toThrow(/WrongAccountAddress|0x1965/);
  });

  it("rejects user_base_ata with wrong mint (WrongTokenMint)", async () => {
    // ATA on a foreign mint, owned by user.
    const { ata: foreignAta } = await makeOwnedAta(ctx, fx.user.publicKey);
    await expect(
      buildSwapIx({ userBaseAta: foreignAta })
    ).rejects.toThrow(/WrongTokenMint|0x1963/);
  });

  it("rejects user_quote_ata with wrong mint (WrongTokenMint)", async () => {
    const { ata: foreignAta } = await makeOwnedAta(ctx, fx.user.publicKey);
    await expect(
      buildSwapIx({ userQuoteAta: foreignAta })
    ).rejects.toThrow(/WrongTokenMint|0x1963/);
  });

  it("rejects user_base_ata whose authority is not the user (WrongAccountOwner)", async () => {
    // ATA for `fx.baseMint`, but owned by a stranger.
    const stranger = Keypair.generate();
    await fundAccount(ctx.provider, stranger.publicKey, 1);
    const strangerAta = getAssociatedTokenAddressSync(
      fx.baseMint,
      stranger.publicKey
    );
    await ctx.provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          ctx.payer.publicKey,
          strangerAta,
          stranger.publicKey,
          fx.baseMint
        )
      ),
      [ctx.payer]
    );
    await expect(
      buildSwapIx({ userBaseAta: strangerAta })
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });

  it("rejects pool_state owned by a different program (WrongAccountOwner)", async () => {
    // Use a SystemProgram-owned account (the user's own wallet) in the pool
    // slot — owner check (`verify_owner_program(pool_info, &PROGRAM_ID)`)
    // catches it.
    await expect(
      buildSwapIx({ poolState: fx.user.publicKey })
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });
});

// ============================================================================
// admin_withdraw_inventory — account substitution attacks
// ============================================================================

describe("security — admin_withdraw_inventory substitution", () => {
  let ctx: TestContext;
  let fx: PoolFixture;

  beforeAll(async () => {
    ctx = await setupTestContext();
    fx = await setupPool(ctx, nextSeed());
    await fundVaults(ctx, fx);
  });

  function buildWithdrawIx(overrides: Record<string, PublicKey> = {}) {
    return ctx.program.methods
      .adminWithdrawInventory(new BN(1), new BN(1))
      .accountsPartial({
        admin: fx.admin.publicKey,
        poolState: fx.poolState,
        baseVault: fx.baseVault,
        quoteVault: fx.quoteVault,
        adminBaseAta: fx.adminBaseAta,
        adminQuoteAta: fx.adminQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        ...overrides,
      })
      .signers([fx.admin])
      .rpc();
  }

  it("baseline withdraw succeeds (sanity)", async () => {
    await buildWithdrawIx();
  });

  it("rejects wrong token_program (WrongAccountAddress)", async () => {
    await expect(
      buildWithdrawIx({ tokenProgram: SystemProgram.programId })
    ).rejects.toThrow(/WrongAccountAddress|0x1965/);
  });

  it("rejects wrong base_vault address (WrongAccountAddress)", async () => {
    const otherPool = await setupPool(ctx, nextSeed());
    await expect(
      buildWithdrawIx({ baseVault: otherPool.baseVault })
    ).rejects.toThrow(/WrongAccountAddress|0x1965/);
  });

  it("rejects admin_base_ata wrong mint (WrongTokenMint)", async () => {
    const { ata: foreignAta } = await makeOwnedAta(ctx, fx.admin.publicKey);
    await expect(
      buildWithdrawIx({ adminBaseAta: foreignAta })
    ).rejects.toThrow(/WrongTokenMint|0x1963/);
  });

  it("rejects admin_base_ata authority != admin (WrongAccountOwner)", async () => {
    // ATA for fx.baseMint but owned by a stranger.
    const stranger = Keypair.generate();
    await fundAccount(ctx.provider, stranger.publicKey, 1);
    const strangerAta = getAssociatedTokenAddressSync(
      fx.baseMint,
      stranger.publicKey
    );
    await ctx.provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          ctx.payer.publicKey,
          strangerAta,
          stranger.publicKey,
          fx.baseMint
        )
      ),
      [ctx.payer]
    );
    await expect(
      buildWithdrawIx({ adminBaseAta: strangerAta })
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });

  it("rejects pool_state owned by wrong program (WrongAccountOwner)", async () => {
    await expect(
      buildWithdrawIx({ poolState: fx.admin.publicKey })
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });
});

// ============================================================================
// update_oracle — substitution
// ============================================================================

describe("security — update_oracle substitution", () => {
  let ctx: TestContext;
  let fx: PoolFixture;

  beforeAll(async () => {
    ctx = await setupTestContext();
    fx = await setupPool(ctx, nextSeed());
  });

  function buildOracleIx(
    nonce: number,
    overrides: Record<string, PublicKey> = {}
  ) {
    return ctx.program.methods
      .updateOracle(
        new BN(100_000_000),
        20,
        defaultDepthParams(),
        defaultSkewParams(),
        new BN(nonce),
        3
      )
      .accountsPartial({
        oracleSigner: fx.oracleSigner.publicKey,
        poolState: fx.poolState,
        ...overrides,
      })
      .signers([fx.oracleSigner])
      .rpc();
  }

  let nonceCounter = 1;

  it("baseline oracle update succeeds (sanity)", async () => {
    await buildOracleIx(nonceCounter++);
  });

  it("rejects pool_state owned by wrong program (WrongAccountOwner)", async () => {
    await expect(
      buildOracleIx(nonceCounter++, { poolState: fx.admin.publicKey })
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });

  it("rejects pool_state from another pool (UnauthorizedOracle)", async () => {
    // Different pool has a different authorized_oracle_signer.
    const otherPool = await setupPool(ctx, nextSeed());
    await expect(
      buildOracleIx(nonceCounter++, { poolState: otherPool.poolState })
    ).rejects.toThrow(/UnauthorizedOracle|0x1838/);
  });
});

// ============================================================================
// close_expired_nonce — substitution
// ============================================================================

describe("security — close_expired_nonce substitution", () => {
  let ctx: TestContext;
  let fx: PoolFixture;
  let marker: PublicKey;

  beforeAll(async () => {
    ctx = await setupTestContext();
    fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 0 });
    await fundVaults(ctx, fx);
    // Initialize a real marker via an RFQ swap so we have something to close.
    const currentSlot = await ctx.provider.connection.getSlot();
    const nonce = BigInt(Date.now()) + 9_999n;
    const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
      fx.quoteSigner,
      {
        pool: fx.poolState,
        user: fx.user.publicKey,
        direction: "sell",
        inputAmount: 1_000n,
        price: 100_000_000n,
        expirySlot: BigInt(currentSlot + 1),
        nonce,
      }
    );
    [marker] = deriveQuoteNonceMarker(fx.poolState, nonce);
    const swapIx = await ctx.program.methods
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
      .remainingAccounts([
        { pubkey: marker, isSigner: false, isWritable: true },
      ])
      .instruction();
    await ctx.provider.sendAndConfirm(
      new Transaction().add(verifyIx).add(swapIx),
      [fx.user]
    );
  });

  it("rejects pool_state owned by wrong program (WrongAccountOwner)", async () => {
    await expect(
      ctx.program.methods
        .closeExpiredNonce()
        .accountsPartial({
          closer: fx.admin.publicKey,
          poolState: fx.admin.publicKey,
          quoteNonceMarker: marker,
        })
        .signers([fx.admin])
        .rpc()
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });

  it("rejects marker owned by wrong program (WrongAccountOwner)", async () => {
    await expect(
      ctx.program.methods
        .closeExpiredNonce()
        .accountsPartial({
          closer: fx.admin.publicKey,
          poolState: fx.poolState,
          quoteNonceMarker: fx.admin.publicKey,
        })
        .signers([fx.admin])
        .rpc()
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });
});

// ============================================================================
// propose_admin / accept_admin / cancel_admin_proposal — substitution
// ============================================================================

describe("security — admin-proposal substitution", () => {
  let ctx: TestContext;
  let fx: PoolFixture;

  beforeAll(async () => {
    ctx = await setupTestContext();
    fx = await setupPool(ctx, nextSeed());
  });

  it("propose_admin rejects pool_state owned by wrong program (WrongAccountOwner)", async () => {
    const newAdmin = Keypair.generate();
    const [adminProposal] = deriveAdminProposal(fx.poolState);
    await expect(
      ctx.program.methods
        .proposeAdmin(newAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.admin.publicKey, // ← system-owned, not program-owned
          adminProposal,
        })
        .signers([fx.admin])
        .rpc()
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });

  it("propose_admin rejects when admin_proposal is not the canonical PDA (WrongPda)", async () => {
    const newAdmin = Keypair.generate();
    // Wrong proposal address: just use a random key. Pinocchio's `find_program_address`
    // check rejects since it won't match the canonical derivation.
    const wrongProposal = Keypair.generate().publicKey;
    await expect(
      ctx.program.methods
        .proposeAdmin(newAdmin.publicKey)
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: fx.poolState,
          adminProposal: wrongProposal,
        })
        .signers([fx.admin])
        .rpc()
    ).rejects.toThrow(/WrongPda|0x1960/);
  });

  it("accept_admin rejects pool_state owned by wrong program (WrongAccountOwner)", async () => {
    // Set up a real proposal first.
    const newAdmin = Keypair.generate();
    await fundAccount(ctx.provider, newAdmin.publicKey, 1);
    const fx2 = await setupPool(ctx, nextSeed());
    const [adminProposal] = deriveAdminProposal(fx2.poolState);
    await ctx.program.methods
      .proposeAdmin(newAdmin.publicKey)
      .accountsPartial({
        admin: fx2.admin.publicKey,
        poolState: fx2.poolState,
        adminProposal,
      })
      .signers([fx2.admin])
      .rpc();

    // Now try to accept with a foreign system-owned pubkey in pool slot.
    await expect(
      ctx.program.methods
        .acceptAdmin()
        .accountsPartial({
          newAdmin: newAdmin.publicKey,
          poolState: newAdmin.publicKey,
          adminProposal,
        })
        .signers([newAdmin])
        .rpc()
    ).rejects.toThrow(/WrongAccountOwner|0x195f/);
  });
});

// ============================================================================
// init_pool — remaining input-validation branches
// ============================================================================

describe("security — init_pool input validation (extra coverage)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  // Helper to construct a fresh init_pool tx with arbitrary args.
  async function tryInit(opts: {
    sameMintForBoth?: boolean;
    initialModeTtl?: number;
    spreadBps?: number;
    fairValue?: BN;
    depthMaxBps?: number;
    depthSizeUnit?: BN;
    skewMaxOffset?: number;
    skewTargetBps?: number;
  }): Promise<string> {
    const admin = Keypair.generate();
    const oracleSigner = Keypair.generate();
    await fundAccount(ctx.provider, admin.publicKey, 20);
    const mintA = await createMint(
      ctx.provider.connection,
      ctx.payer,
      ctx.payer.publicKey,
      null,
      6
    );
    const mintB = opts.sameMintForBoth
      ? mintA
      : await createMint(
          ctx.provider.connection,
          ctx.payer,
          ctx.payer.publicKey,
          null,
          6
        );
    const [base, quote] = opts.sameMintForBoth
      ? [mintA, mintA]
      : sortMints(mintA, mintB);
    const [poolState] = derivePoolState(base, quote);
    const [baseVault] = deriveVault(poolState, base);
    const [quoteVault] = deriveVault(poolState, quote);

    return ctx.program.methods
      .initPool(
        oracleSigner.publicKey,
        oracleSigner.publicKey, // same-key default
        opts.fairValue ?? new BN(100_000_000),
        opts.spreadBps ?? 20,
        {
          ...defaultDepthParams(),
          maxDepthBps: opts.depthMaxBps ?? 100,
          sizeUnit: opts.depthSizeUnit ?? new BN(1_000_000),
        },
        {
          ...defaultSkewParams(),
          maxSkewOffsetBps: opts.skewMaxOffset ?? 100,
          targetBaseBps: opts.skewTargetBps ?? 5_000,
        },
        opts.initialModeTtl ?? 0
      )
      .accountsPartial({
        admin: admin.publicKey,
        poolState,
        baseMint: base,
        quoteMint: quote,
        baseVault,
        quoteVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();
  }

  it("rejects base_mint == quote_mint (InvalidMintPair)", async () => {
    await expect(tryInit({ sameMintForBoth: true })).rejects.toThrow(
      /InvalidMintPair|0x17d4/
    );
  });

  it("rejects TTL > MAX_TTL_SLOTS (InvalidTtl)", async () => {
    await expect(tryInit({ initialModeTtl: 9 })).rejects.toThrow(
      /InvalidTtl|0x17d6/
    );
  });

  it("rejects depth.max_depth_bps > MAX_DEPTH_BPS (InvalidDepthParams)", async () => {
    await expect(tryInit({ depthMaxBps: 501 })).rejects.toThrow(
      /InvalidDepthParams|0x17da/
    );
  });

  it("rejects depth.size_unit == 0 (InvalidDepthParams)", async () => {
    await expect(tryInit({ depthSizeUnit: new BN(0) })).rejects.toThrow(
      /InvalidDepthParams|0x17da/
    );
  });

  it("rejects skew.max_skew_offset > MAX_SKEW_OFFSET_BPS (InvalidSkewParams)", async () => {
    await expect(tryInit({ skewMaxOffset: 501 })).rejects.toThrow(
      /InvalidSkewParams|0x17db/
    );
  });

  it("rejects skew.target_base_bps > BPS_DENOMINATOR (InvalidSkewParams)", async () => {
    await expect(tryInit({ skewTargetBps: 10_001 })).rejects.toThrow(
      /InvalidSkewParams|0x17db/
    );
  });
});

// ============================================================================
// execute_swap RFQ path — marker PDA tampering
// ============================================================================

describe("security — execute_swap RFQ marker PDA", () => {
  let ctx: TestContext;
  let fx: PoolFixture;

  beforeAll(async () => {
    ctx = await setupTestContext();
    fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 0 });
    await fundVaults(ctx, fx);
  });

  it("rejects RFQ swap with a marker PDA derived from a DIFFERENT nonce (WrongPool)", async () => {
    const currentSlot = await ctx.provider.connection.getSlot();
    const nonce = BigInt(Date.now()) + 29_999n;
    const wrongNonce = nonce + 1n;
    const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
      fx.quoteSigner,
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
    // SDK derives marker from `wrongNonce`, but the quote inside `signedQuote`
    // uses `nonce`. The on-chain handler derives the expected marker PDA from
    // `signed_quote.nonce` and compares it against the passed account.
    const [wrongMarker] = deriveQuoteNonceMarker(fx.poolState, wrongNonce);
    const swapIx = await ctx.program.methods
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
      .remainingAccounts([
        { pubkey: wrongMarker, isSigner: false, isWritable: true },
      ])
      .instruction();
    await expect(
      ctx.provider.sendAndConfirm(
        new Transaction().add(verifyIx).add(swapIx),
        [fx.user]
      )
    ).rejects.toThrow(/WrongPool|0x1964/);
  });

  it("rejects RFQ swap with a marker PDA derived for a DIFFERENT pool (WrongPool)", async () => {
    // Two pools, the attacker reuses the marker derivation for the wrong pool.
    const otherPool = await setupPool(ctx, nextSeed(), { initialModeTtl: 0 });
    const currentSlot = await ctx.provider.connection.getSlot();
    const nonce = BigInt(Date.now()) + 39_999n;
    const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
      fx.quoteSigner,
      {
        pool: fx.poolState, // quote is bound to fx.poolState
        user: fx.user.publicKey,
        direction: "sell",
        inputAmount: 1_000n,
        price: 100_000_000n,
        expirySlot: BigInt(currentSlot + 200),
        nonce,
      }
    );
    // ...but the marker PDA is derived for OTHER pool. On-chain expects
    // `find_program_address([QUOTE_USED_SEED, fx.poolState, nonce])`.
    const [foreignPoolMarker] = deriveQuoteNonceMarker(
      otherPool.poolState,
      nonce
    );
    const swapIx = await ctx.program.methods
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
      .remainingAccounts([
        { pubkey: foreignPoolMarker, isSigner: false, isWritable: true },
      ])
      .instruction();
    await expect(
      ctx.provider.sendAndConfirm(
        new Transaction().add(verifyIx).add(swapIx),
        [fx.user]
      )
    ).rejects.toThrow(/WrongPool|0x1964/);
  });
});

// ============================================================================
// Discriminator integrity
// ============================================================================
//
// The Pinocchio port relies on an 8-byte type tag at offset 0 of each state
// account to distinguish PoolState / QuoteNonceMarker / AdminRotationProposal.
// If a handler accepts an account whose discriminator doesn't match, every
// downstream invariant (admin check, has_one, etc.) is meaningless. The
// discriminator check is `state::*::load`, called from `from_account_view`.

describe("security — discriminator integrity", () => {
  let ctx: TestContext;
  let fx: PoolFixture;
  let markerPda: PublicKey;

  beforeAll(async () => {
    ctx = await setupTestContext();
    fx = await setupPool(ctx, nextSeed(), { initialModeTtl: 0 });
    await fundVaults(ctx, fx);
    // Create a real QuoteNonceMarker so we have a program-owned account
    // whose discriminator is `0x02` (QUOTE_NONCE_MARKER), not `0x01` (POOL_STATE).
    const currentSlot = await ctx.provider.connection.getSlot();
    const nonce = BigInt(Date.now()) + 19_999n;
    const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(
      fx.quoteSigner,
      {
        pool: fx.poolState,
        user: fx.user.publicKey,
        direction: "sell",
        inputAmount: 1_000n,
        price: 100_000_000n,
        expirySlot: BigInt(currentSlot + 1),
        nonce,
      }
    );
    [markerPda] = deriveQuoteNonceMarker(fx.poolState, nonce);
    const swapIx = await ctx.program.methods
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
      .remainingAccounts([
        { pubkey: markerPda, isSigner: false, isWritable: true },
      ])
      .instruction();
    await ctx.provider.sendAndConfirm(
      new Transaction().add(verifyIx).add(swapIx),
      [fx.user]
    );
  });

  it("update_oracle rejects pool_state slot occupied by a QuoteNonceMarker (WrongDiscriminator)", async () => {
    await expect(
      ctx.program.methods
        .updateOracle(
          new BN(100_000_000),
          20,
          defaultDepthParams(),
          defaultSkewParams(),
          new BN(7_777),
          3
        )
        .accountsPartial({
          oracleSigner: fx.oracleSigner.publicKey,
          poolState: markerPda, // program-owned but wrong tag
        })
        .signers([fx.oracleSigner])
        .rpc()
    ).rejects.toThrow(/WrongDiscriminator|0x195e/);
  });

  it("admin_withdraw_inventory rejects pool_state slot occupied by a QuoteNonceMarker (WrongDiscriminator)", async () => {
    await expect(
      ctx.program.methods
        .adminWithdrawInventory(new BN(1), new BN(1))
        .accountsPartial({
          admin: fx.admin.publicKey,
          poolState: markerPda,
          baseVault: fx.baseVault,
          quoteVault: fx.quoteVault,
          adminBaseAta: fx.adminBaseAta,
          adminQuoteAta: fx.adminQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fx.admin])
        .rpc()
    ).rejects.toThrow(/WrongDiscriminator|0x195e/);
  });
});
