#![cfg_attr(not(test), no_std)]
#![allow(unexpected_cfgs)]

extern crate alloc;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod safety;
pub mod state;

pub use constants::*;
pub use error::{ProtocolError, Result};

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

// Program ID — mirrors `constants::PROGRAM_ID`. Both must always agree;
// the `assert!` below makes drift a compile-time error.
solana_address::declare_id!("3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy");

const _: () = assert!(
    // `Address` is just a 32-byte newtype, so comparing the raw byte arrays
    // is sufficient and works in a `const` context.
    bytes_eq(ID.as_array(), constants::PROGRAM_ID.as_array()),
    "declare_id! and constants::PROGRAM_ID must be the same pubkey"
);

const fn bytes_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut i = 0;
    while i < 32 {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

// ============================================================================
// Instruction Dispatch
// ============================================================================
// Layout: the first byte of `instruction_data` is the discriminator tag; the
// remaining bytes are the Borsh-serialized instruction args. Tags are stable
// — never reorder, never reuse a retired tag.
//
// Spec: docs/SPECIFICATION.md §3.

#[repr(u8)]
pub enum InstructionTag {
    InitPool = 0,
    UpdateOracle = 1,
    ExecuteSwap = 2,
    SetPaused = 3,
    RotateOracleSigner = 4,
    RotateAdmin = 5,
    AdminWithdrawInventory = 6,
    CloseExpiredNonce = 7,
    ProposeAdmin = 8,
    AcceptAdmin = 9,
    CancelAdminProposal = 10,
}

// We are `no_std` for the on-chain target. The default `entrypoint!` macro
// emits `default_panic_handler!` which is only a *hook* on top of Rust's std
// panic handler — fine for std builds, but on-chain `no_std` needs a real
// `#[panic_handler]` function. `nostd_panic_handler!` supplies one.
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::program_entrypoint!(process_instruction);
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::default_allocator!();
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::nostd_panic_handler!();

/// Pre-rendered `Instruction: <Name>` byte strings — one per dispatch tag.
/// The dispatcher emits the matching line via `sol_log_` at entry so each
/// transaction's CU lines (`Program ... consumed N of M`) can be bucketed by
/// handler in `scripts/measure-cu.sh` and standard log inspectors.
///
/// Pre-rendered (vs. building the buffer at runtime) so the optimizer can't
/// drop the data — we observed earlier that an intermediate `copy_from_slice`
/// approach got eliminated when the constants weren't held in `static`.
///
/// Only used in the on-chain build; `cfg`-gated so the host (test) build
/// doesn't warn on unused data.
#[cfg(target_os = "solana")]
static IX_LOG_LINES: [&[u8]; 11] = [
    b"Instruction: InitPool",
    b"Instruction: UpdateOracle",
    b"Instruction: ExecuteSwap",
    b"Instruction: SetPaused",
    b"Instruction: RotateOracleSigner",
    b"Instruction: RotateAdmin",
    b"Instruction: AdminWithdrawInventory",
    b"Instruction: CloseExpiredNonce",
    b"Instruction: ProposeAdmin",
    b"Instruction: AcceptAdmin",
    b"Instruction: CancelAdminProposal",
];

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (tag, ix_data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    #[cfg(target_os = "solana")]
    {
        let idx = *tag as usize;
        if idx < IX_LOG_LINES.len() {
            let line: &[u8] = IX_LOG_LINES[idx];
            // SAFETY: `line` is a `'static [u8]` from the table above.
            unsafe {
                pinocchio::syscalls::sol_log_(line.as_ptr(), line.len() as u64);
            }
        }
    }

    match *tag {
        0 => instructions::init_pool::process(program_id, accounts, ix_data),
        1 => instructions::update_oracle::process(program_id, accounts, ix_data),
        2 => instructions::execute_swap::process(program_id, accounts, ix_data),
        3 => instructions::set_paused::process(program_id, accounts, ix_data),
        4 => instructions::rotate_oracle_signer::process(program_id, accounts, ix_data),
        5 => instructions::rotate_admin::process(program_id, accounts, ix_data),
        6 => instructions::admin_withdraw_inventory::process(program_id, accounts, ix_data),
        7 => instructions::close_expired_nonce::process(program_id, accounts, ix_data),
        8 => instructions::propose_admin::process(program_id, accounts, ix_data),
        9 => instructions::accept_admin::process(program_id, accounts, ix_data),
        10 => instructions::cancel_admin_proposal::process(program_id, accounts, ix_data),
        _ => Err(ProtocolError::UnknownInstruction.into()),
    }
}
