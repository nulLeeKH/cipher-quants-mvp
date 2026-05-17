use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::Address;

// ============================================================================
// Events
// ============================================================================
// Anchor's `emit!` macro Borsh-encoded the body and emitted
// `Program data: <base64>` log lines via `sol_log_data`. We keep the same
// shape (Borsh-encoded body, base64-wrapped) but emit via `sol_log_` instead,
// because the body is `[1-byte tag][Borsh body]` — the SDK can dispatch on
// the tag before deciding which struct to deserialize, without needing an IDL.
//
// Log format (one line per event):
//   Program log: EVT:<base64(tag || borsh_body)>
//
// `Program log: ` is the Solana runtime's prefix for the `sol_log_` syscall;
// `EVT:` is a literal identifier so callers can grep these lines without
// false-matching against unrelated "Program log:" entries. (The SDK decoder
// also accepts `Program data: EVT:…` lines for forward compatibility if we
// ever switch to `sol_log_data`.)
//
// Spec: docs/SPECIFICATION.md §3.

/// Stable event tag byte. Mirrored by the SDK event decoder.
pub mod tag {
    pub const POOL_INITIALIZED: u8 = 0x01;
    pub const ORACLE_UPDATED: u8 = 0x02;
    pub const SWAP_EXECUTED: u8 = 0x03;
    pub const POOL_PAUSED_CHANGED: u8 = 0x04;
    pub const ORACLE_SIGNER_ROTATED: u8 = 0x05;
    pub const ADMIN_ROTATED: u8 = 0x06;
    pub const INVENTORY_WITHDRAWN: u8 = 0x07;
    pub const QUOTE_MARKER_CLOSED: u8 = 0x08;
    pub const ADMIN_PROPOSAL_CREATED: u8 = 0x09;
    pub const ADMIN_PROPOSAL_CANCELLED: u8 = 0x0A;
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct PoolInitialized {
    pub pool: Address,
    pub admin: Address,
    pub oracle_signer: Address,
    pub base_mint: Address,
    pub quote_mint: Address,
    pub initial_fair_value: u64,
    pub initial_spread_bps: u16,
    pub initial_mode_ttl: u8,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct OracleUpdated {
    pub pool: Address,
    pub oracle_signer: Address,
    pub new_fair_value: u64,
    pub new_spread_bps: u16,
    pub new_nonce: u64,
    pub new_ttl: u8,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct SwapExecuted {
    pub pool: Address,
    pub user: Address,
    /// 0=Buy, 1=Sell
    pub direction: u8,
    /// 0=curve, 1=rfq
    pub mode: u8,
    pub input_amount: u64,
    pub output_amount: u64,
    pub execution_price: u64,
    pub quote_nonce: u64,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct PoolPausedChanged {
    pub pool: Address,
    pub admin: Address,
    pub paused: u8,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct OracleSignerRotated {
    pub pool: Address,
    pub admin: Address,
    pub previous_signer: Address,
    pub new_signer: Address,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct AdminRotated {
    pub pool: Address,
    pub previous_admin: Address,
    pub new_admin: Address,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct InventoryWithdrawn {
    pub pool: Address,
    pub admin: Address,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct QuoteMarkerClosed {
    pub pool: Address,
    pub closer: Address,
    pub nonce: u64,
    pub expiry_slot: u64,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct AdminProposalCreated {
    pub pool: Address,
    pub proposed_by: Address,
    pub new_admin: Address,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct AdminProposalCancelled {
    pub pool: Address,
    pub admin: Address,
    pub cancelled_new_admin: Address,
    pub slot: u64,
}

// ============================================================================
// Standard base64 encoder (RFC 4648 alphabet, no padding)
// ============================================================================
// We use the standard alphabet (`A-Za-z0-9+/`) instead of the URL-safe variant
// so any general-purpose log indexer can decode the payload without extra
// configuration. Cost on-chain: ~4 CU per byte; negligible vs the 200k budget.

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode_nopad(bytes: &[u8]) -> Vec<u8> {
    let n_full = bytes.len() / 3;
    let rem = bytes.len() - n_full * 3;
    let mut out = Vec::with_capacity(n_full * 4 + if rem == 0 { 0 } else { rem + 1 });
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16)
            | ((bytes[i + 1] as u32) << 8)
            | (bytes[i + 2] as u32);
        out.push(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize]);
        out.push(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize]);
        out.push(BASE64_ALPHABET[((n >> 6) & 0x3F) as usize]);
        out.push(BASE64_ALPHABET[(n & 0x3F) as usize]);
        i += 3;
    }
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize]);
        out.push(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize]);
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize]);
        out.push(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize]);
        out.push(BASE64_ALPHABET[((n >> 6) & 0x3F) as usize]);
    }
    out
}

