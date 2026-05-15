use anchor_lang::prelude::*;

// ============================================================================
// Side
// ============================================================================
// Borsh enum: 1-byte discriminant. Buy=0, Sell=1. Order is significant — it
// defines the canonical signing format for SignedQuote (docs/SPECIFICATION.md §2.3).

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    /// user buys base (quote → base, user pays quote)
    Buy,
    /// user sells base (base → quote, user pays base)
    Sell,
}

// ============================================================================
// DepthParams
// ============================================================================
// Linear-bps depth model. depth_bps = size_base_equiv * depth_coef_bps / size_unit,
// capped at max_depth_bps. See docs/SPECIFICATION.md §2.2.

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct DepthParams {
    /// Extra spread (bps) added per `size_unit` of user size.
    pub depth_coef_bps: u32,

    /// Unit size that depth_coef_bps applies to (base raw token amount).
    pub size_unit: u64,

    /// Upper cap on depth_bps (bps). Prevents runaway widening.
    pub max_depth_bps: u16,

    pub _reserved: [u8; 6],
}

// ============================================================================
// SkewParams
// ============================================================================
// How far the mid is pushed in one direction based on inventory imbalance.
// See docs/SPECIFICATION.md §2.2.

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct SkewParams {
    /// Target base weight (bps of total quote-denominated value).
    /// 5000 = 50% base / 50% quote (delta-neutral).
    pub target_base_bps: u16,

    /// Per-bps-of-imbalance offset added to mid (bps).
    pub skew_coef_bps: u16,

    /// Absolute cap on skew_offset (bps).
    pub max_skew_offset_bps: u16,

    pub _reserved: [u8; 10],
}

// ============================================================================
// PoolState
// ============================================================================
// One PoolState per (base_mint, quote_mint) pair. PDA seeds: [b"pool", base_mint, quote_mint].
// Field semantics: docs/SPECIFICATION.md §2.1.
//
// No separate `reserves_*` field — we always read vault.amount directly
// (OPEN_QUESTIONS 3.12 decision).

#[account]
#[derive(InitSpace, Debug)]
pub struct PoolState {
    // ----- Authority -----
    pub admin: Pubkey,
    pub authorized_oracle_signer: Pubkey,

    // ----- Pair identifiers -----
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,

    // ----- Vault -----
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,

    // ----- Price parameters (pushed by the oracle worker) -----
    pub fair_value: u64,
    pub spread_bps: u16,
    pub depth_curve_params: DepthParams,
    pub inventory_skew_params: SkewParams,

    // ----- Freshness tracking -----
    pub last_oracle_update_slot: u64,
    /// `update_oracle` monotonic counter; prevents replay.
    pub oracle_nonce: u64,
    /// 0 = forced stale (Mode C); 1..=MAX_TTL_SLOTS otherwise.
    pub current_mode_ttl: u8,

    // ----- Bumps -----
    pub bump: u8,
    pub base_vault_bump: u8,
    pub quote_vault_bump: u8,

    // ----- Kill switch -----
    pub paused: bool,

    // ----- Reserved -----
    pub _reserved: [u8; 64],
}
