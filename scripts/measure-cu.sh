#!/usr/bin/env bash
# ============================================================================
# measure-cu.sh — Run the integration test suite, capture per-tx program logs
# via `solana logs`, then aggregate Compute-Unit usage into docs/PERFORMANCE.md.
#
# Why a `solana logs` subscriber: `solana-test-validator` does not persist
# transaction logs to disk by default (the per-program-log files were an
# Anchor-CLI feature). The Pinocchio era doesn't have that, so we stream them
# out of the validator over its JSON-RPC WebSocket.
#
# Flow:
#   1. validator-up.sh (idempotent; reuses an existing validator if present)
#   2. `solana logs <PROGRAM_ID>` in the background → .anchor/program-cu.log
#   3. jest (pointed at the local validator)
#   4. stop the logs subscriber
#   5. awk over .anchor/program-cu.log → pair `Instruction: <Name>` with the
#      next `consumed N of M compute units` → docs/PERFORMANCE.md
#
# Usage:
#   ./scripts/measure-cu.sh                  # full pipeline
#   ./scripts/measure-cu.sh --skip-test      # re-aggregate the existing log
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROGRAM_ID="3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy"
LOG_FILE=".anchor/program-cu.log"
OUT=docs/PERFORMANCE.md

# Whitelist of OUR instruction names — keeps SPL Token's
# `Instruction: Transfer` / `Instruction: InitializeAccount3` CPI lines from
# clobbering the most-recent-Instruction tracker mid-tx.
OUR_IX_RE="^(InitPool|UpdateOracle|ExecuteSwap|SetPaused|RotateOracleSigner|RotateAdmin|AdminWithdrawInventory|CloseExpiredNonce|ProposeAdmin|AcceptAdmin|CancelAdminProposal|RotateQuoteSigner)$"

SKIP_TEST=false
for arg in "$@"; do
  case "$arg" in
    --skip-test) SKIP_TEST=true ;;
  esac
done

LOGS_PID=""
OWN_VALIDATOR=0
cleanup() {
  if [[ -n "$LOGS_PID" ]] && kill -0 "$LOGS_PID" 2>/dev/null; then
    kill "$LOGS_PID" 2>/dev/null || true
  fi
  if [[ "$OWN_VALIDATOR" == "1" ]]; then
    ./scripts/validator-down.sh || true
  fi
}
trap cleanup EXIT INT TERM

if ! $SKIP_TEST; then
  if ! curl -fs -X POST -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
       http://127.0.0.1:8899 >/dev/null 2>&1; then
    echo "==> starting validator"
    ./scripts/validator-up.sh
    OWN_VALIDATOR=1
  fi

  echo "==> subscribing to logs for $PROGRAM_ID"
  mkdir -p "$(dirname "$LOG_FILE")"
  : > "$LOG_FILE"
  solana logs --url http://127.0.0.1:8899 "$PROGRAM_ID" >"$LOG_FILE" 2>&1 &
  LOGS_PID=$!
  sleep 1

  echo "==> running jest"
  export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
  export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
  pnpm exec jest --preset ts-jest --json --outputFile=test_result.json || {
    echo "==> WARNING: jest exited non-zero; aggregating logs anyway."
  }

  echo "==> stopping logs subscriber"
  kill "$LOGS_PID" 2>/dev/null || true
  LOGS_PID=""
fi

if [[ ! -s "$LOG_FILE" ]]; then
  echo "ERROR: $LOG_FILE is empty. Did the subscriber catch any traffic?"
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

