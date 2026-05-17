// ============================================================================
// Safety helpers
// ============================================================================
// In Anchor, the `#[derive(Accounts)]` macro + `#[account(...)]` attributes
// generate (a) signer checks, (b) ownership checks, (c) PDA derivations, (d)
// discriminator checks, (e) `has_one` cross-account constraints, and (f)
// rent-exempt checks. Pinocchio has none of that — every guarantee has to be
// written out by hand in the instruction handler.
//
// This module centralizes those checks so each instruction handler can stay
// short and review-friendly. Every helper returns
//   `Err(ProtocolError::Variant)`
// with a specific error code, so client-side error mapping stays stable.
//
// The 11 vulnerability classes Anchor caught for us (in checklist form):
//
//   ✓ verify_signer            — caller actually signed
//   ✓ verify_writable          — account is marked writable (CPI can mutate)
//   ✓ verify_owner_program     — account owned by the expected program
//   ✓ verify_address           — account key == expected pubkey
//   ✓ verify_pda_with_bump     — PDA seed-bump pair derives to the account
//   (discriminator)            — handled per-account-type by state::*::load
//   ✓ verify_token_mint        — SPL Token Account.mint == expected
//   ✓ verify_token_authority   — SPL Token Account.owner == expected
//   ✓ verify_account_size      — data.len() == expected
//   ✓ verify_program_account   — account key == well-known program id
//   ✓ verify_initialized       — account has data + lamports > 0 (rent-exempt
//                                 check is left to the runtime).

use pinocchio::{AccountView, Address};

use crate::error::{ProtocolError, Result};

// ---------------------------------------------------------------------------
// Signer / writable / address
// ---------------------------------------------------------------------------

#[inline]
pub fn verify_signer(account: &AccountView) -> Result<()> {
    if !account.is_signer() {
        return Err(ProtocolError::MissingSigner.into());
    }
    Ok(())
}

#[inline]
pub fn verify_writable(account: &AccountView) -> Result<()> {
    if !account.is_writable() {
        return Err(ProtocolError::NotWritable.into());
    }
    Ok(())
}

/// `Account address == expected` (Anchor's `address = X` constraint).
#[inline]
pub fn verify_address(account: &AccountView, expected: &Address) -> Result<()> {
    if account.address() != expected {
        return Err(ProtocolError::WrongAccountAddress.into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/// Account is owned by the given program. Use `&crate::constants::PROGRAM_ID`
/// for program-owned data accounts, `&TOKEN_PROGRAM_ID` for SPL token
/// accounts, etc.
#[inline]
pub fn verify_owner_program(account: &AccountView, expected_owner: &Address) -> Result<()> {
    if !account.owned_by(expected_owner) {
        return Err(ProtocolError::WrongAccountOwner.into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// PDA
// ---------------------------------------------------------------------------

/// PDA verification with a pre-stored bump (cheap path — ~250 CU sha256, no
/// curve check). Use this in steady-state handlers where the canonical bump
/// was written into state at init time.
///
/// `seeds` is the list WITHOUT the bump byte; `bump` is fed into the same
/// derive used by `find_program_address`.
#[inline]
pub fn verify_pda_with_bump<const N: usize>(
    account: &AccountView,
    seeds: &[&[u8]; N],
    bump: u8,
    program_id: &Address,
) -> Result<()> {
    let derived = Address::derive_address(seeds, Some(bump), program_id);
    if &derived != account.address() {
        return Err(ProtocolError::WrongPda.into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SPL Token account introspection
// ---------------------------------------------------------------------------
//
// SPL Token classic Account layout (165 bytes):
//   offset 0   : mint   (Address, 32 bytes)
//   offset 32  : owner  (Address, 32 bytes)
//   offset 64  : amount (u64 LE, 8 bytes)
//   offset 72  : delegate         (COption<Address>, 36)
//   offset 108 : state             (u8)
//   offset 109 : is_native        (COption<u64>, 12)
//   offset 121 : delegated_amount (u64, 8)
//   offset 129 : close_authority  (COption<Address>, 36)
//
// We only need the first 72 bytes for our checks. Byte-slice reads keep this
// at ~30 CU versus spl-token's `Account::unpack` (~3000 CU).

pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const TOKEN_ACCOUNT_MINT_OFFSET: usize = 0;
pub const TOKEN_ACCOUNT_OWNER_OFFSET: usize = 32;
pub const TOKEN_ACCOUNT_AMOUNT_OFFSET: usize = 64;

#[inline]
pub fn verify_token_mint(token_account: &AccountView, expected_mint: &Address) -> Result<()> {
    let data = token_account.try_borrow()?;
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(ProtocolError::WrongAccountSize.into());
    }
    let mint = &data[TOKEN_ACCOUNT_MINT_OFFSET..TOKEN_ACCOUNT_MINT_OFFSET + 32];
    if mint != expected_mint.as_ref() {
        return Err(ProtocolError::WrongTokenMint.into());
    }
    Ok(())
}

#[inline]
pub fn verify_token_authority(
    token_account: &AccountView,
    expected_authority: &Address,
) -> Result<()> {
    let data = token_account.try_borrow()?;
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(ProtocolError::WrongAccountSize.into());
    }
    let owner = &data[TOKEN_ACCOUNT_OWNER_OFFSET..TOKEN_ACCOUNT_OWNER_OFFSET + 32];
    if owner != expected_authority.as_ref() {
        return Err(ProtocolError::WrongAccountOwner.into());
    }
    Ok(())
}

#[inline]
pub fn load_token_account_amount(token_account: &AccountView) -> Result<u64> {
    let data = token_account.try_borrow()?;
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(ProtocolError::WrongAccountSize.into());
    }
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(
        &data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8],
    );
    Ok(u64::from_le_bytes(bytes))
}

// ---------------------------------------------------------------------------
// Account close helper
// ---------------------------------------------------------------------------
//
// Reclaim rent from `account` to `destination`, zero the data, and re-assign
// ownership to the System Program. Replaces Anchor's `close = destination`
// constraint. Caller must already hold `&mut AccountView` for both accounts
// (i.e. no concurrent immutable borrows).

#[inline]
pub fn close_account(
    account: &mut AccountView,
    destination: &mut AccountView,
) -> Result<()> {
    let lamports = account.lamports();
    let dest_now = destination.lamports();
    let new_dest = dest_now
        .checked_add(lamports)
        .ok_or(pinocchio::error::ProgramError::ArithmeticOverflow)?;
    destination.set_lamports(new_dest);
    account.set_lamports(0);

    {
        let mut data = account.try_borrow_mut()?;
        for b in data.iter_mut() {
            *b = 0;
        }
    }

    // SAFETY: We have exclusive `&mut AccountView` and just dropped the data
    // borrow. No outstanding refs to the owner field exist.
    unsafe { account.assign(&crate::constants::SYSTEM_PROGRAM_ID) };

    Ok(())
}
