// ============================================================================
// INSTRUCTION MODULES
// ============================================================================
// All instruction handlers. The lib.rs entry points delegate to this module.
// Spec: docs/SPECIFICATION.md §3.

pub mod accept_admin;
pub mod admin_withdraw_inventory;
pub mod cancel_admin_proposal;
pub mod close_expired_nonce;
pub mod execute_swap;
pub mod init_pool;
pub mod propose_admin;
pub mod rotate_admin;
pub mod rotate_oracle_signer;
pub mod set_paused;
pub mod update_oracle;

pub use accept_admin::*;
pub use admin_withdraw_inventory::*;
pub use cancel_admin_proposal::*;
pub use close_expired_nonce::*;
pub use execute_swap::*;
pub use init_pool::*;
pub use propose_admin::*;
pub use rotate_admin::*;
pub use rotate_oracle_signer::*;
pub use set_paused::*;
pub use update_oracle::*;
