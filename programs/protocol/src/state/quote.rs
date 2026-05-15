use anchor_lang::prelude::*;

use crate::state::Side;

// ============================================================================
// SignedQuote (instruction arg, not an account)
// ============================================================================
// A quote ed25519-signed by the RFQ webhook with the MM's oracle key.
// docs/SPECIFICATION.md §2.3.

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SignedQuote {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub direction: Side,
    pub input_amount: u64,
    pub price: u64,
    pub expiry_slot: u64,
    pub nonce: u64,
    /// ed25519 signature over Borsh(SignedQuoteMessage). On-chain verification
    /// cross-checks this against the ed25519 native program payload read from
    /// the instructions sysvar.
    pub signature: [u8; 64],
}

// ============================================================================
// SignedQuoteMessage (canonical signing payload)
// ============================================================================
// SignedQuote minus the signature field — Borsh-serialized and signed via ed25519.
// Field order must match exactly so the SDK / RFQ webhook and on-chain verify agree.
//
// Serialized size: 32 + 32 + 1 + 8 + 8 + 8 + 8 = 97 bytes.

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SignedQuoteMessage {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub direction: Side,
    pub input_amount: u64,
    pub price: u64,
    pub expiry_slot: u64,
    pub nonce: u64,
}

impl From<&SignedQuote> for SignedQuoteMessage {
    fn from(sq: &SignedQuote) -> Self {
        Self {
            pool: sq.pool,
            user: sq.user,
            direction: sq.direction,
            input_amount: sq.input_amount,
            price: sq.price,
            expiry_slot: sq.expiry_slot,
            nonce: sq.nonce,
        }
    }
}
