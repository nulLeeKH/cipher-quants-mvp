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
    /// Signer authorized to push `update_oracle` (on-chain fair_value writes).
    /// Hot key — keeper process. See docs/SPECIFICATION.md §2.1.
    pub authorized_oracle_signer: Address,
    /// Signer authorized to ed25519-sign RFQ quote messages. Verified by the
    /// `execute_swap` RFQ path. Hot key — api server. Separate from
    /// `authorized_oracle_signer` so a compromise of one box does not leak
    /// the other capability. Rotated via `rotate_quote_signer`.
    pub authorized_quote_signer: Address,

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
    pub _reserved: [u8; 32],
}

// ============================================================================
// Field byte offsets (for zero-copy hot-path access)
// ============================================================================
// Used by update_oracle (and any future hot-path ix) to read/write specific
// fields without full Borsh deserialize+serialize of the whole 323-byte
// account body. Offsets INCLUDE the 8-byte discriminator. Keep in sync with
// the PoolState struct definition above; the runtime test
// `pool_state_field_offsets_match_borsh_layout` enforces parity.
pub mod offset {
    pub const DISC_LEN: usize = 8;
    pub const ADMIN: usize = DISC_LEN + 0;
    pub const AUTHORIZED_ORACLE_SIGNER: usize = DISC_LEN + 32;
    pub const AUTHORIZED_QUOTE_SIGNER: usize = DISC_LEN + 64;
    pub const BASE_MINT: usize = DISC_LEN + 96;
    pub const QUOTE_MINT: usize = DISC_LEN + 128;
    pub const BASE_VAULT: usize = DISC_LEN + 160;
    pub const QUOTE_VAULT: usize = DISC_LEN + 192;
    pub const FAIR_VALUE: usize = DISC_LEN + 224;
    pub const SPREAD_BPS: usize = DISC_LEN + 232;
    pub const DEPTH_PARAMS: usize = DISC_LEN + 234; // 20 bytes
    pub const SKEW_PARAMS: usize = DISC_LEN + 254; // 16 bytes
    pub const LAST_ORACLE_UPDATE_SLOT: usize = DISC_LEN + 270;
    pub const ORACLE_NONCE: usize = DISC_LEN + 278;
    pub const CURRENT_MODE_TTL: usize = DISC_LEN + 286;
    pub const BUMP: usize = DISC_LEN + 287;
    pub const BASE_VAULT_BUMP: usize = DISC_LEN + 288;
    pub const QUOTE_VAULT_BUMP: usize = DISC_LEN + 289;
    pub const PAUSED: usize = DISC_LEN + 290;
}

impl PoolState {
    pub const DISCRIMINATOR: [u8; 8] = discriminator(tag::POOL_STATE);

    /// Body size after the 8-byte discriminator.
    ///   7 * 32 (pubkeys: admin, oracle_signer, quote_signer, base/quote mint, base/quote vault) = 224
    /// + 8 (fair_value u64)
    /// + 2 (spread_bps u16)
    /// + 4+8+2+6 (DepthParams)          = 20
    /// + 2+2+2+10 (SkewParams)          = 16
    /// + 8 (last_oracle_update_slot u64)
    /// + 8 (oracle_nonce u64)
    /// + 5 (current_mode_ttl, bump, base_vault_bump, quote_vault_bump, paused)
    /// + 32 (_reserved; shrunk from 64 to absorb the +32 quote_signer)
    /// = 224 + 8 + 2 + 20 + 16 + 8 + 8 + 5 + 32 = 323.
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

#[cfg(test)]
mod offset_tests {
    use super::*;
    use solana_address::{address, Address as TestAddress};

