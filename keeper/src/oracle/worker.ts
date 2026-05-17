// ============================================================================
// Oracle worker loop
// ============================================================================
// docs/OPERATIONS.md §4 — Single-writer nonce, Mode A/B/C push, cancel priority.
//
// Per-mode push policy:
//   A — every ORACLE_MODE_A_PUSH_INTERVAL_MS (default 200ms)
//   B — only when thresholds are exceeded (RV spike or NBBO jump)
//   C — no push (worker sleeps)
//
// Single-writer: lastPushedNonce is an in-memory counter. On boot we seed it
// from the on-chain nonce. Every push increments nonce; on failure the counter
// is rolled back.

import { ComputeBudgetProgram, Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { bold, cyan, dim, red, yellow } from "@std/fmt/colors";

import { BN } from "../anchor.ts";

import type { KeeperConfig } from "../config.ts";
import type { KeeperProgram } from "../program.ts";
import type { PriceSource } from "../sources/types.ts";
import { DEFAULT_THRESHOLDS, decideMode, modeToTtl } from "./mode.ts";
import type { OracleSharedState } from "./state.ts";

export interface OracleWorkerOpts {
  config: KeeperConfig;
  program: KeeperProgram;
  source: PriceSource;
  state: OracleSharedState;
  /** Default spread (bps). Will be replaced by PriceEngine-driven logic later. */
  baseSpreadBps: number;
  depthParams: any;
  skewParams: any;
}

export interface OracleWorkerHandle {
  stop(): Promise<void>;
}

const DEFAULT_DEPTH_PARAMS = {
  depthCoefBps: 2,
  sizeUnit: new BN(1_000_000),
  maxDepthBps: 100,
  reserved: Array(6).fill(0),
};

const DEFAULT_SKEW_PARAMS = {
  targetBaseBps: 5_000,
  skewCoefBps: 50,
  maxSkewOffsetBps: 100,
  reserved: Array(10).fill(0),
};

export async function startOracleWorker(
  opts: OracleWorkerOpts
): Promise<OracleWorkerHandle> {
  const { config, program, source, state } = opts;

  let running = true;
  let lastChangeAt = Date.now();
  let lastUpgradeTriggerAt = Date.now();
  let lastNbboMid = state.latestTick.fairValue;
  let nbbo30sMoveBps = 0;
  // Consecutive failure counter — guards against a tight retry loop when the
  // RPC is down or rate-limited.
  let consecutiveFailures = 0;

  // Shutdown signal: lets in-flight sleeps wake immediately on SIGINT/SIGTERM
  // instead of waiting up to 30s (backoff cap) or the mode-C 30s poll interval.
  const shutdown = new AbortController();
  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (shutdown.signal.aborted) return resolve();
      const t = setTimeout(() => {
        shutdown.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      shutdown.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Re-sync the in-memory nonce from on-chain. After repeated failures we may
  // be out of step with chain state (e.g. a tx that we thought failed actually
  // landed, advancing the on-chain nonce past our counter). Refetch and reset.
  async function resyncNonceFromChain(): Promise<void> {
    try {
      const onChain = await program.program.account.poolState.fetch(
        state.pool.poolState
      );
      const onChainNonce = BigInt(onChain.oracleNonce.toString());
      if (onChainNonce !== state.lastPushedNonce) {
        console.warn(
          yellow(
            `  [oracle] nonce drift detected — local=${state.lastPushedNonce}, chain=${onChainNonce} → resyncing`
          )
        );
        state.lastPushedNonce = onChainNonce;
      }
    } catch (err) {
      console.error(
        red(`  [oracle] resyncNonceFromChain failed: ${(err as Error).message}`)
      );
    }
  }

  // Update source ticks in the background.
  const sourceStop = await source.start();

  // Helper: build + send update_oracle ix.
  // Refuses to push when the source-reported tick status is anything other
  // than "fresh". Pushing a stale/halted/unknown price would advertise an
  // out-of-date curve to on-chain swaps; we'd rather hold whatever the
  // chain has and let TTL run out into Mode C.
  async function pushOracle(forcedMode?: "A" | "B" | "C"): Promise<boolean> {
    const tick = await source.current();
    if (tick.status !== "fresh") {
      console.warn(
        yellow(
          `  [oracle] skipping push — source tick status=${tick.status} ` +
            `(label=${source.label}, age=${
              Date.now() - tick.timestamp
            }ms). Holding existing on-chain curve.`
        )
      );
      return false;
    }
    const mode = forcedMode ?? state.currentMode;
    const ttl = modeToTtl(mode);

    // Spread: PoC default base + volatility premium
    const volPremiumBps = Math.min(Number(tick.realizedVolBps), 50);
    const spreadBps = Math.min(opts.baseSpreadBps + volPremiumBps, 1000);

    const newNonce = state.lastPushedNonce + 1n;

    // Cancel priority — per-mode priority fee (microLamports / CU). Mode A
    // must land before snipers for stale-quote defense to hold. Mode C never
    // pushes, so it pays no fee.
    const priorityFee =
      mode === "A"
        ? config.oracleModeAPriorityFeeMicrolamports
        : mode === "B"
        ? config.oracleModeBPriorityFeeMicrolamports
        : 0;
    const preIxs = priorityFee > 0
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })]
      : [];

    try {
      const sig = await program.program.methods
        .updateOracle(
          new BN(tick.fairValue.toString()),
          spreadBps,
          opts.depthParams ?? DEFAULT_DEPTH_PARAMS,
          opts.skewParams ?? DEFAULT_SKEW_PARAMS,
          new BN(newNonce.toString()),
          ttl
        )
        .accountsPartial({
          oracleSigner: state.oracleSigner.publicKey,
          poolState: state.pool.poolState,
        })
        .preInstructions(preIxs)
        .signers([state.oracleSigner])
        .rpc();

      state.lastPushedNonce = newNonce;
      state.lastPushedFairValue = tick.fairValue;
      state.lastPushedSpreadBps = spreadBps;
      state.lastPushedTtl = ttl;
      state.currentMode = mode;
      state.lastPushAt = Date.now();
      state.latestTick = tick;
      consecutiveFailures = 0;

      if (config.verbose) {
        console.log(
          dim(
            `  [oracle] mode=${mode} ttl=${ttl} fair=${tick.fairValue} spread=${spreadBps} nonce=${newNonce} sig=${sig.slice(0, 8)}...`
          )
        );
      }
      return true;
    } catch (err) {
      consecutiveFailures += 1;
      console.error(
        red(
          `  [oracle] push failed (consecutive=${consecutiveFailures}): ${(err as Error).message}`
        )
      );
      // Counter is NOT advanced — the next attempt will reuse the same nonce.
      return false;
    }
  }

  // Stale-tick policy: if the source stays non-fresh for a window, force
  // Mode C so RFQ takes over. This handles "Pyth equity feed after NYSE
  // close" and "Hermes endpoint degraded" the same way.
  const STALE_FORCE_MODE_C_AFTER_MS = 30_000;
  let firstStaleObservedAt: number | null = null;
  function notePush(ok: boolean): void {
    if (ok) {
      firstStaleObservedAt = null;
      return;
    }
    if (firstStaleObservedAt === null) firstStaleObservedAt = Date.now();
    const elapsed = Date.now() - firstStaleObservedAt;
    if (elapsed > STALE_FORCE_MODE_C_AFTER_MS && state.currentMode !== "C") {
      console.warn(
        yellow(
          `  [oracle] source non-fresh for ${(elapsed / 1000).toFixed(0)}s → forcing Mode C`
        )
      );
      state.currentMode = "C";
      state.lastPushedTtl = 0;
      lastChangeAt = Date.now();
    }
  }

  // Main loop
  (async () => {
    // Initial push (Mode C runs this only once — TTL=0 set).
    notePush(await pushOracle());

    while (running) {
      // Cycle start. We must subtract push latency from the sleep so the real
      // cadence matches the interval. Otherwise Mode A's 200ms interval grows
      // to 300–500ms once push latency (100–300ms) is added.
      const cycleStart = Date.now();

      const tick = await source.current();
      state.latestTick = tick;

      // Track NBBO movement (rolling)
      const moveBps = Number(
        ((tick.fairValue - lastNbboMid) * 10_000n) /
          (lastNbboMid > 0n ? lastNbboMid : 1n)
      );
      nbbo30sMoveBps = nbbo30sMoveBps * 0.8 + moveBps * 0.2;
      lastNbboMid = tick.fairValue;

      // Decide mode
      const nextMode = decideMode(
        {
          current: state.currentMode,
          tick,
          lastChangeAt,
          lastUpgradeTriggerAt,
          nbbo30sMoveBps,
        },
        DEFAULT_THRESHOLDS
      );

      if (nextMode !== state.currentMode) {
        if (nextMode > state.currentMode) {
          // upgrade (C→B, B→A)
          lastUpgradeTriggerAt = Date.now();
          state.upgradeImminentUntil = Date.now() + 800; // 800ms window (§5.3)
        }
        console.log(
          bold(cyan(`  [oracle] mode change ${state.currentMode} → ${nextMode}`))
        );
        notePush(await pushOracle(nextMode));
        lastChangeAt = Date.now();
      } else if (state.currentMode === "A") {
        // Aggressive: push every interval.
        notePush(await pushOracle());
      } else if (state.currentMode === "B") {
        // Reactive: push only when thresholds are exceeded.
        if (
          Number(tick.realizedVolBps) > 50 ||
          Math.abs(nbbo30sMoveBps) > 5
        ) {
          notePush(await pushOracle());
        }
      }
      // Mode C: sleep — no push.

      const intervalMs =
        state.currentMode === "A"
          ? config.oracleModeAPushIntervalMs
          : state.currentMode === "B"
          ? config.oracleModeBEvalIntervalMs
          : config.oracleModeCPollIntervalMs;
      const elapsed = Date.now() - cycleStart;
      let sleepMs = Math.max(0, intervalMs - elapsed);

      // Exponential backoff — if the RPC is down or rate-limited, a tight loop
      // makes things worse. After 3 consecutive failures, add 200ms · 2^(n-3)
      // (capped at 30s) on top of the normal sleep.
      if (consecutiveFailures >= 3) {
        const extra = Math.min(
          30_000,
          200 * Math.pow(2, Math.min(consecutiveFailures - 3, 7))
        );
        sleepMs += extra;
        console.warn(
          yellow(
            `  [oracle] backoff ${extra}ms (consecutive failures=${consecutiveFailures})`
          )
        );
        // After 5 failures the local nonce counter may have drifted from chain
        // (e.g. a tx we thought failed actually landed). Re-read on-chain
        // nonce before retrying so we don't keep submitting a stale value.
        if (consecutiveFailures === 5 || consecutiveFailures % 10 === 0) {
          await resyncNonceFromChain();
        }
      }

      if (config.verbose && state.currentMode === "A" && elapsed > intervalMs) {
        console.warn(
          yellow(
            `  [oracle] mode A cycle overshoot: elapsed=${elapsed}ms > interval=${intervalMs}ms`
          )
        );
      }
      await interruptibleSleep(sleepMs);
    }
  })().catch((e) => console.error(red(`Oracle loop crashed: ${e}`)));

  return {
    async stop() {
      running = false;
      shutdown.abort();
      sourceStop();
    },
  };
}
