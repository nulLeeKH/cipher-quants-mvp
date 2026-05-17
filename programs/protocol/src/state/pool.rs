use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::{error::ProgramError, AccountView, Address};

use crate::error::{ProtocolError, Result};
use crate::state::{discriminator, tag};

// ============================================================================
// Side
// ============================================================================
// Borsh enum: 1-byte discriminant. Buy=0, Sell=1. Order is significant — it
// defines the canonical signing format for SignedQuote (docs/SPECIFICATION.md §2.3).

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
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

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, Default)]
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

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, Default)]
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

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct PoolState {
    // ----- Authority -----
    pub admin: Address,
    pub authorized_oracle_signer: Address,

    // ----- Pair identifiers -----
    pub base_mint: Address,
    pub quote_mint: Address,

    // ----- Vault -----
    pub base_vault: Address,
    pub quote_vault: Address,

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

    // ----- Kill switch (u8: 0 = false, 1 = true; Borsh-compatible with bool) -----
    pub paused: u8,

    // ----- Reserved -----
    pub _reserved: [u8; 64],
}

impl PoolState {
    pub const DISCRIMINATOR: [u8; 8] = discriminator(tag::POOL_STATE);

    /// Body size after the 8-byte discriminator.
    ///   6 * 32 (pubkeys)               = 192
    /// + 8 (fair_value u64)
    /// + 2 (spread_bps u16)
    /// + 4+8+2+6 (DepthParams)          = 20
    /// + 2+2+2+10 (SkewParams)          = 16
    /// + 8 (last_oracle_update_slot u64)
    /// + 8 (oracle_nonce u64)
    /// + 5 (current_mode_ttl, bump, base_vault_bump, quote_vault_bump, paused)
    /// + 64 (_reserved)
    /// = 192 + 8 + 2 + 20 + 16 + 8 + 8 + 5 + 64 = 323.
    pub const SIZE: usize = 323;
    pub const ACCOUNT_SIZE: usize = 8 + Self::SIZE;

    pub fn load(data: &[u8]) -> Result<Self> {
        if data.len() < 8 {
            return Err(ProtocolError::WrongAccountSize.into());
        }
        if data[..8] != Self::DISCRIMINATOR {
            return Err(ProtocolError::WrongDiscriminator.into());
        }
        Self::try_from_slice(&data[8..]).map_err(|_| ProgramError::InvalidAccountData)
    }

    pub fn store(&self, data: &mut [u8]) -> Result<()> {
        if data.len() < Self::ACCOUNT_SIZE {
            return Err(ProtocolError::WrongAccountSize.into());
        }
        data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        let mut writer = &mut data[8..];
        self.serialize(&mut writer)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        Ok(())
    }

    /// Borrow the account immutably and decode. Caller drops the resulting
    /// `Self` before any CPI that mutates the same account.
    pub fn from_account_view(info: &AccountView) -> Result<Self> {
        let data = info.try_borrow()?;
        Self::load(&data)
    }

    /// Borrow mutably and write. Caller must not hold any concurrent borrow.
    pub fn store_account_view(&self, info: &mut AccountView) -> Result<()> {
        let mut data = info.try_borrow_mut()?;
        self.store(&mut data)
    }
}
