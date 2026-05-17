use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::{error::ProgramError, AccountView, Address};

use crate::error::{ProtocolError, Result};
use crate::state::{discriminator, tag};

// ============================================================================
// QuoteNonceMarker
// ============================================================================
// One-shot marker that blocks RFQ quote replay.
// PDA seeds: [b"quote_used", pool, nonce.to_le_bytes()].
//
// Lifecycle:
//   - The RFQ path of execute_swap forces init → already existing means the
//     instruction fails, which is the replay block.
//   - Once expiry_slot + SAFETY_BUFFER_SLOTS < current_slot, anyone can call
//     close_expired_nonce to close it and reclaim rent.
//
// Full spec: docs/SPECIFICATION.md §2.4.

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct QuoteNonceMarker {
    /// Which pool this nonce belongs to.
    pub pool: Address,

    /// The nonce value this marker represents.
    pub nonce: u64,

    /// Used to determine when close is allowed (expiry + safety buffer must elapse).
    pub expiry_slot: u64,

    pub bump: u8,

    pub _reserved: [u8; 7],
}

impl QuoteNonceMarker {
    pub const DISCRIMINATOR: [u8; 8] = discriminator(tag::QUOTE_NONCE_MARKER);

    /// 32 + 8 + 8 + 1 + 7 = 56 body bytes.
    pub const SIZE: usize = 56;
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

    pub fn from_account_view(info: &AccountView) -> Result<Self> {
        let data = info.try_borrow()?;
        Self::load(&data)
    }
}
