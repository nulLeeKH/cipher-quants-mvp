import { assertEquals } from "jsr:@std/assert@1";

import { nextQuoteNonce } from "./nonce.ts";

Deno.test("nextQuoteNonce — returns a bigint in u64 range", () => {
  const n = nextQuoteNonce();
  assertEquals(typeof n, "bigint");
  if (n < 0n || n > (1n << 64n) - 1n) {
    throw new Error(`out of range: ${n}`);
  }
});

Deno.test("nextQuoteNonce — no collisions across 10k draws (high entropy)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    seen.add(nextQuoteNonce().toString());
  }
  // With 64-bit entropy, the birthday probability of even one collision in
  // 10k draws is ~2.7e-12. A failure here is a real RNG regression.
  assertEquals(seen.size, 10_000);
});

Deno.test("nextQuoteNonce — accepts injected RNG (reproducibility for tests)", () => {
  const fakeBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  // deno-lint-ignore no-explicit-any
  const rng: any = { getRandomValues: (out: Uint8Array) => { out.set(fakeBytes); return out; } };
  const n = nextQuoteNonce(rng);
  // LE: bytes 01..08 → 0x0807060504030201
  assertEquals(n.toString(16), "807060504030201");
});
