import { assertEquals } from "@std/assert";
import { Keypair } from "@solana/web3.js";

import { createQuoteStore, type PendingQuote } from "../../src/quote_store.ts";

function pending(quoteId: string): PendingQuote {
  const poolAddr = Keypair.generate().publicKey;
  const userPk = Keypair.generate().publicKey;
  return {
    quoteId,
    poolAddr,
    userPk,
    direction: "buy",
    inAmount: 1n,
    outAmount: 1n,
    price: 1n,
    fairValueAtQuote: 1n,
    expirySlot: 10n,
    nonce: BigInt(quoteId),
    marker: Keypair.generate().publicKey,
  };
}

Deno.test("quote store — set/get/delete pending quote", () => {
  const store = createQuoteStore({
    maxEntries: 10,
    ttlMs: 1_000,
    sweepIntervalMs: 0,
  });
  store.set(pending("1"));
  assertEquals(store.get("1")?.quoteId, "1");
  store.delete("1");
  assertEquals(store.get("1"), undefined);
  store.stop();
});

Deno.test("quote store — maxEntries evicts oldest quote", () => {
  const store = createQuoteStore({
    maxEntries: 2,
    ttlMs: 1_000,
    sweepIntervalMs: 0,
  });
  store.set(pending("1"));
  store.set(pending("2"));
  store.set(pending("3"));
  assertEquals(store.get("1"), undefined);
  assertEquals(store.get("2")?.quoteId, "2");
  assertEquals(store.get("3")?.quoteId, "3");
  store.stop();
});
