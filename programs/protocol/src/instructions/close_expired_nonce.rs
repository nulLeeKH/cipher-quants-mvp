use anchor_lang::prelude::*;

use crate::constants::SAFETY_BUFFER_SLOTS;
use crate::error::ErrorCode;
use crate::state::{PoolState, QuoteNonceMarker};

// docs/SPECIFICATION.md §3.7

#[derive(Accounts)]
pub struct CloseExpiredNonce<'info> {
    #[account(mut)]
    pub closer: Signer<'info>,

    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        close = closer,
        constraint = quote_nonce_marker.pool == pool_state.key() @ ErrorCode::WrongPool,
    )]
    pub quote_nonce_marker: Account<'info, QuoteNonceMarker>,
}

pub fn process_close_expired_nonce(ctx: Context<CloseExpiredNonce>) -> Result<()> {
    let now = Clock::get()?.slot;
    let marker = &ctx.accounts.quote_nonce_marker;
    require!(
        marker.expiry_slot.saturating_add(SAFETY_BUFFER_SLOTS) < now,
        ErrorCode::NonceNotYetClosable
    );
    // Anchor's `close = closer` attribute handles rent reclamation.
    Ok(())
}
