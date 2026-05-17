#!/bin/bash
# ============================================================================
# Build the on-chain protocol program (Pinocchio-era).
#
# Usage:
#   ./scripts/build.sh              # mainnet (default)
#   ./scripts/build.sh devnet       # devnet (extended oracle staleness)
#   ./scripts/build.sh localnet     # localnet
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/programs/protocol"

TARGET=${1:-mainnet}

echo "🔨 Building protocol for $TARGET..."

CARGO_BUILD_SBF_ARGS=()
case "$TARGET" in
  mainnet)
    echo "   Building mainnet version"
    ;;
  devnet)
    echo "   Building devnet version (devnet features enabled)"
    CARGO_BUILD_SBF_ARGS=(-- --features devnet)
    ;;
  localnet)
    echo "   Building localnet version"
    ;;
  *)
    echo "❌ Unknown target: $TARGET"
    echo "   Usage: ./scripts/build.sh [mainnet|devnet|localnet]"
    exit 1
    ;;
esac

cargo build-sbf "${CARGO_BUILD_SBF_ARGS[@]}"

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
