import { assertEquals } from "jsr:@std/assert@1";
import { Keypair, PublicKey } from "@solana/web3.js";

import { createOracleSharedState, type PoolContext } from "./state.ts";

function makePool(): PoolContext {
  const id = PublicKey.default;
  return {
    poolState: id,
    baseMint: id,
    quoteMint: id,
    baseVault: id,
    quoteVault: id,
    bump: 255,
    admin: id,
  };
}

Deno.test("createOracleSharedState — bootstraps in Mode C with seed nonce", () => {
  const kp = Keypair.generate();
  const pool = makePool();
  const tick = {
    fairValue: 12345n,
    confidenceBps: 0n,
    realizedVolBps: 0n,
    timestamp: 1_000,
    status: "fresh" as const,
  };
  const s = createOracleSharedState(pool, kp, 7n, tick);
  assertEquals(s.lastPushedNonce, 7n);
  assertEquals(s.lastPushedFairValue, 12345n);
  assertEquals(s.lastPushedSpreadBps, 20);
  assertEquals(s.lastPushedTtl, 0);
  assertEquals(s.currentMode, "C");
  assertEquals(s.lastPushAt, 0);
  assertEquals(s.upgradeImminentUntil, 0);
  assertEquals(s.latestTick, tick);
  assertEquals(s.oracleSigner.publicKey.equals(kp.publicKey), true);
});

Deno.test("createOracleSharedState — seed nonce of 0 is permitted (first-ever pool)", () => {
  const tick = {
    fairValue: 100n,
    confidenceBps: 0n,
    realizedVolBps: 0n,
    timestamp: 0,
    status: "fresh" as const,
  };
  const s = createOracleSharedState(makePool(), Keypair.generate(), 0n, tick);
  assertEquals(s.lastPushedNonce, 0n);
});
