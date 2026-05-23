// ============================================================================
// INSTRUCTION MODULES
// ============================================================================
// Each module exposes `pub fn process(program_id, accounts, ix_data) -> ProgramResult`.
// `lib.rs` dispatches by leading discriminator byte; the remaining `ix_data`
// is the Borsh-encoded args struct for that instruction.
//
// Spec: docs/SPECIFICATION.md §3.

pub mod accept_admin;
pub mod admin_withdraw_inventory;
pub mod cancel_admin_proposal;
pub mod close_expired_nonce;
pub mod execute_swap;
pub mod init_pool;
pub mod propose_admin;
pub mod rotate_admin;
pub mod rotate_oracle_signer;
pub mod rotate_quote_signer;
pub mod set_paused;
pub mod update_oracle;