    /// Build a PoolState whose field values encode their own byte offsets
    /// (within reason — pubkeys carry distinct bytes, u64s a sentinel value)
    /// then Borsh-serialize it and assert every named offset in `offset::`
    /// matches the actual byte position.
    #[test]
    fn pool_state_field_offsets_match_borsh_layout() {
        let admin: Address = address!("11111111111111111111111111111112");
        let oracle: Address = address!("11111111111111111111111111111113");
        let quote: Address = address!("11111111111111111111111111111114");
        let bm: Address = address!("11111111111111111111111111111115");
        let qm: Address = address!("11111111111111111111111111111116");
        let bv: Address = address!("11111111111111111111111111111117");
        let qv: Address = address!("11111111111111111111111111111118");

        let pool = PoolState {
            admin,
            authorized_oracle_signer: oracle,
            authorized_quote_signer: quote,
            base_mint: bm,
            quote_mint: qm,
            base_vault: bv,
            quote_vault: qv,
            fair_value: 0xAABB_CCDD_1122_3344u64,
            spread_bps: 0x55AA,
            depth_curve_params: DepthParams::default(),
            inventory_skew_params: SkewParams::default(),
            last_oracle_update_slot: 0xDEAD_BEEF_CAFE_BABEu64,
            oracle_nonce: 0x0102_0304_0506_0708u64,
            current_mode_ttl: 0x3C,
            bump: 0x2A,
            base_vault_bump: 0x55,
            quote_vault_bump: 0x66,
            paused: 0x01,
            _reserved: [0; 32],
        };

        let mut buf = vec![0u8; PoolState::ACCOUNT_SIZE];
        pool.store(&mut buf).unwrap();

        // 8-byte discriminator first
        assert_eq!(&buf[0..8], &PoolState::DISCRIMINATOR);

        // Pubkey offsets
        assert_eq!(&buf[offset::ADMIN..offset::ADMIN + 32], admin.as_ref());
        assert_eq!(
            &buf[offset::AUTHORIZED_ORACLE_SIGNER..offset::AUTHORIZED_ORACLE_SIGNER + 32],
            oracle.as_ref()
        );
        assert_eq!(
            &buf[offset::AUTHORIZED_QUOTE_SIGNER..offset::AUTHORIZED_QUOTE_SIGNER + 32],
            quote.as_ref()
        );
        assert_eq!(&buf[offset::BASE_MINT..offset::BASE_MINT + 32], bm.as_ref());
        assert_eq!(&buf[offset::QUOTE_MINT..offset::QUOTE_MINT + 32], qm.as_ref());
        assert_eq!(&buf[offset::BASE_VAULT..offset::BASE_VAULT + 32], bv.as_ref());
        assert_eq!(&buf[offset::QUOTE_VAULT..offset::QUOTE_VAULT + 32], qv.as_ref());

        // Scalars
        assert_eq!(
            u64::from_le_bytes(buf[offset::FAIR_VALUE..offset::FAIR_VALUE + 8].try_into().unwrap()),
            0xAABB_CCDD_1122_3344u64
        );
        assert_eq!(
            u16::from_le_bytes(buf[offset::SPREAD_BPS..offset::SPREAD_BPS + 2].try_into().unwrap()),
            0x55AA
        );
        assert_eq!(
            u64::from_le_bytes(
                buf[offset::LAST_ORACLE_UPDATE_SLOT..offset::LAST_ORACLE_UPDATE_SLOT + 8]
                    .try_into()
                    .unwrap()
            ),
            0xDEAD_BEEF_CAFE_BABEu64
        );
        assert_eq!(
            u64::from_le_bytes(
                buf[offset::ORACLE_NONCE..offset::ORACLE_NONCE + 8].try_into().unwrap()
            ),
            0x0102_0304_0506_0708u64
        );
        assert_eq!(buf[offset::CURRENT_MODE_TTL], 0x3C);
        assert_eq!(buf[offset::BUMP], 0x2A);
        assert_eq!(buf[offset::BASE_VAULT_BUMP], 0x55);
        assert_eq!(buf[offset::QUOTE_VAULT_BUMP], 0x66);
        assert_eq!(buf[offset::PAUSED], 0x01);

        // DepthParams / SkewParams written as fixed-size byte regions
        // (default = all zeros).
        assert!(buf[offset::DEPTH_PARAMS..offset::DEPTH_PARAMS + 20].iter().all(|&b| b == 0));
        assert!(buf[offset::SKEW_PARAMS..offset::SKEW_PARAMS + 16].iter().all(|&b| b == 0));

        // Reserved region zero-filled.
        let reserved_offset = offset::PAUSED + 1;
        assert!(buf[reserved_offset..reserved_offset + 32].iter().all(|&b| b == 0));

        // Total length matches.
        assert_eq!(buf.len(), PoolState::ACCOUNT_SIZE);

        // Decode back via Borsh and confirm round-trip.
        let decoded = PoolState::load(&buf).unwrap();
        assert_eq!(decoded.admin, admin);
        assert_eq!(decoded.authorized_quote_signer, quote);
        assert_eq!(decoded.fair_value, 0xAABB_CCDD_1122_3344u64);
        assert_eq!(decoded.oracle_nonce, 0x0102_0304_0506_0708u64);
    }

    // Pinocchio's Address is not Copy in test, so just sanity that `_` survives the unused warning.
    #[allow(dead_code)]
    fn _silence(_a: TestAddress) {}
}
