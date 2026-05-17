// ============================================================================
// STATE (Account Structures)
// ============================================================================
// Detailed account model: docs/ARCHITECTURE.md §4, docs/SPECIFICATION.md §2.
//
// Pinocchio era: each account record carries an 8-byte tag at offset 0 (the
// `DISCRIMINATOR` const), followed by a Borsh-encoded body. The first byte of
// the discriminator is a stable small integer (assigned in `Tag` below) so it
// can be inspected at a glance during debugging; the remaining 7 bytes are
// zeros and reserved for future variants.

pub mod admin_proposal;
pub mod pool;
pub mod quote;
pub mod quote_nonce_marker;

pub use admin_proposal::*;
pub use pool::*;
pub use quote::*;
pub use quote_nonce_marker::*;

/// Account discriminator tags. Assigned once and never reordered — clients
/// rely on these to identify which account variant a 0-prefix-byte represents.
pub mod tag {
    pub const POOL_STATE: u8 = 0x01;
    pub const QUOTE_NONCE_MARKER: u8 = 0x02;
    pub const ADMIN_ROTATION_PROPOSAL: u8 = 0x03;
}

/// Build a full 8-byte discriminator from a 1-byte tag (rest = zeros).
pub const fn discriminator(tag: u8) -> [u8; 8] {
    [tag, 0, 0, 0, 0, 0, 0, 0]
}
