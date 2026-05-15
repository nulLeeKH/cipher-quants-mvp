use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::OracleSignerRotated;
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
    let previous_signer = ctx.accounts.pool_state.authorized_oracle_signer;
    ctx.accounts.pool_state.authorized_oracle_signer = new_authorized_oracle_signer;

    emit!(OracleSignerRotated {
        pool: ctx.accounts.pool_state.key(),
        admin: ctx.accounts.admin.key(),
        previous_signer,
        new_signer: new_authorized_oracle_signer,
        slot: Clock::get()?.slot,
    });

    Ok(())
}
