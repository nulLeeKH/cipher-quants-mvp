#!/usr/bin/env bash
# ============================================================================
# validator-up.sh — Start a local solana-test-validator with the protocol
# program pre-deployed. Idempotent: re-running attaches to an existing
# validator if it's already up.
#
# Usage:
#   ./scripts/validator-up.sh                 # start in background
#   ./scripts/validator-up.sh --foreground    # start blocking (Ctrl-C to stop)
#
# Logs:
#   .anchor/validator.log            (validator stdout/stderr — banner,
#                                     slot tick lines)
#   .anchor/test-ledger/validator-<ts>.log
#                                    (validator internal metrics; not parsed)
#   .anchor/program-cu.log           (only when `measure-cu.sh` is running —
#                                     it subscribes via `solana logs`)
#
# After it's up:
#   solana config set --url http://127.0.0.1:8899
#   pnpm test
#   ./scripts/validator-down.sh
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROGRAM_ID="3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy"
PROGRAM_SO="target/deploy/protocol.so"
PROGRAM_KEYPAIR="target/deploy/protocol-keypair.json"
LEDGER_DIR=".anchor/test-ledger"
LOG_FILE=".anchor/validator.log"
PID_FILE=".anchor/validator.pid"

mkdir -p "$(dirname "$LOG_FILE")"

# Build first if the program binary isn't present
if [[ ! -f "$PROGRAM_SO" ]]; then
  echo "==> $PROGRAM_SO missing — running cargo build-sbf..."
  (cd programs/protocol && cargo build-sbf)
fi

# Verify the on-disk keypair matches declare_id!
if [[ -f "$PROGRAM_KEYPAIR" ]]; then
  ACTUAL=$(solana address -k "$PROGRAM_KEYPAIR")
  if [[ "$ACTUAL" != "$PROGRAM_ID" ]]; then
    echo "ERROR: $PROGRAM_KEYPAIR pubkey ($ACTUAL) != declare_id! ($PROGRAM_ID)"
    echo "       Re-generate the keypair or update lib.rs declare_id!()."
    exit 1
  fi
fi

# Already running?
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "==> validator already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

# Detect listening port to fail fast if 8899 is occupied
if lsof -nP -iTCP:8899 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR: port 8899 already in use. Stop the other process and retry."
  exit 1
fi

# Wipe stale ledger only if we know it was ours
[[ -d "$LEDGER_DIR" ]] && rm -rf "$LEDGER_DIR"

VALIDATOR_ARGS=(
  --reset
  --quiet
  --ledger "$LEDGER_DIR"
  --rpc-port 8899
  --bind-address 127.0.0.1
  --bpf-program "$PROGRAM_ID" "$PROGRAM_SO"
)
# NOTE: `solana-test-validator` does not write per-program logs to disk —
# transaction "Program log:" + "consumed N of M compute units" lines only
# appear in JSON-RPC `getTransaction` responses, or over the logsSubscribe
# WebSocket. `scripts/measure-cu.sh` subscribes via `solana logs <PROGRAM_ID>`
# to capture them while tests run. `--quiet` here is fine — it only suppresses
# the validator's own banner / slot ticker.

FOREGROUND=false
for arg in "$@"; do
  case "$arg" in
    --foreground|-f) FOREGROUND=true ;;
  esac
done

if $FOREGROUND; then
  echo "==> running validator in foreground (Ctrl-C to stop)"
  exec solana-test-validator "${VALIDATOR_ARGS[@]}"
fi

echo "==> starting validator (background) — logs: $LOG_FILE"
solana-test-validator "${VALIDATOR_ARGS[@]}" >"$LOG_FILE" 2>&1 &
echo "$!" > "$PID_FILE"

# Wait for RPC readiness (max 15s)
for i in {1..30}; do
  if curl -fs -X POST -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
       http://127.0.0.1:8899 >/dev/null 2>&1; then
    echo "==> validator ready @ http://127.0.0.1:8899 (pid $(cat "$PID_FILE"))"
    echo "    program: $PROGRAM_ID"
    echo "    stop:    ./scripts/validator-down.sh"
    exit 0
  fi
  sleep 0.5
done

echo "ERROR: validator did not become ready within 15s. Tail of $LOG_FILE:"
tail -30 "$LOG_FILE"
exit 1
