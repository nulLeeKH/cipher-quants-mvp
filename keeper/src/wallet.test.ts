import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { Keypair } from "@solana/web3.js";

import {
  JsonFileKeypairProvider,
  loadKeypairFromFileSync,
} from "./wallet.ts";

async function writeTmpKeypair(secret: number[] | unknown): Promise<string> {
  const path = await Deno.makeTempFile({ prefix: "kp-", suffix: ".json" });
  await Deno.writeTextFile(path, JSON.stringify(secret));
  return path;
}

Deno.test("JsonFileKeypairProvider — loads a valid 64-byte secret key", async () => {
  const kp = Keypair.generate();
  const path = await writeTmpKeypair(Array.from(kp.secretKey));
  try {
    const provider = new JsonFileKeypairProvider(path);
    const loaded = await provider.getKeypair();
    assertEquals(loaded.publicKey.equals(kp.publicKey), true);
    assertEquals(provider.label, "json-file");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("JsonFileKeypairProvider — rejects wrong-length secret", async () => {
  const path = await writeTmpKeypair([1, 2, 3]); // not 64 bytes
  try {
    const provider = new JsonFileKeypairProvider(path);
    await assertRejects(
      () => provider.getKeypair(),
      Error,
      "expected 64-byte JSON array",
    );
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("JsonFileKeypairProvider — rejects non-array JSON", async () => {
  const path = await writeTmpKeypair({ secret: [1] });
  try {
    const provider = new JsonFileKeypairProvider(path);
    await assertRejects(
      () => provider.getKeypair(),
      Error,
      "expected 64-byte JSON array",
    );
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("JsonFileKeypairProvider — propagates missing-file errors", async () => {
  const provider = new JsonFileKeypairProvider(
    "/tmp/definitely-does-not-exist-cipher-quants.json",
  );
  await assertRejects(() => provider.getKeypair());
});

Deno.test("loadKeypairFromFileSync — loads and matches public key", async () => {
  const kp = Keypair.generate();
  const path = await writeTmpKeypair(Array.from(kp.secretKey));
  try {
    const loaded = loadKeypairFromFileSync(path);
    assertEquals(loaded.publicKey.equals(kp.publicKey), true);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("loadKeypairFromFileSync — throws on malformed JSON", async () => {
  const path = await Deno.makeTempFile({ prefix: "kp-", suffix: ".json" });
  await Deno.writeTextFile(path, "{not json}");
  try {
    assertThrows(() => loadKeypairFromFileSync(path));
  } finally {
    await Deno.remove(path);
  }
});
