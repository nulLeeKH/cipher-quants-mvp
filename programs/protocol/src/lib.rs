pub mod constants;
pub mod error;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
use instructions::*;
pub use math::*;
pub use state::*;

declare_id!("3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy");

#[program]
pub mod protocol {
    use super::*;

    /// docs/SPECIFICATION.md §3.1
    pub fn init_pool(
        ctx: Context<InitPool>,
        authorized_oracle_signer: Pubkey,
        initial_fair_value: u64,
        initial_spread_bps: u16,
        initial_depth_params: DepthParams,
        initial_skew_params: SkewParams,
        initial_mode_ttl: u8,
    ) -> Result<()> {
        instructions::init_pool::process_init_pool(
            ctx,
            authorized_oracle_signer,
            initial_fair_value,
            initial_spread_bps,
            initial_depth_params,
            initial_skew_params,
            initial_mode_ttl,
        )
    }

    /// docs/SPECIFICATION.md §3.2
    pub fn update_oracle(
        ctx: Context<UpdateOracle>,
        new_fair_value: u64,
        new_spread_bps: u16,
        new_depth_params: DepthParams,
        new_skew_params: SkewParams,
        new_nonce: u64,
        new_ttl: u8,
    ) -> Result<()> {
        instructions::update_oracle::process_update_oracle(
            ctx,
            new_fair_value,
            new_spread_bps,
            new_depth_params,
            new_skew_params,
            new_nonce,
            new_ttl,
        )
    }

    /// docs/SPECIFICATION.md §3.4
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::process_set_paused(ctx, paused)
    }

    /// docs/SPECIFICATION.md §3.5
    pub fn rotate_oracle_signer(
        ctx: Context<RotateOracleSigner>,
        new_authorized_oracle_signer: Pubkey,
    ) -> Result<()> {
        instructions::rotate_oracle_signer::process_rotate_oracle_signer(
            ctx,
            new_authorized_oracle_signer,
        )
    }

    /// docs/SPECIFICATION.md §3.6
    pub fn admin_withdraw_inventory(
        ctx: Context<AdminWithdrawInventory>,
        withdraw_base_amount: u64,
        withdraw_quote_amount: u64,
    ) -> Result<()> {
        instructions::admin_withdraw_inventory::process_admin_withdraw_inventory(
            ctx,
            withdraw_base_amount,
            withdraw_quote_amount,
        )
    }

    /// docs/SPECIFICATION.md §3.7
    pub fn close_expired_nonce(ctx: Context<CloseExpiredNonce>) -> Result<()> {
        instructions::close_expired_nonce::process_close_expired_nonce(ctx)
    }

    /// docs/SPECIFICATION.md §3.3 — Curve/RFQ hybrid swap (ExactIn)
    pub fn execute_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
        input_amount: u64,
        direction: Side,
        min_output: u64,
        signed_quote_opt: Option<SignedQuote>,
    ) -> Result<()> {
        instructions::execute_swap::process_execute_swap(
            ctx,
            input_amount,
            direction,
            min_output,
            signed_quote_opt,
        )
    }
}
