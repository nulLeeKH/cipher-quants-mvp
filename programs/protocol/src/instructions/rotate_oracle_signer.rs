use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::PoolState;

// docs/SPECIFICATION.md §3.5

#[derive(Accounts)]
pub struct RotateOracleSigner<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub pool_state: Account<'info, PoolState>,
}

pub fn process_rotate_oracle_signer(
    ctx: Context<RotateOracleSigner>,
    new_authorized_oracle_signer: Pubkey,
) -> Result<()> {
    ctx.accounts.pool_state.authorized_oracle_signer = new_authorized_oracle_signer;
    Ok(())
}
