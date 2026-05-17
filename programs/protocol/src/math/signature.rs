use borsh::BorshSerialize;
use pinocchio::{AccountView, Address};

use crate::constants::{ED25519_PROGRAM_ID, INSTRUCTIONS_SYSVAR_ID};
use crate::error::{ProtocolError, Result};
use crate::state::{SignedQuote, SignedQuoteMessage};

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
//
// Anchor era used `solana_program::sysvar::instructions` helpers. Pinocchio
// has no equivalent (yet), so this module walks the sysvar byte layout
// directly. Format reference: `solana_sdk::sysvar::instructions`.
//
// Instructions sysvar layout:
//   bytes 0..2          : num_instructions (u16 LE)
//   bytes 2..2+N*2      : per-instruction offset table (u16 LE each)
//   bytes ...           : packed instruction records
//   last 2 bytes        : current_instruction_index (u16 LE)
//
// Each instruction record (at its tabulated offset):
//   bytes 0..2          : num_accounts (u16 LE)
//   then for each acct  : 1-byte flags, 32-byte pubkey
//   then                : 32-byte program_id
//   then                : data_len (u16 LE)
//   then                : data_len bytes of instruction data

const ED25519_SIG_OFFSET_HEADER_LEN: usize = 2 + 7 * 2; // 16 bytes
const ED25519_PUBKEY_LEN: usize = 32;
const ED25519_SIGNATURE_LEN: usize = 64;
const ED25519_CURRENT_INSTR_IDX: u16 = u16::MAX;

