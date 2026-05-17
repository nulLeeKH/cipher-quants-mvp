use borsh::BorshDeserialize;
use pinocchio::{
    cpi::{Seed, Signer},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::InitializeAccount3;

use crate::constants::*;
use crate::error::ProtocolError;
use crate::events::{emit_pool_initialized, PoolInitialized};
use crate::safety::{verify_address, verify_owner_program, verify_signer, verify_writable};
use crate::state::{DepthParams, PoolState, SkewParams};

// docs/SPECIFICATION.md §3.1

const SPL_TOKEN_ACCOUNT_LEN: u64 = 165;

#[derive(BorshDeserialize)]
pub struct InitPoolArgs {
    pub authorized_oracle_signer: Address,
    pub initial_fair_value: u64,
    pub initial_spread_bps: u16,
    pub initial_depth_params: DepthParams,
    pub initial_skew_params: SkewParams,
    pub initial_mode_ttl: u8,
}

/// Accounts (positional):
///   0. admin            — signer, writable (pays rent)
///   1. pool_state       — writable, uninitialized PDA
///   2. base_mint        — read, SPL Token Mint
///   3. quote_mint       — read, SPL Token Mint
///   4. base_vault       — writable, uninitialized PDA (token account)
///   5. quote_vault      — writable, uninitialized PDA (token account)
///   6. token_program    — `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
///   7. system_program   — `11111111111111111111111111111111`
///   8. rent_sysvar      — `SysvarRent111111111111111111111111111111111`
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    let args = InitPoolArgs::try_from_slice(ix_data)
        .map_err(|_| ProtocolError::InvalidInstructionData)?;

    let [admin_info, pool_info, base_mint_info, quote_mint_info, base_vault_info, quote_vault_info, token_program_info, _system_program_info, _rent_sysvar_info, _rest @ ..] =
        accounts
    else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(admin_info)?;
    verify_writable(admin_info)?;
    verify_writable(pool_info)?;
    verify_writable(base_vault_info)?;
    verify_writable(quote_vault_info)?;
    verify_owner_program(base_mint_info, &TOKEN_PROGRAM_ID)?;
    verify_owner_program(quote_mint_info, &TOKEN_PROGRAM_ID)?;
    verify_address(token_program_info, &TOKEN_PROGRAM_ID)?;

    let base_mint: Address = *base_mint_info.address();
    let quote_mint: Address = *quote_mint_info.address();

    // ----- Phase 1: Validation -----
    if base_mint == quote_mint {
        return Err(ProtocolError::InvalidMintPair.into());
    }
    if base_mint.as_array() >= quote_mint.as_array() {
        return Err(ProtocolError::MintsNotSorted.into());
    }
    if args.authorized_oracle_signer == Address::default() {
        return Err(ProtocolError::InvalidOracleSignerKey.into());
    }
    if args.initial_mode_ttl > MAX_TTL_SLOTS {
        return Err(ProtocolError::InvalidTtl.into());
    }
    if args.initial_fair_value == 0 {
        return Err(ProtocolError::InvalidFairValue.into());
    }
    if args.initial_spread_bps > MAX_SPREAD_BPS {
        return Err(ProtocolError::InvalidSpread.into());
    }
    if args.initial_depth_params.max_depth_bps > MAX_DEPTH_BPS
        || args.initial_depth_params.size_unit == 0
    {
        return Err(ProtocolError::InvalidDepthParams.into());
    }
    if args.initial_skew_params.max_skew_offset_bps > MAX_SKEW_OFFSET_BPS
        || (args.initial_skew_params.target_base_bps as u64) > BPS_DENOMINATOR
    {
        return Err(ProtocolError::InvalidSkewParams.into());
    }
    if !pool_info.is_data_empty() || pool_info.lamports() != 0 {
        return Err(ProtocolError::WrongPda.into());
    }

    // ----- Derive PDAs -----
    let (expected_pool_pda, pool_bump) =
        Address::find_program_address(&[POOL_SEED, base_mint.as_ref(), quote_mint.as_ref()], &PROGRAM_ID);
    if &expected_pool_pda != pool_info.address() {
        return Err(ProtocolError::WrongPda.into());
    }
    let pool_key = *pool_info.address();
    let (expected_base_vault, base_vault_bump) = Address::find_program_address(
        &[VAULT_SEED, pool_key.as_ref(), base_mint.as_ref()],
        &PROGRAM_ID,
    );
    if &expected_base_vault != base_vault_info.address() {
        return Err(ProtocolError::WrongPda.into());
    }
    let (expected_quote_vault, quote_vault_bump) = Address::find_program_address(
        &[VAULT_SEED, pool_key.as_ref(), quote_mint.as_ref()],
        &PROGRAM_ID,
    );
    if &expected_quote_vault != quote_vault_info.address() {
        return Err(ProtocolError::WrongPda.into());
    }

    let rent = Rent::get()?;

    // ----- Phase 2: CPIs -----

    // 2a) Create the pool_state PDA, owned by our program.
    let pool_bump_arr = [pool_bump];
    let pool_seeds = [
        Seed::from(POOL_SEED),
        Seed::from(base_mint.as_ref()),
        Seed::from(quote_mint.as_ref()),
        Seed::from(pool_bump_arr.as_ref()),
    ];
    let pool_signer = Signer::from(&pool_seeds);
    CreateAccount {
        from: admin_info,
        to: pool_info,
        lamports: rent.try_minimum_balance(PoolState::ACCOUNT_SIZE)?,
        space: PoolState::ACCOUNT_SIZE as u64,
        owner: &PROGRAM_ID,
    }
    .invoke_signed(&[pool_signer])?;

    // 2b) Create the base_vault PDA, owned by the SPL Token program.
    let base_vault_bump_arr = [base_vault_bump];
    let base_vault_seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(pool_key.as_ref()),
        Seed::from(base_mint.as_ref()),
        Seed::from(base_vault_bump_arr.as_ref()),
    ];
    let base_vault_signer = Signer::from(&base_vault_seeds);
    CreateAccount {
        from: admin_info,
        to: base_vault_info,
        lamports: rent.try_minimum_balance(SPL_TOKEN_ACCOUNT_LEN as usize)?,
        space: SPL_TOKEN_ACCOUNT_LEN,
        owner: &TOKEN_PROGRAM_ID,
    }
    .invoke_signed(&[base_vault_signer])?;

    // 2c) Initialize the base_vault as an SPL token account, authority = pool.
    //
    // Why `InitializeAccount3` (discriminator 0x12) and not the older variants:
    //   - `InitializeAccount` (0x01) — *legacy*. The owner is passed as an
    //     additional account, and a Rent sysvar account is required so the
    //     program can verify the new account is rent-exempt itself.
    //   - `InitializeAccount2` (0x10) — owner moves from "extra account" to
    //     instruction data (saves one account slot), Rent sysvar still required.
    //   - `InitializeAccount3` (0x12) — same data layout as 2, but the Rent
    //     check is dropped (the runtime now enforces rent-exemption globally,
    //     so the explicit sysvar is no longer needed). One fewer account
    //     per call and ~150 CU less per vault. Strictly better on modern
    //     Solana.
    InitializeAccount3 {
        account: base_vault_info,
        mint: base_mint_info,
        owner: &pool_key,
    }
    .invoke()?;

    // 2d) Create + initialize the quote_vault.
    let quote_vault_bump_arr = [quote_vault_bump];
    let quote_vault_seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(pool_key.as_ref()),
        Seed::from(quote_mint.as_ref()),
        Seed::from(quote_vault_bump_arr.as_ref()),
    ];
    let quote_vault_signer = Signer::from(&quote_vault_seeds);
    CreateAccount {
        from: admin_info,
        to: quote_vault_info,
        lamports: rent.try_minimum_balance(SPL_TOKEN_ACCOUNT_LEN as usize)?,
        space: SPL_TOKEN_ACCOUNT_LEN,
        owner: &TOKEN_PROGRAM_ID,
    }
    .invoke_signed(&[quote_vault_signer])?;

    InitializeAccount3 {
        account: quote_vault_info,
        mint: quote_mint_info,
        owner: &pool_key,
    }
    .invoke()?;

    // ----- Phase 3: State -----
    let slot = Clock::get()?.slot;
    let admin_key = *admin_info.address();
    let base_vault_key = *base_vault_info.address();
    let quote_vault_key = *quote_vault_info.address();
    let pool = PoolState {
        admin: admin_key,
        authorized_oracle_signer: args.authorized_oracle_signer,
        base_mint,
        quote_mint,
        base_vault: base_vault_key,
        quote_vault: quote_vault_key,
        fair_value: args.initial_fair_value,
        spread_bps: args.initial_spread_bps,
        depth_curve_params: args.initial_depth_params,
        inventory_skew_params: args.initial_skew_params,
        last_oracle_update_slot: slot,
        oracle_nonce: 0,
        current_mode_ttl: args.initial_mode_ttl,
        bump: pool_bump,
        base_vault_bump,
        quote_vault_bump,
        paused: 0,
        _reserved: [0; 64],
    };
    pool.store_account_view(pool_info)?;

    emit_pool_initialized(&PoolInitialized {
        pool: pool_key,
        admin: admin_key,
        oracle_signer: args.authorized_oracle_signer,
        base_mint,
        quote_mint,
        initial_fair_value: args.initial_fair_value,
        initial_spread_bps: args.initial_spread_bps,
        initial_mode_ttl: args.initial_mode_ttl,
        slot,
    });

    Ok(())
}
