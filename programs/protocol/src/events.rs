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
    pub const QUOTE_SIGNER_ROTATED: u8 = 0x0B;
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct PoolInitialized {
    pub pool: Address,
    pub admin: Address,
    pub oracle_signer: Address,
    /// Initial RFQ quote signer (`pool.authorized_quote_signer`).
    pub quote_signer: Address,
    pub base_mint: Address,
    pub quote_mint: Address,
    pub initial_fair_value: u64,
    pub initial_spread_bps: u16,
    pub initial_mode_ttl: u8,
    pub slot: u64,
}

/// Hot-path event — the keeper emits this every 200 ms in Mode A. Trimmed
/// to the **minimum non-derivable fields**:
///   - `pool`            — kept; required to disambiguate when an indexer
///                         is subscribed to all program events.
///   - `oracle_signer`   — DROPPED; recoverable from `pool.authorized_oracle_signer`.
///   - `slot`            — DROPPED; available on `tx.slot` in tx metadata.
/// Saved ~37 bytes of Borsh body → ~400 CU/emit. See changelog v0.6.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct OracleUpdated {
    pub pool: Address,
    pub new_fair_value: u64,
    pub new_spread_bps: u16,
    pub new_nonce: u64,
    pub new_ttl: u8,
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

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct QuoteSignerRotated {
    pub pool: Address,
    pub admin: Address,
    pub previous_signer: Address,
    pub new_signer: Address,
    pub slot: u64,
}

// ============================================================================
// Emit helpers
// ============================================================================
// Each emit_<name> packs `[tag | borsh-equivalent body bytes]` into a stack
// buffer and pushes it via `sol_log_data` — the runtime base64-encodes
// inside the syscall and emits `Program data: <base64>`. Byte layout per
// event is identical to what `BorshSerialize` would have produced (Borsh
// on a pure-fixed-size struct = field-order concatenation, no tags), so SDK
// decoders that read by offset keep working unchanged.
//
// CU history (per emit):
//   ~600–1500 CU  (v0.4 — sol_log_ + client-side base64)
//      ~300 CU    (v0.5 — sol_log_data + heap Vec)
//      ~150 CU    (v0.6 — sol_log_data + stack buffer)
//      ~100 CU    (v0.7 — sol_log_data + stack buffer + bytewise pack, no Borsh
//                  trait dispatch). Savings stack across every state-changing ix.

// Largest event body (`PoolInitialized` = 211 bytes) + 1 tag byte ≤ 256.
// Stack-allocated; no heap allocator path.
const EMIT_BUF_CAP: usize = 256;

/// Wrapper for `sol_log_data` with a single byte slice. Pinocchio 0.11 does
/// not re-export a safe wrapper, so we construct the fat-pointer-array layout
/// ourselves: `&[&[u8]] as *const u8` + the slice count as `len`.
#[inline(always)]
fn log_data_one(_bytes: &[u8]) {
    #[cfg(target_os = "solana")]
    unsafe {
        let slices: [&[u8]; 1] = [_bytes];
        pinocchio::syscalls::sol_log_data(
            slices.as_ptr() as *const u8,
            slices.len() as u64,
        );
    }
}

// ----- Per-event packers --------------------------------------------------
//
// Each event has a fixed byte size = sum of its field byte widths. Layout
// follows the struct declaration order so it stays byte-identical with what
// `BorshSerialize` would have produced — SDK decoders by offset are
// unchanged.

const SZ_POOL_INITIALIZED: usize = 6 * 32 + 8 + 2 + 1 + 8; // 211
const SZ_ORACLE_UPDATED: usize = 32 + 8 + 2 + 8 + 1;        // 51
const SZ_SWAP_EXECUTED: usize = 2 * 32 + 1 + 1 + 5 * 8;     // 106
const SZ_POOL_PAUSED_CHANGED: usize = 2 * 32 + 1 + 8;       // 73
const SZ_ORACLE_SIGNER_ROTATED: usize = 4 * 32 + 8;         // 136
const SZ_ADMIN_ROTATED: usize = 3 * 32 + 8;                 // 104
const SZ_INVENTORY_WITHDRAWN: usize = 2 * 32 + 8 + 8 + 8;   // 88
const SZ_QUOTE_MARKER_CLOSED: usize = 2 * 32 + 8 + 8 + 8;   // 88
const SZ_ADMIN_PROPOSAL_CREATED: usize = 3 * 32 + 8;        // 104
const SZ_ADMIN_PROPOSAL_CANCELLED: usize = 3 * 32 + 8;      // 104
const SZ_QUOTE_SIGNER_ROTATED: usize = 4 * 32 + 8;          // 136

