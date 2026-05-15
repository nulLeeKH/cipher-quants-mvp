use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::PoolState;

// docs/SPECIFICATION.md §3.4

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub pool_state: Account<'info, PoolState>,
}

pub fn process_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.pool_state.paused = paused;
    Ok(())
}
