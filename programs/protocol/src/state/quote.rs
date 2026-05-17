use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::Address;

use crate::state::Side;

// ============================================================================
// SignedQuote (instruction arg, not an account)
// ============================================================================
// A quote ed25519-signed by the RFQ webhook with the MM's oracle key.
// docs/SPECIFICATION.md §2.3.

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct SignedQuote {
    pub pool: Address,
    pub user: Address,
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

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct SignedQuoteMessage {
    pub pool: Address,
    pub user: Address,
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

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::BorshSerialize;

    /// Golden-bytes parity test — proves that Rust Borsh and the SDK's
    /// hand-rolled serializer produce byte-for-byte identical output. A
    /// mirror test on the SDK side uses the same fixture (see the
    /// "Borsh parity" describe in tests/protocol.test.ts). Both must pass for
    /// RFQ signature verification to operate safely.
    #[test]
    fn signed_quote_message_golden_bytes() {
        let pool = Address::new_from_array([0x01; 32]);
        let user = Address::new_from_array([0x02; 32]);
        let msg = SignedQuoteMessage {
            pool,
            user,
            direction: Side::Sell,
            input_amount: 1_000,
            price: 100_000_000,
            expiry_slot: 200,
            nonce: 1,
        };

        let mut bytes = Vec::<u8>::new();
        msg.serialize(&mut bytes).expect("borsh serialize");
        assert_eq!(bytes.len(), 97, "SignedQuoteMessage size must be 97 bytes");

        let mut expected = Vec::<u8>::with_capacity(97);
        expected.extend_from_slice(&[0x01; 32]); // pool
        expected.extend_from_slice(&[0x02; 32]); // user
        expected.push(0x01); // Side::Sell discriminant
        expected.extend_from_slice(&1_000u64.to_le_bytes());
        expected.extend_from_slice(&100_000_000u64.to_le_bytes());
        expected.extend_from_slice(&200u64.to_le_bytes());
        expected.extend_from_slice(&1u64.to_le_bytes());

        assert_eq!(
            bytes, expected,
            "Borsh output mismatch — SDK serializer or on-chain layout has drifted"
        );
    }

    #[test]
    fn side_buy_discriminant_is_zero() {
        let mut bytes = Vec::<u8>::new();
        Side::Buy.serialize(&mut bytes).unwrap();
        assert_eq!(bytes, vec![0x00]);
    }
}
