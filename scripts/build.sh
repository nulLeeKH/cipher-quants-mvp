#!/bin/bash
# ============================================================================
# Build the on-chain protocol program (Pinocchio-era).
#
# Usage:
#   ./scripts/build.sh              # build (default)
#   ./scripts/build.sh <label>      # same build; <label> is just a tag for logs
#
# The same .so is shipped to localnet / devnet / mainnet — no per-cluster
# cfg gates exist today. If a divergent build target is needed in the
# future, add a Cargo feature here, in programs/protocol/Cargo.toml, and
# in any code path that needs to branch on it.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/programs/protocol"

TARGET=${1:-mainnet}

echo "🔨 Building protocol (label: $TARGET)..."

cargo build-sbf

# Check program size
PROGRAM_PATH="$ROOT/target/deploy/protocol.so"
if [ -f "$PROGRAM_PATH" ]; then
  PROGRAM_SIZE=$(wc -c < "$PROGRAM_PATH" | tr -d ' ')
  PROGRAM_SIZE_KB=$(awk "BEGIN { printf \"%.2f\", $PROGRAM_SIZE / 1024 }")

  echo ""
  echo "✅ Build complete for $TARGET"
  echo ""
  echo "📦 Program size: $PROGRAM_SIZE bytes ($PROGRAM_SIZE_KB KB)"
  echo ""
  echo "💰 Estimated deployment cost:"
  solana rent "$PROGRAM_SIZE" 2>/dev/null || echo "   (install Solana CLI to see deployment cost)"
else
  echo "✅ Build complete for $TARGET"
fi
