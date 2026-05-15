use std::str::FromStr;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::error::ErrorCode;
use crate::state::{SignedQuote, SignedQuoteMessage};

/// Solana ed25519 native verify precompile program ID.
/// Runtime parse cost is negligible (called once per RFQ-path tx).
#[inline]
fn ed25519_program_id() -> Pubkey {
    Pubkey::from_str("Ed25519SigVerify111111111111111111111111111").unwrap()
}

// ============================================================================
// Ed25519 SignedQuote verification
// ============================================================================
// The Solana native ed25519 program (Ed25519SigVerify111...) must be prepended
// as the previous instruction in the same transaction. We read it through the
// Instructions sysvar to (a) verify program_id, (b) extract public_key + message,
// and (c) cross-check those bytes against the canonical SignedQuote message.
//
// Native ed25519 instruction data layout:
//   [u8] num_signatures           // 1
//   [u8] padding                  // 0
//   [u16 LE] signature_offset
//   [u16 LE] signature_instr_idx
//   [u16 LE] public_key_offset
//   [u16 LE] public_key_instr_idx
//   [u16 LE] message_data_offset
//   [u16 LE] message_data_size
//   [u16 LE] message_instr_idx
//   <payload: pubkey 32B + signature 64B + message N bytes>
//
// instr_idx == u16::MAX (0xFFFF) means "current instruction" (i.e. the verify ix itself).

const ED25519_SIG_OFFSET_HEADER_LEN: usize = 2 + 7 * 2; // 16 bytes
const ED25519_PUBKEY_LEN: usize = 32;
const ED25519_SIGNATURE_LEN: usize = 64;
const ED25519_CURRENT_INSTR_IDX: u16 = u16::MAX;

/// Verify that the previous instruction in this transaction is an ed25519 native
/// verify of the given SignedQuote's canonical message, signed by `expected_signer`.
pub fn verify_signed_quote_signature(
    instructions_sysvar: &AccountInfo,
    quote: &SignedQuote,
    expected_signer: &Pubkey,
) -> Result<()> {
    // 1. Locate the instruction immediately before the current one.
    let current_idx = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(ErrorCode::QuoteSignatureInvalid))?;
    require!(current_idx > 0, ErrorCode::QuoteSignatureInvalid);

    let prev_ix = load_instruction_at_checked(
        (current_idx as usize).saturating_sub(1),
        instructions_sysvar,
    )
    .map_err(|_| error!(ErrorCode::QuoteSignatureInvalid))?;

    // 2. program_id == ed25519 native program.
    require!(
        prev_ix.program_id == ed25519_program_id(),
        ErrorCode::QuoteSignatureInvalid
    );

    // 3. Parse the instruction data.
    let data = &prev_ix.data;
    require!(
        data.len() >= ED25519_SIG_OFFSET_HEADER_LEN,
        ErrorCode::QuoteSignatureInvalid
    );

    let num_signatures = data[0];
    require!(num_signatures == 1, ErrorCode::QuoteSignatureInvalid);

    let read_u16 = |offset: usize| u16::from_le_bytes([data[offset], data[offset + 1]]);
    let sig_offset = read_u16(2) as usize;
    let sig_instr_idx = read_u16(4);
    let pk_offset = read_u16(6) as usize;
    let pk_instr_idx = read_u16(8);
    let msg_offset = read_u16(10) as usize;
    let msg_size = read_u16(12) as usize;
    let msg_instr_idx = read_u16(14);

    // Every reference must point to the "current instruction" (the verify ix itself).
    require!(
        sig_instr_idx == ED25519_CURRENT_INSTR_IDX
            && pk_instr_idx == ED25519_CURRENT_INSTR_IDX
            && msg_instr_idx == ED25519_CURRENT_INSTR_IDX,
        ErrorCode::QuoteSignatureInvalid
    );

    // 4. Bounds checks.
    let pk_end = pk_offset
        .checked_add(ED25519_PUBKEY_LEN)
        .ok_or(error!(ErrorCode::QuoteSignatureInvalid))?;
    let sig_end = sig_offset
        .checked_add(ED25519_SIGNATURE_LEN)
        .ok_or(error!(ErrorCode::QuoteSignatureInvalid))?;
    let msg_end = msg_offset
        .checked_add(msg_size)
        .ok_or(error!(ErrorCode::QuoteSignatureInvalid))?;
    require!(
        data.len() >= pk_end && data.len() >= sig_end && data.len() >= msg_end,
        ErrorCode::QuoteSignatureInvalid
    );

    // 5. Match the public key.
    let pk_bytes = &data[pk_offset..pk_end];
    require!(
        pk_bytes == expected_signer.as_ref(),
        ErrorCode::QuoteSignatureInvalid
    );

    // 6. Match the signature (SignedQuote.signature must equal the ed25519 ix sig).
    let sig_bytes = &data[sig_offset..sig_end];
    require!(
        sig_bytes == quote.signature.as_ref(),
        ErrorCode::QuoteSignatureInvalid
    );

    // 7. Match the message (canonical Borsh of SignedQuoteMessage).
    let expected_message = SignedQuoteMessage::from(quote);
    let expected_bytes = expected_message
        .try_to_vec()
        .map_err(|_| error!(ErrorCode::QuoteSignatureInvalid))?;
    let msg_bytes = &data[msg_offset..msg_end];
    require!(
        msg_bytes == expected_bytes.as_slice(),
        ErrorCode::QuoteSignatureInvalid
    );

    // The ed25519 native program has already performed the cryptographic check
    // (an invalid signature fails the whole transaction). Reaching this point
    // means signature/pubkey/message are cryptographically consistent. The steps
    // above additionally bind the expected_signer and expected_message to *our pool*.

    Ok(())
}
