use anchor_lang::prelude::*;

use crate::constants::{POOL_SEED, SAFETY_BUFFER_SLOTS};
use crate::error::ErrorCode;
use crate::events::QuoteMarkerClosed;
use crate::state::{PoolState, QuoteNonceMarker};

// docs/SPECIFICATION.md §3.8

#[derive(Accounts)]
pub struct CloseExpiredNonce<'info> {
    #[account(mut)]
    pub closer: Signer<'info>,

    // Defense-in-depth: enforce pool_state as a PDA. Pubkey collisions are
    // impossible on Solana, but the explicit constraint keeps this account
    // consistent with execute_swap.rs and makes intent clear during review.
    #[account(
        seeds = [POOL_SEED, pool_state.base_mint.as_ref(), pool_state.quote_mint.as_ref()],
        bump = pool_state.bump,
    )]
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

    emit!(QuoteMarkerClosed {
        pool: ctx.accounts.pool_state.key(),
        closer: ctx.accounts.closer.key(),
        nonce: marker.nonce,
        expiry_slot: marker.expiry_slot,
        slot: now,
    });

    // Anchor's `close = closer` attribute handles rent reclamation.
    Ok(())
}
