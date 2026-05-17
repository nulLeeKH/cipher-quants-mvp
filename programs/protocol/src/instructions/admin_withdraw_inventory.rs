use borsh::BorshDeserialize;
use pinocchio::{
    cpi::{Seed, Signer},
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::constants::{POOL_SEED, PROGRAM_ID, TOKEN_PROGRAM_ID};
use crate::error::ProtocolError;
use crate::events::{emit_inventory_withdrawn, InventoryWithdrawn};
use crate::safety::{
    load_token_account_amount, verify_address, verify_owner_program, verify_pda_with_bump,
    verify_signer, verify_token_authority, verify_token_mint, verify_writable,
};
use crate::state::PoolState;

// docs/SPECIFICATION.md §3.6

#[derive(BorshDeserialize)]
pub struct AdminWithdrawInventoryArgs {
    pub withdraw_base_amount: u64,
    pub withdraw_quote_amount: u64,
}

/// Accounts (positional):
///   0. admin           — signer
///   1. pool_state      — owned by this program (PDA, signs vault transfers)
///   2. base_vault      — writable, SPL token account at pool.base_vault
///   3. quote_vault     — writable, SPL token account at pool.quote_vault
///   4. admin_base_ata  — writable, SPL token account, mint=pool.base_mint, owner=admin
///   5. admin_quote_ata — writable, SPL token account, mint=pool.quote_mint, owner=admin
///   6. token_program   — `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    let args = AdminWithdrawInventoryArgs::try_from_slice(ix_data)
        .map_err(|_| ProtocolError::InvalidInstructionData)?;

    let [admin_info, pool_info, base_vault_info, quote_vault_info, admin_base_ata_info, admin_quote_ata_info, token_program_info, _rest @ ..] =
        accounts
    else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(admin_info)?;
    verify_writable(base_vault_info)?;
    verify_writable(quote_vault_info)?;
    verify_writable(admin_base_ata_info)?;
    verify_writable(admin_quote_ata_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;
    verify_owner_program(base_vault_info, &TOKEN_PROGRAM_ID)?;
    verify_owner_program(quote_vault_info, &TOKEN_PROGRAM_ID)?;
    verify_owner_program(admin_base_ata_info, &TOKEN_PROGRAM_ID)?;
    verify_owner_program(admin_quote_ata_info, &TOKEN_PROGRAM_ID)?;
    verify_address(token_program_info, &TOKEN_PROGRAM_ID)?;

    let pool = PoolState::from_account_view(pool_info)?;
    if &pool.admin != admin_info.address() {
        return Err(ProtocolError::UnauthorizedAdmin.into());
    }
    verify_pda_with_bump(
        pool_info,
        &[POOL_SEED, pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        pool.bump,
        &PROGRAM_ID,
    )?;

    verify_address(base_vault_info, &pool.base_vault)?;
    verify_address(quote_vault_info, &pool.quote_vault)?;
    verify_token_mint(admin_base_ata_info, &pool.base_mint)?;
    verify_token_mint(admin_quote_ata_info, &pool.quote_mint)?;
    verify_token_authority(admin_base_ata_info, admin_info.address())?;
    verify_token_authority(admin_quote_ata_info, admin_info.address())?;

    if args.withdraw_base_amount == 0 && args.withdraw_quote_amount == 0 {
        return Err(ProtocolError::InvalidSize.into());
    }
    let base_balance = load_token_account_amount(base_vault_info)?;
    let quote_balance = load_token_account_amount(quote_vault_info)?;
    if args.withdraw_base_amount > base_balance || args.withdraw_quote_amount > quote_balance {
        return Err(ProtocolError::InsufficientReserves.into());
    }

    // Capture the keys we need to log post-CPI (CPI may mutate borrow flags
    // and we can no longer borrow safely afterward).
    let pool_key = *pool_info.address();
    let admin_key = *admin_info.address();
    let base_mint = pool.base_mint;
    let quote_mint = pool.quote_mint;
    let pool_bump = pool.bump;

    let bump_arr = [pool_bump];
    let seeds = [
        Seed::from(POOL_SEED),
        Seed::from(base_mint.as_ref()),
        Seed::from(quote_mint.as_ref()),
        Seed::from(bump_arr.as_ref()),
    ];
    let signer = Signer::from(&seeds);

    if args.withdraw_base_amount > 0 {
        Transfer::new(
            base_vault_info,
            admin_base_ata_info,
            pool_info,
            args.withdraw_base_amount,
        )
        .invoke_signed(&[signer.clone()])?;
    }
    if args.withdraw_quote_amount > 0 {
        Transfer::new(
            quote_vault_info,
            admin_quote_ata_info,
            pool_info,
            args.withdraw_quote_amount,
        )
        .invoke_signed(&[signer])?;
    }

    emit_inventory_withdrawn(&InventoryWithdrawn {
        pool: pool_key,
        admin: admin_key,
        base_amount: args.withdraw_base_amount,
        quote_amount: args.withdraw_quote_amount,
        slot: Clock::get()?.slot,
    });

    Ok(())
}
