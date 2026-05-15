use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::events::AdminRotated;
use crate::state::PoolState;

// docs/SPECIFICATION.md §3.7

#[derive(Accounts)]
pub struct RotateAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub pool_state: Account<'info, PoolState>,
}

pub fn process_rotate_admin(
    ctx: Context<RotateAdmin>,
    new_admin: Pubkey,
) -> Result<()> {
    // Simple one-step transfer; we prioritize simplicity at the PoC stage.
    // In production, mistype risk makes a Squads multisig the recommended owner.
    let previous_admin = ctx.accounts.pool_state.admin;
    ctx.accounts.pool_state.admin = new_admin;

    emit!(AdminRotated {
        pool: ctx.accounts.pool_state.key(),
        previous_admin,
        new_admin,
        slot: Clock::get()?.slot,
    });

    Ok(())
}
