#!/usr/bin/env bash
# Copy generated IDL + TypeScript types to the SDK.
# Run after `anchor build`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_JSON="$ROOT/target/idl/protocol.json"
SRC_TS="$ROOT/target/types/protocol.ts"
DST_DIR="$ROOT/sdk/src/idl"

if [[ ! -f "$SRC_JSON" ]] || [[ ! -f "$SRC_TS" ]]; then
  echo "❌ IDL/types not found. Run 'anchor build' first." >&2
  exit 1
fi

mkdir -p "$DST_DIR"
cp "$SRC_JSON" "$DST_DIR/protocol.json"
cp "$SRC_TS" "$DST_DIR/protocol.ts"

echo "✅ Copied IDL → $DST_DIR/protocol.json"
echo "✅ Copied types → $DST_DIR/protocol.ts"