awk -v our_re="$OUR_IX_RE" -v consumed_re="Program $PROGRAM_ID consumed [0-9]+ of [0-9]+ compute units" -v invoke_re="Program $PROGRAM_ID invoke \\\\[1\\\\]" '
  # Track the most recent OUR-program invoke so an unlabeled consumed-line
  # (no preceding `Instruction: <Name>`) is attributable. UpdateOracle is the
  # only ix that intentionally skips its IX_LOG_LINES emit on the keeper hot
  # path (programs/protocol/src/lib.rs) to shave CU.
  $0 ~ invoke_re {
    invoked = 1
    next
  }
  # Only our 12 instruction names update the tracker; SPL Token CPI lines
  # like `Instruction: Transfer` / `Instruction: InitializeAccount3` are
  # ignored.
  /Program log: Instruction:/ {
    line = $0
    sub(/.*Instruction: */, "", line)
    if (line ~ our_re) {
      ix = line
    }
    next
  }
  # Only OUR program-id consumed line pairs with the most recent
  # `Instruction: <ours>` (or invoke when the ix omitted its log line).
  # Sub-CPI consumed lines (Transfer, InitializeAccount3) belong to other
  # programs and never match this consumed_re anyway.
  $0 ~ consumed_re {
    match($0, /consumed [0-9]+/)
    n = substr($0, RSTART + 9, RLENGTH - 9) + 0
    if (ix != "") {
      print ix "\t" n
      ix = ""
      invoked = 0
    } else if (invoked) {
      # Hot path: no Instruction line was emitted ⇒ attribute to UpdateOracle.
      print "UpdateOracle\t" n
      invoked = 0
    }
  }
' "$LOG_FILE" > "$TMP"

if [[ ! -s "$TMP" ]]; then
  echo "ERROR: no CU samples found in $LOG_FILE."
  echo "       Possible causes:"
  echo "         - tests did not exercise the program (check Jest output)"
  echo "         - solana logs subscriber failed to attach in time"
  echo "         - program ID mismatch (expected: $PROGRAM_ID)"
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<'EOF'
# Compute-Unit Performance

> Auto-generated by `scripts/measure-cu.sh`. Re-run after meaningful changes
> to instruction bodies. Source: `.anchor/program-cu.log` — the output of
> `solana logs <PROGRAM_ID>` streamed during the Jest run.
>
> Solana default CU budget per instruction = 200,000. Treat >100,000 as a
> yellow flag and >150,000 as red. Each row aggregates one
> `Program log: Instruction: <Name>` paired with the following
> `Program <id> consumed N of M compute units` line.

EOF

echo "## Per-instruction CU (samples from latest test run)" >> "$OUT"
echo "" >> "$OUT"
echo "| Instruction | Samples | Min | Mean | P95 | Max | Status |" >> "$OUT"
echo "|---|---:|---:|---:|---:|---:|---|" >> "$OUT"

awk -F'\t' '
  { vals[$1] = (vals[$1] == "" ? $2 : vals[$1] " " $2) }
  END {
    for (ix in vals) {
      n = split(vals[ix], v, " ")
      # Insertion sort — `asort` is gawk-only; BSD awk on macOS lacks it.
      for (i = 2; i <= n; i++) {
        key = v[i] + 0
        j = i - 1
        while (j > 0 && (v[j] + 0) > key) {
          v[j + 1] = v[j]
          j--
        }
        v[j + 1] = key
      }
      sum = 0
      for (i = 1; i <= n; i++) sum += v[i]
      mean = sum / n
      p95idx = int(0.95 * n)
      if (p95idx < 1) p95idx = 1
      if (p95idx > n) p95idx = n
      max = v[n]
      flag = (max > 150000 ? "🔴" : (max > 100000 ? "🟡" : "✅"))
      printf "| %s | %d | %d | %.0f | %d | %d | %s |\n",
             ix, n, v[1], mean, v[p95idx], v[n], flag
    }
  }
' "$TMP" | sort >> "$OUT"

echo "" >> "$OUT"
echo "## Raw sample count" >> "$OUT"
echo "" >> "$OUT"
echo "    $(wc -l < "$TMP" | tr -d ' ') consumed-line samples from $LOG_FILE" >> "$OUT"
echo "" >> "$OUT"
echo "_Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)_" >> "$OUT"

echo "==> wrote $OUT"
echo ""
cat "$OUT"
