# Specification

> On-chain instruction interface, parameters, validation, error codes, and
> constants. The contract between the on-chain program and its clients (SDK,
> keeper, RFQ-webhook consumers).
>
> **Always read this file before implementing or modifying an instruction.**

**Related docs:** [ARCHITECTURE.md](ARCHITECTURE.md) · [OPERATIONS.md](OPERATIONS.md)

---

## 1. Overview

The settlement program is a single-MM-operated hybrid PropAMM-RFQ venue.

| Instruction                  | Caller                                     | Frequency                                                  |
|------------------------------|--------------------------------------------|------------------------------------------------------------|
| `init_pool`                  | Admin                                      | Once per pair (at creation)                                |
| `update_oracle`              | Oracle worker                              | Mode A: every 100–200ms; Mode B: when thresholds exceeded   |
| `execute_swap`               | User (typically via Jupiter router)        | Every trade                                                |
| `set_paused`                 | Admin                                      | Emergencies                                                |
| `rotate_oracle_signer`       | Admin                                      | On key rotation                                            |
| `admin_withdraw_inventory`   | Admin                                      | Inventory pulls / PnL settlement                            |
| `rotate_admin`               | Admin                                      | Admin-key handoff                                          |
| `close_expired_nonce`        | Keeper / anyone                            | Periodically (rent reclaim)                                |