// ============================================================================
// Emit helpers
// ============================================================================
// Each helper Borsh-serializes the body, prepends the 1-byte tag, base64-
// encodes the result, and emits one `EVT:<base64>` log line. The on-chain
// runtime prepends `Program log: ` automatically.
//
// We use a single heap buffer (Vec<u8>) and pass it to the raw `sol_log_`
// syscall — avoids the fixed-size stack buffer that `pinocchio_log::log!`
// uses, which would truncate larger events.

#[inline(always)]
fn emit_event<T: BorshSerialize>(tag: u8, body: &T) {
    let mut payload = Vec::with_capacity(256);
    payload.push(tag);
    if body.serialize(&mut payload).is_err() {
        return; // serialization is infallible for our types in practice
    }

    let encoded = base64_encode_nopad(&payload);

    let mut line = Vec::with_capacity(4 + encoded.len());
    line.extend_from_slice(b"EVT:");
    line.extend_from_slice(&encoded);

    sol_log_bytes(&line);
}

#[cfg(target_os = "solana")]
#[inline(always)]
fn sol_log_bytes(line: &[u8]) {
    // SAFETY: `line` is a valid byte slice; sol_log_ does not retain the
    // pointer past the call.
    unsafe {
        pinocchio::syscalls::sol_log_(line.as_ptr(), line.len() as u64);
    }
}

#[cfg(not(target_os = "solana"))]
#[inline(always)]
fn sol_log_bytes(_line: &[u8]) {
    // No-op on host builds — only the on-chain runtime has sol_log_.
}

pub fn emit_pool_initialized(e: &PoolInitialized) {
    emit_event(tag::POOL_INITIALIZED, e);
}
pub fn emit_oracle_updated(e: &OracleUpdated) {
    emit_event(tag::ORACLE_UPDATED, e);
}
pub fn emit_swap_executed(e: &SwapExecuted) {
    emit_event(tag::SWAP_EXECUTED, e);
}
pub fn emit_pool_paused_changed(e: &PoolPausedChanged) {
    emit_event(tag::POOL_PAUSED_CHANGED, e);
}
pub fn emit_oracle_signer_rotated(e: &OracleSignerRotated) {
    emit_event(tag::ORACLE_SIGNER_ROTATED, e);
}
pub fn emit_admin_rotated(e: &AdminRotated) {
    emit_event(tag::ADMIN_ROTATED, e);
}
pub fn emit_inventory_withdrawn(e: &InventoryWithdrawn) {
    emit_event(tag::INVENTORY_WITHDRAWN, e);
}
pub fn emit_quote_marker_closed(e: &QuoteMarkerClosed) {
    emit_event(tag::QUOTE_MARKER_CLOSED, e);
}
pub fn emit_admin_proposal_created(e: &AdminProposalCreated) {
    emit_event(tag::ADMIN_PROPOSAL_CREATED, e);
}
pub fn emit_admin_proposal_cancelled(e: &AdminProposalCancelled) {
    emit_event(tag::ADMIN_PROPOSAL_CANCELLED, e);
}