pub fn emit_pool_initialized(e: &PoolInitialized) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::POOL_INITIALIZED;
    let b = &mut buf[1..1 + SZ_POOL_INITIALIZED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.admin.as_ref());
    b[64..96].copy_from_slice(e.oracle_signer.as_ref());
    b[96..128].copy_from_slice(e.quote_signer.as_ref());
    b[128..160].copy_from_slice(e.base_mint.as_ref());
    b[160..192].copy_from_slice(e.quote_mint.as_ref());
    b[192..200].copy_from_slice(&e.initial_fair_value.to_le_bytes());
    b[200..202].copy_from_slice(&e.initial_spread_bps.to_le_bytes());
    b[202] = e.initial_mode_ttl;
    b[203..211].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_POOL_INITIALIZED]);
}

/// Retained for legacy callers / completeness. NOT emitted by `update_oracle`
/// in v0.6+ — see SPEC §3.13 note.
pub fn emit_oracle_updated(e: &OracleUpdated) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::ORACLE_UPDATED;
    let b = &mut buf[1..1 + SZ_ORACLE_UPDATED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..40].copy_from_slice(&e.new_fair_value.to_le_bytes());
    b[40..42].copy_from_slice(&e.new_spread_bps.to_le_bytes());
    b[42..50].copy_from_slice(&e.new_nonce.to_le_bytes());
    b[50] = e.new_ttl;
    log_data_one(&buf[..1 + SZ_ORACLE_UPDATED]);
}

pub fn emit_swap_executed(e: &SwapExecuted) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::SWAP_EXECUTED;
    let b = &mut buf[1..1 + SZ_SWAP_EXECUTED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.user.as_ref());
    b[64] = e.direction;
    b[65] = e.mode;
    b[66..74].copy_from_slice(&e.input_amount.to_le_bytes());
    b[74..82].copy_from_slice(&e.output_amount.to_le_bytes());
    b[82..90].copy_from_slice(&e.execution_price.to_le_bytes());
    b[90..98].copy_from_slice(&e.quote_nonce.to_le_bytes());
    b[98..106].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_SWAP_EXECUTED]);
}

pub fn emit_pool_paused_changed(e: &PoolPausedChanged) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::POOL_PAUSED_CHANGED;
    let b = &mut buf[1..1 + SZ_POOL_PAUSED_CHANGED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.admin.as_ref());
    b[64] = e.paused;
    b[65..73].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_POOL_PAUSED_CHANGED]);
}

pub fn emit_oracle_signer_rotated(e: &OracleSignerRotated) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::ORACLE_SIGNER_ROTATED;
    let b = &mut buf[1..1 + SZ_ORACLE_SIGNER_ROTATED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.admin.as_ref());
    b[64..96].copy_from_slice(e.previous_signer.as_ref());
    b[96..128].copy_from_slice(e.new_signer.as_ref());
    b[128..136].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_ORACLE_SIGNER_ROTATED]);
}

pub fn emit_admin_rotated(e: &AdminRotated) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::ADMIN_ROTATED;
    let b = &mut buf[1..1 + SZ_ADMIN_ROTATED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.previous_admin.as_ref());
    b[64..96].copy_from_slice(e.new_admin.as_ref());
    b[96..104].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_ADMIN_ROTATED]);
}

pub fn emit_inventory_withdrawn(e: &InventoryWithdrawn) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::INVENTORY_WITHDRAWN;
    let b = &mut buf[1..1 + SZ_INVENTORY_WITHDRAWN];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.admin.as_ref());
    b[64..72].copy_from_slice(&e.base_amount.to_le_bytes());
    b[72..80].copy_from_slice(&e.quote_amount.to_le_bytes());
    b[80..88].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_INVENTORY_WITHDRAWN]);
}

pub fn emit_quote_marker_closed(e: &QuoteMarkerClosed) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::QUOTE_MARKER_CLOSED;
    let b = &mut buf[1..1 + SZ_QUOTE_MARKER_CLOSED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.closer.as_ref());
    b[64..72].copy_from_slice(&e.nonce.to_le_bytes());
    b[72..80].copy_from_slice(&e.expiry_slot.to_le_bytes());
    b[80..88].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_QUOTE_MARKER_CLOSED]);
}

pub fn emit_admin_proposal_created(e: &AdminProposalCreated) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::ADMIN_PROPOSAL_CREATED;
    let b = &mut buf[1..1 + SZ_ADMIN_PROPOSAL_CREATED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.proposed_by.as_ref());
    b[64..96].copy_from_slice(e.new_admin.as_ref());
    b[96..104].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_ADMIN_PROPOSAL_CREATED]);
}