Design rationale is in [../CLAUDE.md](../CLAUDE.md) "Project Overview"; mode
definitions are in [OPERATIONS.md §1](OPERATIONS.md#1-3-tier-mode-definition).

**v1 scope limits:**
- **SPL Token (classic) only**. No Token-2022 extension support (xStocks and USDC are both classic — sufficient). Token-2022 is a v2 consideration.
- **Trade interface = ExactIn** (user specifies the paid amount; the received amount is bounded below by `min_output`).
- **Single `execute_swap` instruction** — the curve and RFQ paths share one instruction for JupiterZ compatibility. When the RFQ path is needed, the client attaches a `quote_nonce_marker` via `remaining_accounts` and prepends an ed25519 verify instruction in the same transaction.

**Ed25519 signature verification pattern:**

The standard Solana pattern is to prepend a verify instruction (using the
native ed25519 program / precompile at address
`Ed25519SigVerify111111111111111111111111111`) into the same transaction.
`execute_swap` then reads the previous instruction through the `Instructions`
sysvar to confirm that (a) it really is an ed25519 verify, (b) the verified
public key matches `pool_state.authorized_oracle_signer`, and (c) the message
matches the canonical bytes of `SignedQuote`. The SDK prepends the verify
instruction automatically.

---

## 2. State

### 2.1 `PoolState`

```rust
#[account]
pub struct PoolState {
    // Authority
    pub admin: Pubkey,                       // Pool admin (init/pause/rotate)
    pub authorized_oracle_signer: Pubkey,    // Single key allowed to call update_oracle

    // Pair identifiers
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,

    // Vault
    pub base_vault: Pubkey,                  // PDA-owned base token account
    pub quote_vault: Pubkey,                 // PDA-owned quote token account

    // Pricing parameters (pushed by the oracle worker)
    pub fair_value: u64,                     // anchor price (quote per base, scaled)
    pub spread_bps: u16,                     // base spread (bps)
    pub depth_curve_params: DepthParams,     // depth function (see §2.2)
    pub inventory_skew_params: SkewParams,   // inventory-driven skew

    // Freshness tracking
    pub last_oracle_update_slot: u64,
    pub oracle_nonce: u64,                   // monotonic update_oracle counter; blocks replay
    pub current_mode_ttl: u8,                // 0 = forced stale; 1..=MAX_TTL_SLOTS otherwise

    // Bumps (saves the CPI signer-seed reconstruction cost)
    pub bump: u8,
    pub base_vault_bump: u8,
    pub quote_vault_bump: u8,

    // Kill switch
    pub paused: bool,                        // Admin-toggled; when true, all swaps reject

    // Reserved
    pub _reserved: [u8; 64],
}
```

> **Reserves sync**: PoolState does not have `reserves_*` fields. `execute_swap`
> always reads `base_vault.amount` / `quote_vault.amount` directly. Reason:
> external mint/redeem (issuer flow) is reflected instantly without a separate
> sync step. Same-slot multi-trades stay consistent because Solana refreshes
> account state between instructions automatically. (Caveat: anyone can
> transfer into the vault — we treat that as free liquidity; the MM is not
> harmed.)

### 2.2 Helper structs

The v0 curve is a **Linear-bps quote curve** (a Drift v3 reservation-price
variant). We don't use `x·y=k` — vault balances are settlement inventory (the
MM hedges/rebalances externally), not "real liquidity". u128 integer-ratio is
used throughout (details in [../CLAUDE.md "On-Chain Math"](../CLAUDE.md)).

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct DepthParams {
    /// Extra spread (bps) added per `size_unit` of user size.
    /// Example: size_unit=1_000_000 (= 1.0 base), depth_coef_bps=2 → +2 bps slippage per base.
    pub depth_coef_bps: u32,

    /// Unit size that depth_coef_bps applies to (base raw token amount).
    pub size_unit: u64,

    /// Upper cap on depth_bps (bps). Prevents runaway widening.
    pub max_depth_bps: u16,

    pub _reserved: [u8; 6],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct SkewParams {
    /// Target base weight (bps of total quote-denominated value).
    /// 5000 = 50% base / 50% quote (delta-neutral).
    pub target_base_bps: u16,

    /// Per-bps-of-imbalance offset added to mid (bps).
    pub skew_coef_bps: u16,

    /// Absolute cap on skew_offset (bps). Prevents runaway widening.
    pub max_skew_offset_bps: u16,

    pub _reserved: [u8; 10],
}
```

**Curve evaluation (pseudo-code; landing in `math/curve.rs`):**

```rust
fn evaluate(
    fair_value: u64,            // PRICE_SCALE units
    spread_bps: u16,
    depth: &DepthParams,
    skew: &SkewParams,
    reserves_base: u64,         // direct vault.amount
    reserves_quote: u64,        // direct vault.amount
    input_amount: u64,          // ExactIn: Buy → quote units, Sell → base units
    direction: Side,
) -> Result<u64 /* execution price */> {
    // [ExactIn unit conversion]
    // depth_bps must be computed in *base equivalent* for consistency.
    // Buy (input=quote) → convert to base via fair_value:
    //   base_eq = input × PRICE_SCALE / fair_value
    // Sell (input=base) → use as-is
    let size_base_equiv = match direction {
        Side::Buy  => mul_div(input_amount, PRICE_SCALE, fair_value)?,
        Side::Sell => input_amount,
    };
    // 1) Normalize the inventory imbalance to signed bps.
    //    Sign convention: +ve ⇒ base is *short* of target (quote-heavy; MM wants to buy base)
    //                     -ve ⇒ base is *long*  of target (base-heavy;  MM wants to sell base)
    let current_base_value = mul_div(reserves_base, fair_value, PRICE_SCALE)?;
    let total_value        = current_base_value.checked_add(reserves_quote)?;
    let target_base_value  = mul_div(total_value, skew.target_base_bps as u64, 10_000)?;
    // imbalance_bps = (target - current) * 10000 / total_value   (signed)
    let imbalance_bps      = signed_diff_bps(target_base_value, current_base_value, total_value);

    // 2) Skew offset: push mid up when base is short (+), down when long (-).
    //    → base-heavy (imbalance<0) ⇒ mid drops ⇒ MM sells base more easily
    //    → quote-heavy (imbalance>0) ⇒ mid rises ⇒ MM sells quote more easily (i.e., wants to buy base)
    let skew_offset_bps = clamp(
        imbalance_bps * skew.skew_coef_bps as i64 / 10_000,
        -(skew.max_skew_offset_bps as i64),
         (skew.max_skew_offset_bps as i64),
    );

    // 3) Depth (linear in *base-equivalent* size, capped).
    let depth_bps_raw = mul_div(size_base_equiv, depth.depth_coef_bps as u64, depth.size_unit)?;
    let depth_bps     = depth_bps_raw.min(depth.max_depth_bps as u64);

    // 4) Direction-aware composition
    //    Treat skew_offset as a mid_shift:
    //       effective_mid = fair_value * (10000 + skew_offset) / 10000
    //       Buy_price     = effective_mid * (10000 + half_spread + depth_bps) / 10000
    //       Sell_price    = effective_mid * (10000 - half_spread - depth_bps) / 10000
    //    Small-bps approximation:
    let half_spread = (spread_bps as i64) / 2;
    let total_bps = match direction {
        Side::Buy  =>   skew_offset_bps + half_spread + depth_bps as i64,
        Side::Sell =>   skew_offset_bps - half_spread - depth_bps as i64,
    };

    let price = match direction {
        Side::Buy  => mul_div(fair_value, (10_000 + total_bps) as u64, 10_000)?,
        Side::Sell => mul_div(fair_value, (10_000 + total_bps) as u64, 10_000)?,
    };
    Ok(price)
}
```

**Rounding (matches the CLAUDE.md rules; ExactIn):**
- Buy: input is quote (fixed); output is base (user receives) → `base_out = input_amount × PRICE_SCALE / price`, **floor**.
- Sell: input is base (fixed); output is quote (user receives) → `quote_out = input_amount × price / PRICE_SCALE`, **floor**.
- Both cases floor the *amount the user receives* → protects the protocol (protocol pays less).

**CU estimate**: 4–6 u128 multiplies/divides + branches → ~5–8k CU. Comfortably inside `execute_swap`'s 30–60k CU budget.

**In-slot consistency**: the price is a pure function of
`(fair_value, spread_bps, depth, skew, reserves)`. Same-slot multi-trades stay
consistent because reserves are refreshed between trades. The invariant
"`update_oracle` never touches reserves" ([§3.2](#32-update_oracle)) is what
preserves this property.

### 2.3 `SignedQuote` (instruction argument; not an account)

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SignedQuote {
    pub pool: Pubkey,            // PoolState address (prevents rebinding)
    pub user: Pubkey,            // The user this quote was issued for
    pub direction: Side,         // Buy or Sell
    pub input_amount: u64,       // ExactIn: the input token amount the user *pays*
                                 //   Buy  → quote units
                                 //   Sell → base units
    pub price: u64,              // Execution price (quote per base, PRICE_SCALE-encoded)
    pub expiry_slot: u64,        // Expiry slot
    pub nonce: u64,              // **Required**; blocks replay (enforced by QuoteNonceMarker)
    pub signature: [u8; 64],     // ed25519 signature over the canonical bytes (signature excluded)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Buy,    // user buys base (quote → base, user pays quote)
    Sell,   // user sells base (base → quote, user pays base)
}
```

> **Trade interface = ExactIn**: the user specifies the *amount of the input
> token they pay*. The received output floats with price; `min_output` bounds
> it from below. Same convention as Jupiter / Uniswap ExactIn.

**Canonical signing format (must be implemented identically by SDK / RFQ webhook / on-chain):**

```rust
// The signed payload = the SignedQuote struct minus the signature field, Borsh-serialized.
pub struct SignedQuoteMessage {
    pub pool: Pubkey,        // 32 bytes
    pub user: Pubkey,        // 32 bytes
    pub direction: Side,     // 1 byte (Borsh enum discriminant: Buy=0, Sell=1)
    pub input_amount: u64,   // 8 bytes (little-endian)
    pub price: u64,          // 8 bytes
    pub expiry_slot: u64,    // 8 bytes
    pub nonce: u64,          // 8 bytes
}
// Total: 97 bytes.
```

| Item                  | Value                                                                                                                                                                                                                       |
|---|---|
| Serialization         | **Borsh** (Anchor default). Field order follows the struct declaration.                                                                                                                                                       |
| Side enum encoding    | Borsh enum: 1 byte (Buy=0, Sell=1).                                                                                                                                                                                          |
| Signature algorithm   | **Ed25519**.                                                                                                                                                                                                                  |
| Signer key            | The ed25519 private key matching `pool_state.authorized_oracle_signer`.                                                                                                                                                       |
| Verification location | Solana's native `Ed25519SigVerify111111111111111111111111111` precompile (verify instruction prepended in the same transaction). `execute_swap` cross-checks the verify result + message + public key via the Instructions sysvar. |

> SDK / RFQ webhook / on-chain verify code **must use the same serialization
> library (Borsh) and field order**. Any mismatch fails verification with
> `QuoteSignatureInvalid` (code 6306).

### 2.4 `QuoteNonceMarker` (replay-guard PDA account)

```rust
#[account]
pub struct QuoteNonceMarker {
    pub pool: Pubkey,         // Which pool this nonce belongs to.
    pub nonce: u64,           // The nonce value this marker represents.
    pub expiry_slot: u64,     // Used to determine when close is allowed.
    pub bump: u8,
    pub _reserved: [u8; 7],
}
```

- **PDA seeds**: `[b"quote_used", pool, nonce.to_le_bytes()]`
- **Lifecycle**:
  - `execute_swap` **forces init** → already existing means the instruction fails = replay blocked.
  - Once `expiry_slot + SAFETY_BUFFER_SLOTS < current_slot`, the `close_expired_nonce` instruction can close the account and reclaim rent.
- **Sliding-bitmap effect**: nonce slots are reclaimed after use → no permanent occupancy. The SAFETY_BUFFER prevents a "close → reuse same nonce" attack.

**MM nonce-issuance policy (operational rule):**
- The RFQ webhook issues a **monotonically increasing nonce** per quote (e.g., microsecond timestamp or an atomic counter).
- Never reuse the same nonce for a different quote.
- The u64 nonce space (~1.8 × 10^19) makes collisions effectively impossible.
- Reusing a nonce after close is forbidden at the policy level (the program would allow it, but we forbid it operationally).
- The keeper batches `close_expired_nonce` calls periodically → rent reclaim becomes efficient ([OPERATIONS.md §6](OPERATIONS.md)).

---

## 3. Instructions

### 3.1 `init_pool`

**Purpose:** Initialize a new (base, quote) pool.

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `authorized_oracle_signer` | Pubkey      | The single key allowed to call update_oracle         |
| `initial_fair_value`       | u64         | Initial fair value                                   |
| `initial_spread_bps`       | u16         | Initial spread (bps)                                 |
| `initial_depth_params`     | DepthParams | Initial depth parameters                             |
| `initial_skew_params`      | SkewParams  | Initial skew parameters                              |
| `initial_mode_ttl`         | u8          | Initial TTL (typically 0 = start in Mode C)          |

**Accounts:**

| Account | Type | Mut | Signer | Description |
|---|---|---|---|---|
| `admin`          | Signer       | No  | Yes    | Pool admin (also the transaction fee payer)          |
| `pool_state` | PoolState | Yes | No | PDA: `[b"pool", base_mint, quote_mint]` |
| `base_mint`      | Mint         | No  | No     | base-token mint                                      |
| `quote_mint`     | Mint         | No  | No     | quote-token mint                                     |
| `base_vault` | TokenAccount | Yes | No | PDA: `[b"vault", pool_state, base_mint]` |
| `quote_vault` | TokenAccount | Yes | No | PDA: `[b"vault", pool_state, quote_mint]` |
| `token_program` | Program | No | No | SPL Token program |
| `system_program` | Program | No | No | System Program |

**Validations:**
- `base_mint != quote_mint` → `InvalidMintPair`
- `base_mint < quote_mint` (sorting enforced) → `MintsNotSorted`
- `initial_mode_ttl <= MAX_TTL_SLOTS` → `InvalidTtl`
- `initial_fair_value > 0` → `InvalidFairValue`
- `initial_spread_bps <= MAX_SPREAD_BPS` → `InvalidSpread`

**Logic (3-phase):**
1. Phase 1 (validation): the checks above.
2. Phase 2 (CPI): none. PoolState / vault init is handled by Anchor's `#[account(init)]`.
3. Phase 3 (state): populate PoolState fields, set `paused = false` (trading available immediately on init — PoC convenience), `oracle_nonce = 0`, `last_oracle_update_slot = Clock::get()?.slot`.

> `initial_fair_value > 0` is enforced, so the curve can be evaluated even
> immediately after init. With `initial_mode_ttl = 0` (Mode C), the curve is
> stale and only the RFQ path works — a natural safe-start state. If a
> stricter start posture is required in production, the admin can call
> `set_paused(true)` after init and unpause after review.

**Recommended operational procedure** (PoC stage):
1. Admin calls `init_pool` (`initial_mode_ttl=0`, `paused=false` from the start).
2. Admin deposits base / quote tokens into the vaults (buy market → ATA → SPL Token transfer).
3. Verify the RFQ webhook is responding (`/quote`, `/swap`, `/tokens`).
4. Oracle worker pushes the first `update_oracle` (sets TTL — typically starting in Mode B).
5. Verify vault balance + freshness from the admin dashboard.
6. Start accepting user trades.

---

### 3.2 `update_oracle`

**Purpose:** The oracle worker updates pricing parameters. **Reserves are NEVER modified.**

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `new_fair_value`   | u64         | New fair value               |
| `new_spread_bps`   | u16         | New base spread              |
| `new_depth_params` | DepthParams | New depth parameters         |
| `new_skew_params`  | SkewParams  | New skew parameters          |
| `new_nonce` | u64 | monotonic nonce |
| `new_ttl`          | u8          | New TTL (determines the mode)|

**Accounts:**

| Account | Type | Mut | Signer | Description |
|---|---|---|---|---|
| `oracle_signer` | Signer    | No  | Yes    | Must equal `pool_state.authorized_oracle_signer`                  |
| `pool_state` | PoolState | Yes | No | PDA: `[b"pool", base_mint, quote_mint]` |

**Validations:**
- `oracle_signer.key() == pool_state.authorized_oracle_signer` → `UnauthorizedOracle`
- `new_nonce > pool_state.oracle_nonce` → `NonceNotMonotonic`
- `new_ttl <= MAX_TTL_SLOTS` → `InvalidTtl`
- `new_fair_value > 0` → `InvalidFairValue`
- `new_spread_bps <= MAX_SPREAD_BPS` → `InvalidSpread`
- `!pool_state.paused` → `PoolPaused`

**Logic (3-phase):**
1. Phase 1 (validation): the checks above. (v0 decision: no movement guard — revisit after Stage 1 data.)
2. Phase 2 (CPI): none.
3. Phase 3 (state):
   - `pool_state.fair_value = new_fair_value`
   - `pool_state.spread_bps = new_spread_bps`
   - `pool_state.depth_curve_params = new_depth_params`
   - `pool_state.inventory_skew_params = new_skew_params`
   - `pool_state.oracle_nonce = new_nonce`
   - `pool_state.current_mode_ttl = new_ttl`
   - `pool_state.last_oracle_update_slot = Clock::get()?.slot`
   - **Reserves are NOT touched** (invariant).

---

### 3.3 `execute_swap`

**Purpose:** User swap. When the curve is fresh, run the PropAMM mode; when stale, fall back to RFQ.

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `input_amount`     | u64                   | **The input token amount the user pays (ExactIn).** Buy → quote units; Sell → base units.                                                  |
| `direction` | Side | Buy or Sell |
| `min_output`       | u64                   | Slippage protection: minimum output the user must receive. Buy → minimum base, Sell → minimum quote.                                       |
| `signed_quote_opt` | Option<SignedQuote>   | Attached quote (optional). Only meaningful on the RFQ path.                                                                                |

> **ExactIn interface**: Whether Buy or Sell, the user specifies the *paid
> amount*; the received amount varies with price but is bounded below by
> `min_output`. Standard Jupiter / Uniswap pattern.

**Accounts:**

| Account                | Type             | Mut | Signer | Description                                                                                                                  |
|------------------------|------------------|-----|--------|------------------------------------------------------------------------------------------------------------------------------|
| `user`                 | Signer           | No  | Yes    | Trader (also rent payer for `quote_nonce_marker` when on the RFQ path)                                                       |
| `pool_state`           | PoolState        | Yes | No     | PDA: `[b"pool", base_mint, quote_mint]`                                                                                       |
| `base_vault`           | TokenAccount     | Yes | No     | PDA: `[b"vault", pool_state, base_mint]`. `amount` is read *directly*                                                         |
| `quote_vault`          | TokenAccount     | Yes | No     | PDA: `[b"vault", pool_state, quote_mint]`. `amount` is read *directly*                                                        |
| `user_base_ata`        | TokenAccount     | Yes | No     | User base ATA                                                                                                                |
| `user_quote_ata`       | TokenAccount     | Yes | No     | User quote ATA                                                                                                               |
| `quote_nonce_marker`   | QuoteNonceMarker | Yes | No     | **Only on the RFQ path.** PDA: `[b"quote_used", pool_state, nonce]`. `init` is enforced (already existing → instruction fails = replay blocked) |
| `token_program`        | Program          | No  | No     | SPL Token                                                                                                                    |
| `system_program`       | Program          | No  | No     | Used to init `quote_nonce_marker`                                                                                            |
| `instructions_sysvar`  | Sysvar           | No  | No     | Required when ed25519 verification is needed                                                                                  |

> On the curve path (the `curve_fresh` branch in Logic below),
> `quote_nonce_marker` is unused. SDKs / users can fill a placeholder via
> Anchor `Option<Account<...>>` or remaining_accounts — to be decided at
> implementation time (TODO).

**Pre-execution validations:**
- `!pool_state.paused` → `PoolPaused`
- `input_amount > 0` → `InvalidSize`
- (RFQ path) An ed25519 verify instruction is prepended immediately before this one in the same transaction (verified via the Instructions sysvar), and that verify proves the canonical `SignedQuote` bytes were signed by `pool_state.authorized_oracle_signer` — must succeed.

**Logic:**

```
// Compute curve_age with underflow safety (Solana fork rollback edge):
// if current_slot < last_oracle_update_slot we treat the curve as stale.
let curve_age = current_slot.saturating_sub(pool_state.last_oracle_update_slot);
let curve_fresh = pool_state.current_mode_ttl > 0
                  && curve_age <= pool_state.current_mode_ttl as u64;

// Decision policy §3.1: curve-first. When the curve is fresh, signed_quote_opt is *ignored*.
let execution_price = if curve_fresh {
    // PropAMM mode: vault.amount is fed in directly (no PoolState.reserves_* field).
    // input_amount is ExactIn — units depend on direction. curve_evaluate converts internally.
    curve::evaluate(
        pool_state.fair_value,
        pool_state.spread_bps,
        &pool_state.depth_curve_params,
        &pool_state.inventory_skew_params,
        base_vault.amount,
        quote_vault.amount,
        input_amount,  // Buy → quote units, Sell → base units
        direction,
    )?
} else if let Some(sq) = signed_quote_opt {
    // RFQ fallback mode.
    require!(sq.pool == pool_state.key(), QuoteWrongPool);
    require!(sq.user == user.key(), QuoteWrongUser);
    require!(sq.direction == direction, QuoteDirectionMismatch);
    require!(sq.input_amount == input_amount, QuoteSizeMismatch);
    require!(current_slot <= sq.expiry_slot, QuoteExpired);
    // ed25519 verify is verified at the transaction level via the Instructions sysvar
    // (see pre-execution validations).

    // Replay block: quote_nonce_marker must be init'd to proceed. If the nonce was already used,
    // Anchor's init will fail.
    // The PDA is manually init'd inside this instruction (Anchor's #[account(init,...)] cannot be
    // conditional). We accept the marker account in ctx.remaining_accounts and run
    // system_program::create_account_invoke_signed ourselves.
    init_quote_nonce_marker_manually(
        ctx.remaining_accounts,
        pool_state.key(),
        sq.nonce,
        sq.expiry_slot,
        user.key(),
    )?;

    // Sanity guard: not applied (§3.3 decision). User protection comes from min_output (slippage).
    sq.price
} else {
    return Err(NoFreshPriceSource);
};

// Output amount (ExactIn).
// price = quote per base (PRICE_SCALE units).
let output_amount = match direction {
    Side::Buy  => {
        // user pays input_amount quote and receives base.
        // base_out = input_amount / price   (user receives → floor)
        mul_div_floor(input_amount, PRICE_SCALE, execution_price)?
    }
    Side::Sell => {
        // user pays input_amount base and receives quote.
        // quote_out = input_amount * price  (user receives → floor)
        mul_div_floor(input_amount, execution_price, PRICE_SCALE)?
    }
};

require!(output_amount >= min_output, SlippageExceeded);

// Phase 2: token transfer (CPI).
//   - Buy:  user_quote_ata → quote_vault (input_amount, quote units)
//           base_vault     → user_base_ata (output_amount, base units; PDA signer)
//   - Sell: user_base_ata  → base_vault (input_amount, base units)
//           quote_vault    → user_quote_ata (output_amount, quote units; PDA signer)

// Phase 3: no PoolState.reserves_* field, so nothing to update. vault.amount is refreshed by the SPL Token CPI.
```

**Validations (post-CPI):**
- vault → user transfer when vault.amount is insufficient → `InsufficientReserves` (returned by SPL Token).
- `output_amount >= min_output` → `SlippageExceeded`

**Invariants:**
- Curve-freshness is decided at the moment of execution — even with same-slot multi-trades, each trade evaluates against the post-previous-trade balance.
- For a sequence `trade1 → update_oracle → trade2`, trade2 evaluating against the new fair_value is the *intended behavior*.
- RFQ quotes are one-shot (`quote_nonce_marker` init enforced).
- The instruction stays single-shape (for JupiterZ integration compatibility).

---

### 3.4 `set_paused` (admin)

**Purpose:** Kill switch. Rejects every `execute_swap`.

| Name | Type | Description |
|---|---|---|
| `paused` | bool | true = pause, false = resume |

| Account | Type | Mut | Signer | Description |
|---|---|---|---|---|
| `admin`            | Signer       | No  | Yes    | Must equal `pool_state.admin`                       |
| `pool_state` | PoolState | Yes | No | — |

**Validations:**
- `admin.key() == pool_state.admin` → `UnauthorizedAdmin`

---

### 3.5 `rotate_oracle_signer` (admin)

**Purpose:** Rotate the oracle worker key. Use immediately on suspected key exposure.

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `new_authorized_oracle_signer`  | Pubkey | New oracle worker key      |

**Accounts:**

| Account | Type | Mut | Signer | Description |
|---|---|---|---|---|
| `admin`            | Signer       | No  | Yes    | Must equal `pool_state.admin`                       |
| `pool_state` | PoolState | Yes | No | — |

**Validations:**
- `admin.key() == pool_state.admin` → `UnauthorizedAdmin`

**Logic:** `pool_state.authorized_oracle_signer = new_authorized_oracle_signer`. Simple swap.

> Immediately after rotation, any in-flight `update_oracle` tx pushed by the
> oracle worker will be rejected (signer mismatch) even with a valid nonce.
> The worker must switch to the new key promptly.

---

### 3.6 `admin_withdraw_inventory`

**Purpose:** Admin pulls tokens from the vaults into their ATA (inventory pull, PnL settlement, replenishment after deposit).

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `withdraw_base_amount`  | u64  | Amount to withdraw from the base vault (0 to skip base)    |
| `withdraw_quote_amount` | u64  | Amount to withdraw from the quote vault (0 to skip quote)  |

**Accounts:**

| Account | Type | Mut | Signer | Description |
|---|---|---|---|---|
| `admin`            | Signer       | No  | Yes    | Must equal `pool_state.admin`                       |
| `pool_state` | PoolState | No | No | — |
| `base_vault` | TokenAccount | Yes | No | `pool_state.base_vault` |
| `quote_vault` | TokenAccount | Yes | No | `pool_state.quote_vault` |
| `admin_base_ata`   | TokenAccount | Yes | No     | Admin's base ATA (recipient)                         |
| `admin_quote_ata`  | TokenAccount | Yes | No     | Admin's quote ATA (recipient)                        |
| `token_program` | Program | No | No | SPL Token |

**Validations:**
- `admin.key() == pool_state.admin` → `UnauthorizedAdmin`
- `withdraw_base_amount > 0 || withdraw_quote_amount > 0` → `InvalidSize`
- `withdraw_base_amount <= base_vault.amount` → `InsufficientReserves`
- `withdraw_quote_amount <= quote_vault.amount` → `InsufficientReserves`

**Logic:** With the PoolState PDA as the signer, transfer vault → admin ATA via the SPL Token program.

> **Deposit procedure**: no dedicated instruction. The admin transfers tokens
> from `admin_ata → vault` via standard SPL Token `transfer` (the vault owner
> is the PoolState PDA, but anyone can deposit — standard SPL Token behavior).
> No spec / program change required.
>
> **Operational note**: inventory pulls affect trading. For large pulls, pause
> first via `set_paused(true)` to operate safely.

---

### 3.7 `rotate_admin`

**Purpose:** Transfer the admin key (operator handoff, Squads multisig migration, ...).

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `new_admin` | Pubkey | New admin pubkey  |

**Accounts:**

| Account | Type | Mut | Signer | Description |
|---|---|---|---|---|
| `admin`      | Signer    | No  | Yes    | Must equal the current `pool_state.admin` |
| `pool_state` | PoolState | Yes | No | — |

**Validations:**
- `admin.key() == pool_state.admin` → `UnauthorizedAdmin`

**Logic:** `pool_state.admin = new_admin`. One-step transfer (PoC simplicity).

> ⚠️ **Mistype risk**: a wrong pubkey permanently locks admin privileges. The
> frontend admin UI should include a confirmation prompt + an upfront check
> that the new admin can reach the pool. In production, holding admin via a
> Squads multisig is the standard.

---

### 3.8 `close_expired_nonce`

**Purpose:** Close a `QuoteNonceMarker` whose `expiry_slot + SAFETY_BUFFER_SLOTS < current_slot` and reclaim its rent. (Sliding-bitmap effect.)

**Parameters:** none.

**Accounts:**

| Account | Type | Mut | Signer | Description |
|---|---|---|---|---|
| `closer`              | Signer           | No  | Yes    | Rent recipient (usually keeper / admin)    |
| `pool_state`          | PoolState        | No  | No     | Pool identifier (read-only)                |
| `quote_nonce_marker`  | QuoteNonceMarker | Yes | No     | The marker being closed                    |

**Validations:**
- `quote_nonce_marker.pool == pool_state.key()` → `WrongPool`
- `quote_nonce_marker.expiry_slot + SAFETY_BUFFER_SLOTS < current_slot` → `NonceNotYetClosable`

**Logic:** Anchor `#[account(mut, close = closer)]` closes the marker and routes rent to the closer.

> Callable by anyone (closer = rent payer). Safety: `SAFETY_BUFFER_SLOTS` is
> long enough past expiry that a "close → reuse same nonce" attack is
> impractical.
>
> **Operational policy**: the keeper (`keeper/`, Deno) batches expired-marker
> closes periodically (e.g. every 5 min) — query candidate markers via
> `getProgramAccounts`, filter by `expiry_slot + SAFETY_BUFFER < current_slot`,
> submit a batch of close instructions. The reclaimed rent offsets part of
> the keeper's operating cost.

---

---

## 3.9 Events

Every state-changing instruction emits an event via `emit!`. Used by the
frontend history feature, keeper analytics, and external indexers. The schema
is auto-included in the IDL, so the SDK decodes events with typed values.

| Event                  | Trigger                       | Key fields                                                                                                                                  |
|------------------------|-------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `PoolInitialized`      | `init_pool`                   | pool, admin, oracle_signer, base/quote mint, initial_fair_value, initial_spread_bps, initial_mode_ttl, slot                                  |
| `OracleUpdated`        | `update_oracle`               | pool, oracle_signer, new_fair_value, new_spread_bps, new_nonce, new_ttl, slot                                                                |
| `SwapExecuted`         | `execute_swap`                | pool, user, direction (0/1), **mode (0=curve, 1=rfq)**, input_amount, output_amount, **execution_price**, quote_nonce (RFQ only), slot       |
| `PoolPausedChanged`    | `set_paused`                  | pool, admin, paused, slot                                                                                                                    |
| `OracleSignerRotated`  | `rotate_oracle_signer`        | pool, admin, previous_signer, new_signer, slot                                                                                               |
| `AdminRotated`         | `rotate_admin`                | pool, previous_admin, new_admin, slot                                                                                                        |
| `InventoryWithdrawn`   | `admin_withdraw_inventory`    | pool, admin, base_amount, quote_amount, slot                                                                                                 |
| `QuoteMarkerClosed`    | `close_expired_nonce`         | pool, closer, nonce, expiry_slot, slot                                                                                                       |

> **Side enum flattening**: inside events, `direction` is a u8 (0=Buy, 1=Sell)
> — better for IDL enum compatibility and indexer ergonomics. Instruction
> arguments still use the `Side` enum directly.
>
> **Why `SwapExecuted` matters**: `execution_price` and `mode` are
> *computed* values not present in the instruction args — without the event,
> consumers would have to scrape logs.
>
> Cost: ~1–3k CU per emit. Fits comfortably inside every instruction's CU budget.

---

## 4. Error Codes

> Keep `programs/protocol/src/error.rs` in sync with this section. Update both when adding a new instruction.

| Code | Name | Description |
|---|---|---|
| 6000 | MathOverflow | Arithmetic overflow |
| 6001 | MathError | Division by zero or invalid operation |
| 6002 | MathUnderflow | Arithmetic underflow |
| 6100 | InvalidMintPair | base_mint == quote_mint |
| 6101 | MintsNotSorted | base_mint >= quote_mint (lexicographic) |
| 6102 | InvalidTtl              | TTL outside the allowed range                            |
| 6103 | InvalidFairValue        | fair_value is 0 or invalid                               |
| 6104 | InvalidSpread           | spread_bps exceeds MAX_SPREAD_BPS                        |
| 6105 | InvalidSize | input_amount == 0 |
| 6200 | UnauthorizedOracle      | Oracle signer mismatch                                   |
| 6201 | UnauthorizedAdmin       | Admin mismatch                                           |
| 6202 | NonceNotMonotonic       | new_nonce <= current nonce                               |
| 6203 | PoolPaused              | Kill switch active                                       |
| 6300 | NoFreshPriceSource      | Curve stale + no signed_quote                            |
| 6301 | QuoteExpired            | quote.expiry_slot < current slot                         |
| 6302 | QuoteWrongPool | quote.pool != pool_state |
| 6303 | QuoteWrongUser | quote.user != tx signer |
| 6304 | QuoteDirectionMismatch | quote.direction != param.direction |
| 6305 | QuoteSizeMismatch | quote.input_amount != input_amount |
| 6306 | QuoteSignatureInvalid   | ed25519 verify failed                                    |
| 6400 | SlippageExceeded | output_amount < min_output |
| 6401 | InsufficientReserves    | Insufficient vault balance                               |
| 6500 | WrongPool               | account.pool does not match pool_state                   |
| 6501 | NonceNotYetClosable | `expiry_slot + SAFETY_BUFFER_SLOTS >= now` |

---

## 5. Constants

> Keep `programs/protocol/src/constants.rs` in sync with this section.

| Constant | Value | Description |
|---|---|---|
| `POOL_SEED` | `b"pool"` | PoolState PDA seed prefix |
| `VAULT_SEED` | `b"vault"` | Vault PDA seed prefix |
| `MAX_TTL_SLOTS`         | `8`        | **Code-level hard cap** — `update_oracle` rejects any TTL above this (`InvalidTtl`). Operational recommendations (Mode A=1, B=3, C=0) are a separate policy (OPERATIONS §1). The cap exceeds the operational values to allow tuning margin + leverage the max during tests to *guarantee curve_age*. |
| `MAX_SPREAD_BPS`        | `1000`     | Maximum spread = 10% (sanity guard)                                                                                                                                                                                                                        |
| `MAX_DEPTH_BPS`         | `500`      | Upper bound on DepthParams.max_depth_bps (5%)                                                                                                                                                                                                              |
| `MAX_SKEW_OFFSET_BPS`   | `500`      | Upper bound on SkewParams.max_skew_offset_bps (5%)                                                                                                                                                                                                         |
| `SAFETY_BUFFER_SLOTS`   | `150`      | Buffer for the `QuoteNonceMarker` close condition (`expiry_slot + buffer < now`). ~1 minute                                                                                                                                                                |
| `PRICE_SCALE`           | `1_000_000`| Integer scale for fair_value / price (1e6)                                                                                                                                                                                                                 |

**Price-computation invariant** (underflow prevention):

```
MAX_SPREAD_BPS/2 + MAX_DEPTH_BPS + MAX_SKEW_OFFSET_BPS < 10_000
= 500 + 500 + 500 = 1500 << 10_000  ✓
```

When this inequality holds, `|total_bps| < 10_000`, so `(10_000 + total_bps)` never underflows / overflows. `update_oracle` enforces the per-parameter caps above on input.

**Price-computation arithmetic safety:**
- The pseudo-code's `(10_000 + total_bps) as u64` casts i64 → u64. Under the invariant above the result is always positive.
- In the actual implementation, prefer `i128` intermediates + `checked_add/sub` + explicit range checks.

> These are v0 defaults. `SANITY_BOUND_BPS` was dropped from the constants per
> the decision not to apply that guard (reason: the oracle only updates on
> large moves, so a wide gap can be a legitimate signal; we defend against
> exploits via cancel priority).
>
> Tune after Stage 1 backtests.

---

## 6. SDK interface (TypeScript)

Builders that land in `sdk/src/instructions/`:

| Function                       | Signature                                                                                                                            |
|---|---|
| `initPool(...)` | `(admin, baseMint, quoteMint, params) → TransactionInstruction` |
| `updateOracle(...)` | `(oracleSigner, pool, params) → TransactionInstruction` |
| `executeSwap(...)`             | `(user, pool, inputAmount, direction, minOutput, signedQuote?) → Transaction (includes ed25519 prepend)`                              |
| `setPaused(...)` | `(admin, pool, paused) → TransactionInstruction` |
| `rotateOracleSigner(...)` | `(admin, pool, newSigner) → TransactionInstruction` |
| `adminWithdrawInventory(...)` | `(admin, pool, baseAmount, quoteAmount) → TransactionInstruction` |
| `closeExpiredNonce(...)` | `(closer, pool, marker) → TransactionInstruction` |
| `simulateSwap(...)`            | `(pool, inputAmount, direction) → { mode: "curve"|"rfq", expectedOutput, price, requiresQuote: bool }` — **pre-trade quote simulation** |
| `requestQuote(...)`            | `(pool, inputAmount, direction) → SignedQuote` — calls the RFQ webhook (for curve-stale fallback)                                     |

**simulate semantics:**
- Reads `PoolState` + `vault.amount` → runs the same `curve::evaluate` logic in TypeScript for client-side simulation.
- When the curve is fresh: `mode="curve"`, returns the computed `expectedOutput`.
- When stale: `mode="rfq"`, `requiresQuote=true` → the frontend must call `requestQuote` separately.
- Must match the on-chain logic *bit-for-bit* (branches + rounding included).

The SDK also exposes an RFQ-webhook helper (translates the Jupiter-standard
response into `SignedQuote` and auto-prepends the ed25519 verify instruction).

---

## 7. Changelog

| Version | Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                              |
|---|---|---|
| v0.2    | 2026-05-15 | (1) ExactIn interface + curve_evaluate unit conversion documented (Buy: quote → base equivalent). (2) New `admin_withdraw_inventory` instruction (vault → admin ATA). (3) Fixed skew_offset sign (imbalance = target − current; base-heavy ⇒ mid drops). (4) Specified SignedQuote canonical Borsh format (97 bytes) + MM monotonic nonce policy. (5) Applied `saturating_sub` (fork rollback). (6) 6-step init operational procedure. (7) Sanity-guard decision (not applied). (8) Quote replay = per-quote PDA + close reclaim. |
| v0.1    | 2026-05-15 | Initial draft — defined 3 instructions.                                                                                                                                                                                                                                                                                                                                                                                              |
