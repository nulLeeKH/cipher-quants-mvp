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

// TODO: Replace with your program's deployed address.
// Generate with: `solana-keygen grind --starts-with <prefix>:1`
declare_id!("11111111111111111111111111111111");

#[program]
pub mod protocol {
    use super::*;

    // ================================================================
    // INSTRUCTION ENTRY POINTS
    // ================================================================
    // Add instruction entry points here. Each should delegate to its
    // handler module in instructions/.
    //
    // Pattern:
    //   pub fn instruction_name(ctx: Context<InstructionAccounts>, args...) -> Result<()> {
    //       instructions::module_name::process_instruction_name(ctx, args...)
    //   }
    //
    // Example:
    //   pub fn initialize(ctx: Context<Initialize>, fee_rate_bps: u16) -> Result<()> {
    //       instructions::initialize::process_initialize(ctx, fee_rate_bps)
    //   }
    // ================================================================
}