pub fn emit_admin_proposal_cancelled(e: &AdminProposalCancelled) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::ADMIN_PROPOSAL_CANCELLED;
    let b = &mut buf[1..1 + SZ_ADMIN_PROPOSAL_CANCELLED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.admin.as_ref());
    b[64..96].copy_from_slice(e.cancelled_new_admin.as_ref());
    b[96..104].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_ADMIN_PROPOSAL_CANCELLED]);
}

pub fn emit_quote_signer_rotated(e: &QuoteSignerRotated) {
    let mut buf = [0u8; EMIT_BUF_CAP];
    buf[0] = tag::QUOTE_SIGNER_ROTATED;
    let b = &mut buf[1..1 + SZ_QUOTE_SIGNER_ROTATED];
    b[0..32].copy_from_slice(e.pool.as_ref());
    b[32..64].copy_from_slice(e.admin.as_ref());
    b[64..96].copy_from_slice(e.previous_signer.as_ref());
    b[96..128].copy_from_slice(e.new_signer.as_ref());
    b[128..136].copy_from_slice(&e.slot.to_le_bytes());
    log_data_one(&buf[..1 + SZ_QUOTE_SIGNER_ROTATED]);
}

#[cfg(test)]
mod size_tests {
    //! Compile-time guard: bytewise packers must produce the same byte count
    //! as Borsh serialize. If a struct field changes, both sides must update.

    use super::*;
    use borsh::BorshSerialize;

    fn borsh_len<T: BorshSerialize>(v: &T) -> usize {
        let mut buf = alloc::vec::Vec::new();
        v.serialize(&mut buf).unwrap();
        buf.len()
    }

    fn z_addr() -> Address {
        Address::default()
    }

    #[test]
    fn event_sizes_match_borsh() {
        assert_eq!(SZ_POOL_INITIALIZED, borsh_len(&PoolInitialized {
            pool: z_addr(), admin: z_addr(), oracle_signer: z_addr(),
            quote_signer: z_addr(), base_mint: z_addr(), quote_mint: z_addr(),
            initial_fair_value: 0, initial_spread_bps: 0, initial_mode_ttl: 0, slot: 0,
        }));
        assert_eq!(SZ_ORACLE_UPDATED, borsh_len(&OracleUpdated {
            pool: z_addr(), new_fair_value: 0, new_spread_bps: 0, new_nonce: 0, new_ttl: 0,
        }));
        assert_eq!(SZ_SWAP_EXECUTED, borsh_len(&SwapExecuted {
            pool: z_addr(), user: z_addr(), direction: 0, mode: 0,
            input_amount: 0, output_amount: 0, execution_price: 0, quote_nonce: 0, slot: 0,
        }));
        assert_eq!(SZ_POOL_PAUSED_CHANGED, borsh_len(&PoolPausedChanged {
            pool: z_addr(), admin: z_addr(), paused: 0, slot: 0,
        }));
        assert_eq!(SZ_ORACLE_SIGNER_ROTATED, borsh_len(&OracleSignerRotated {
            pool: z_addr(), admin: z_addr(), previous_signer: z_addr(),
            new_signer: z_addr(), slot: 0,
        }));
        assert_eq!(SZ_ADMIN_ROTATED, borsh_len(&AdminRotated {
            pool: z_addr(), previous_admin: z_addr(), new_admin: z_addr(), slot: 0,
        }));
        assert_eq!(SZ_INVENTORY_WITHDRAWN, borsh_len(&InventoryWithdrawn {
            pool: z_addr(), admin: z_addr(), base_amount: 0, quote_amount: 0, slot: 0,
        }));
        assert_eq!(SZ_QUOTE_MARKER_CLOSED, borsh_len(&QuoteMarkerClosed {
            pool: z_addr(), closer: z_addr(), nonce: 0, expiry_slot: 0, slot: 0,
        }));
        assert_eq!(SZ_ADMIN_PROPOSAL_CREATED, borsh_len(&AdminProposalCreated {
            pool: z_addr(), proposed_by: z_addr(), new_admin: z_addr(), slot: 0,
        }));
        assert_eq!(SZ_ADMIN_PROPOSAL_CANCELLED, borsh_len(&AdminProposalCancelled {
            pool: z_addr(), admin: z_addr(), cancelled_new_admin: z_addr(), slot: 0,
        }));
        assert_eq!(SZ_QUOTE_SIGNER_ROTATED, borsh_len(&QuoteSignerRotated {
            pool: z_addr(), admin: z_addr(), previous_signer: z_addr(),
            new_signer: z_addr(), slot: 0,
        }));
    }
}