/// Verify the previous instruction in this tx is an ed25519 native verify of
/// `quote`'s canonical message, signed by `expected_signer`.
///
/// `instructions_sysvar` must be the Sysvar1nstructions account — the caller
/// is responsible for asserting that with `safety::verify_address`.
pub fn verify_signed_quote_signature(
    instructions_sysvar: &AccountView,
    quote: &SignedQuote,
    expected_signer: &Address,
) -> Result<()> {
    if instructions_sysvar.address() != &INSTRUCTIONS_SYSVAR_ID {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    let data = instructions_sysvar.try_borrow()?;

    // ----- 1) Locate current_instruction_index + previous instruction -----
    let current_idx = read_current_index(&data)?;
    if current_idx == 0 {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }
    let prev_idx = current_idx - 1;
    let (prev_program_id, prev_data) = read_instruction_at(&data, prev_idx)?;

    // 2) program_id == ed25519 native program.
    if prev_program_id != ED25519_PROGRAM_ID.as_ref() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    // 3) Parse the instruction data.
    if prev_data.len() < ED25519_SIG_OFFSET_HEADER_LEN {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    let num_signatures = prev_data[0];
    if num_signatures != 1 {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    let read_u16 = |offset: usize| u16::from_le_bytes([prev_data[offset], prev_data[offset + 1]]);
    let sig_offset = read_u16(2) as usize;
    let sig_instr_idx = read_u16(4);
    let pk_offset = read_u16(6) as usize;
    let pk_instr_idx = read_u16(8);
    let msg_offset = read_u16(10) as usize;
    let msg_size = read_u16(12) as usize;
    let msg_instr_idx = read_u16(14);

    // Every reference must point to "current instruction" (the verify ix itself).
    if sig_instr_idx != ED25519_CURRENT_INSTR_IDX
        || pk_instr_idx != ED25519_CURRENT_INSTR_IDX
        || msg_instr_idx != ED25519_CURRENT_INSTR_IDX
    {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    // 4) Bounds checks.
    let pk_end = pk_offset
        .checked_add(ED25519_PUBKEY_LEN)
        .ok_or(ProtocolError::QuoteSignatureInvalid)?;
    let sig_end = sig_offset
        .checked_add(ED25519_SIGNATURE_LEN)
        .ok_or(ProtocolError::QuoteSignatureInvalid)?;
    let msg_end = msg_offset
        .checked_add(msg_size)
        .ok_or(ProtocolError::QuoteSignatureInvalid)?;
    if prev_data.len() < pk_end || prev_data.len() < sig_end || prev_data.len() < msg_end {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    // Defense-in-depth: enforce the canonical ed25519 verify-ix layout
    //   [0..16) header, [16..48) pubkey, [48..112) signature, [112..112+msg_size) message.
    let expected_total_len = ED25519_SIG_OFFSET_HEADER_LEN
        .checked_add(ED25519_PUBKEY_LEN)
        .and_then(|n| n.checked_add(ED25519_SIGNATURE_LEN))
        .and_then(|n| n.checked_add(msg_size))
        .ok_or(ProtocolError::QuoteSignatureInvalid)?;
    if prev_data.len() != expected_total_len
        || pk_offset != ED25519_SIG_OFFSET_HEADER_LEN
        || sig_offset != ED25519_SIG_OFFSET_HEADER_LEN + ED25519_PUBKEY_LEN
        || msg_offset != ED25519_SIG_OFFSET_HEADER_LEN + ED25519_PUBKEY_LEN + ED25519_SIGNATURE_LEN
    {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    // 5) Match the public key.
    let pk_bytes = &prev_data[pk_offset..pk_end];
    if pk_bytes != expected_signer.as_ref() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    // 6) Match the signature (SignedQuote.signature must equal the ed25519 ix sig).
    let sig_bytes = &prev_data[sig_offset..sig_end];
    if sig_bytes != quote.signature.as_ref() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    // 7) Match the message (canonical Borsh of SignedQuoteMessage).
    let expected_message = SignedQuoteMessage::from(quote);
    let mut expected_bytes = alloc::vec::Vec::with_capacity(97);
    expected_message
        .serialize(&mut expected_bytes)
        .map_err(|_| ProtocolError::QuoteSignatureInvalid)?;
    let msg_bytes = &prev_data[msg_offset..msg_end];
    if msg_bytes != expected_bytes.as_slice() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Instructions sysvar byte parser
// ---------------------------------------------------------------------------

fn read_current_index(data: &[u8]) -> Result<u16> {
    let len = data.len();
    if len < 2 {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }
    Ok(u16::from_le_bytes([data[len - 2], data[len - 1]]))
}

/// Returns `(program_id_bytes, instruction_data_bytes)` for the given index.
fn read_instruction_at(data: &[u8], idx: u16) -> Result<(&[u8], &[u8])> {
    if data.len() < 2 {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }
    let num_ix = u16::from_le_bytes([data[0], data[1]]);
    if idx >= num_ix {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }

    let table_pos = 2usize
        .checked_add(
            (idx as usize)
                .checked_mul(2)
                .ok_or(ProtocolError::QuoteSignatureInvalid)?,
        )
        .ok_or(ProtocolError::QuoteSignatureInvalid)?;
    if table_pos + 2 > data.len() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }
    let ix_offset = u16::from_le_bytes([data[table_pos], data[table_pos + 1]]) as usize;

    if ix_offset + 2 > data.len() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }
    let mut pos = ix_offset;
    let num_accounts = u16::from_le_bytes([data[pos], data[pos + 1]]) as usize;
    pos += 2;

    let accounts_size = num_accounts
        .checked_mul(33)
        .ok_or(ProtocolError::QuoteSignatureInvalid)?;
    pos = pos
        .checked_add(accounts_size)
        .ok_or(ProtocolError::QuoteSignatureInvalid)?;

    if pos + 32 > data.len() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }
    let program_id = &data[pos..pos + 32];
    pos += 32;

    if pos + 2 > data.len() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }
    let data_len = u16::from_le_bytes([data[pos], data[pos + 1]]) as usize;
    pos += 2;

    if pos + data_len > data.len() {
        return Err(ProtocolError::QuoteSignatureInvalid.into());
    }
    Ok((program_id, &data[pos..pos + data_len]))
}
