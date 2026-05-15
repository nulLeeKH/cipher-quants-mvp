#!/bin/bash

# Build Script
# Usage:
#   ./scripts/build.sh              - Build for mainnet (default)
#   ./scripts/build.sh devnet       - Build for devnet (extended oracle staleness)
#   ./scripts/build.sh localnet     - Build for localnet

set -e

TARGET=${1:-mainnet}

echo "🔨 Building protocol for $TARGET..."

case $TARGET in
  mainnet)
    echo "   Building mainnet version"
    anchor build
    ;;
  devnet)
    echo "   Building devnet version (devnet features enabled)"
    anchor build -- --features devnet
    ;;
  localnet)
    echo "   Building localnet version"
    anchor build
    ;;
  *)
    echo "❌ Unknown target: $TARGET"
    echo "   Usage: ./scripts/build.sh [mainnet|devnet|localnet]"
    exit 1
    ;;
esac

# Check program size
PROGRAM_PATH="./target/deploy/protocol.so"
if [ -f "$PROGRAM_PATH" ]; then
  PROGRAM_SIZE=$(wc -c < "$PROGRAM_PATH" | tr -d ' ')
  PROGRAM_SIZE_KB=$(echo "scale=2; $PROGRAM_SIZE / 1024" | bc)

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
