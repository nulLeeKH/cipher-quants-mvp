#!/usr/bin/env bash
# ============================================================================
# test.sh — End-to-end integration test runner (Pinocchio-era).
#
# Replaces the previous `anchor test` flow:
#   1. cargo build-sbf — build the program .so
#   2. Start solana-test-validator with the .so preloaded
#   3. Run jest (tests/*.test.ts)
#   4. Stop the validator
#
# Jest expects ANCHOR_PROVIDER_URL + ANCHOR_WALLET to be set; we point them
# at the local validator and the default Solana CLI keypair.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROGRAM_SO="target/deploy/protocol.so"

# Always rebuild with `test-feature` enabled — it lowers SAFETY_BUFFER_SLOTS to
# 5 so close_expired_nonce happy-path tests don't have to wait 60s of slots.
# Mainnet / devnet builds via `scripts/build.sh` do NOT pass this feature.
echo "==> building with --features test-feature"
(cd programs/protocol && cargo build-sbf -- --features test-feature 2>&1 | tail -3)

# Always restart the validator so the freshly built .so (with test-feature)
# replaces whatever is currently loaded. Reusing a stale validator would run
# tests against a stale binary.
./scripts/validator-down.sh >/dev/null 2>&1 || true
./scripts/validator-up.sh

cleanup() {
  local rc=$?
  ./scripts/validator-down.sh || true
  exit $rc
}
trap cleanup EXIT INT TERM

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

echo "==> running jest"
pnpm exec jest --preset ts-jest --json --outputFile=test_result.json
