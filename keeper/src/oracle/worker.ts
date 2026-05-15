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

import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
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

  // Update source ticks in the background.
  const sourceStop = await source.start();

  // Helper: build + send update_oracle ix
  async function pushOracle(forcedMode?: "A" | "B" | "C"): Promise<void> {
    const tick = await source.current();
    const mode = forcedMode ?? state.currentMode;
    const ttl = modeToTtl(mode);

    // Spread: PoC default base + volatility premium
    const volPremiumBps = Math.min(Number(tick.realizedVolBps), 50);
    const spreadBps = Math.min(opts.baseSpreadBps + volPremiumBps, 1000);

    const newNonce = state.lastPushedNonce + 1n;

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
        .signers([state.oracleSigner])
        .rpc();

      state.lastPushedNonce = newNonce;
      state.lastPushedFairValue = tick.fairValue;
      state.lastPushedSpreadBps = spreadBps;
      state.lastPushedTtl = ttl;
      state.currentMode = mode;
      state.lastPushAt = Date.now();
      state.latestTick = tick;

      if (config.verbose) {
        console.log(
          dim(
            `  [oracle] mode=${mode} ttl=${ttl} fair=${tick.fairValue} spread=${spreadBps} nonce=${newNonce} sig=${sig.slice(0, 8)}...`
          )
        );
      }
    } catch (err) {
      console.error(red(`  [oracle] push failed: ${(err as Error).message}`));
      // Counter is NOT advanced — the next attempt will reuse the same nonce.
    }
  }

  // Main loop
  (async () => {
    // Initial push (Mode C runs this only once — TTL=0 set).
    await pushOracle();

    while (running) {
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
        await pushOracle(nextMode);
        lastChangeAt = Date.now();
      } else if (state.currentMode === "A") {
        // Aggressive: push every interval.
        await pushOracle();
      } else if (state.currentMode === "B") {
        // Reactive: push only when thresholds are exceeded.
        if (
          Number(tick.realizedVolBps) > 50 ||
          Math.abs(nbbo30sMoveBps) > 5
        ) {
          await pushOracle();
        }
      }
      // Mode C: sleep — no push.

      const sleepMs =
        state.currentMode === "A"
          ? config.oracleModeAPushIntervalMs
          : state.currentMode === "B"
          ? config.oracleModeBEvalIntervalMs
          : config.oracleModeCPollIntervalMs;
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  })().catch((e) => console.error(red(`Oracle loop crashed: ${e}`)));

  return {
    async stop() {
      running = false;
      sourceStop();
    },
  };
}
