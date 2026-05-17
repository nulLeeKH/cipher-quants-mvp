use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::{error::ProgramError, AccountView, Address};

use crate::error::{ProtocolError, Result};
use crate::state::{discriminator, tag};

// ============================================================================
// AdminRotationProposal
// ============================================================================
// One-shot record of a proposed admin rotation. Created by `propose_admin`
// (signed by current admin), consumed by `accept_admin` (signed by the
// proposed admin) or `cancel_admin_proposal` (signed by current admin).
//
// PDA seeds: [b"admin_proposal", pool_state].
// One proposal per pool at a time — re-proposing requires cancelling first.

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct AdminRotationProposal {
    pub pool: Address,
    pub proposed_by: Address,
    pub new_admin: Address,
    pub created_slot: u64,
    pub bump: u8,
    pub _reserved: [u8; 7],
}

impl AdminRotationProposal {
    pub const DISCRIMINATOR: [u8; 8] = discriminator(tag::ADMIN_ROTATION_PROPOSAL);

    /// 32 + 32 + 32 + 8 + 1 + 7 = 112 body bytes.
    pub const SIZE: usize = 112;
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
