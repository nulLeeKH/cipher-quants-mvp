import { PublicKey } from "@solana/web3.js";

import { decodeEventLog, parseEventsFromLogs } from "./events.js";
import { Writer } from "./borsh.js";

// Helper: build a base64 EVT log line for a given tag + Borsh body.
function evtLog(tag: number, body: Uint8Array, prefix = "Program log: "): string {
  const payload = new Uint8Array(1 + body.length);
  payload[0] = tag;
  payload.set(body, 1);
  const b64 = Buffer.from(payload).toString("base64");
  return `${prefix}EVT:${b64}`;
}

function poolBytes(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function buildPoolPausedChangedBody(paused: boolean): Uint8Array {
  const w = new Writer();
  w.pubkey(new PublicKey(poolBytes(0x01))); // pool
  w.pubkey(new PublicKey(poolBytes(0x02))); // admin
  w.u8(paused ? 1 : 0);
  w.u64(BigInt(123)); // slot
  return w.finish();
}

describe("decodeEventLog", () => {
  it("returns null for non-event log lines", () => {
    expect(decodeEventLog("Program log: hello world")).toBeNull();
    expect(decodeEventLog("Random garbage")).toBeNull();
    expect(decodeEventLog("")).toBeNull();
  });

  it("returns null for unknown event tags", () => {
    const body = new Uint8Array([1, 2, 3]);
    expect(decodeEventLog(evtLog(0xff, body))).toBeNull();
  });

  it("decodes PoolPausedChanged (tag 0x04)", () => {
    const body = buildPoolPausedChangedBody(true);
    const out = decodeEventLog(evtLog(0x04, body));
    if (!out) throw new Error("expected event");
    expect(out.name).toBe("PoolPausedChanged");
    if (out.name !== "PoolPausedChanged") throw new Error("type narrow");
    expect(out.data.paused).toBe(true);
    expect(out.data.slot.toString()).toBe("123");
  });

  it("accepts both 'Program log: EVT:' and 'Program data: EVT:' prefixes", () => {
    const body = buildPoolPausedChangedBody(false);
    const logOut = decodeEventLog(evtLog(0x04, body, "Program log: "));
    const dataOut = decodeEventLog(evtLog(0x04, body, "Program data: "));
    expect(logOut).not.toBeNull();
    expect(dataOut).not.toBeNull();
  });

  it("returns null when base64 decode fails or payload too short", () => {
    expect(decodeEventLog("Program log: EVT:!!not-base64!!")).toBeNull();
    // Zero-byte payload would have no tag byte.
    expect(decodeEventLog("Program log: EVT:")).toBeNull();
  });

  it("returns null when Borsh body is truncated for a known tag", () => {
    // PoolPausedChanged needs 32+32+1+8 = 73 bytes; supply 4 → decode throws → null.
    expect(decodeEventLog(evtLog(0x04, new Uint8Array(4)))).toBeNull();
  });
});

describe("parseEventsFromLogs", () => {
  it("collects all EVT lines and skips noise", () => {
    const body = buildPoolPausedChangedBody(true);
    const logs = [
      "Program <id> invoke [1]",
      "Program log: Instruction: SetPaused",
      evtLog(0x04, body),
      "Program log: not an event",
      evtLog(0xff, new Uint8Array(0)), // unknown tag → skipped
    ];
    const events = parseEventsFromLogs(logs);
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("PoolPausedChanged");
  });

  it("returns empty array when no events present", () => {
    expect(parseEventsFromLogs([])).toEqual([]);
    expect(parseEventsFromLogs(["Program log: Instruction: InitPool"])).toEqual([]);
  });
});

// ============================================================================
// quote_signer split — event coverage
// ============================================================================

import BN from "bn.js";

function buildQuoteSignerRotatedBody(): Uint8Array {
  const w = new Writer();
  w.pubkey(new PublicKey(poolBytes(0x10))); // pool
  w.pubkey(new PublicKey(poolBytes(0x11))); // admin
  w.pubkey(new PublicKey(poolBytes(0x12))); // previousSigner
  w.pubkey(new PublicKey(poolBytes(0x13))); // newSigner
  w.u64(BigInt(987)); // slot
  return w.finish();
}

function buildPoolInitializedBody(): Uint8Array {
  const w = new Writer();
  w.pubkey(new PublicKey(poolBytes(0x20))); // pool
  w.pubkey(new PublicKey(poolBytes(0x21))); // admin
  w.pubkey(new PublicKey(poolBytes(0x22))); // oracleSigner
  w.pubkey(new PublicKey(poolBytes(0x23))); // quoteSigner — new field
  w.pubkey(new PublicKey(poolBytes(0x24))); // baseMint
  w.pubkey(new PublicKey(poolBytes(0x25))); // quoteMint
  w.u64(new BN(100_000_000)); // initialFairValue
  w.u16(20); // initialSpreadBps
  w.u8(3); // initialModeTtl
  w.u64(BigInt(111)); // slot
  return w.finish();
}

describe("decodeEventLog — quote_signer split events", () => {
  it("decodes QuoteSignerRotated (tag 0x0B)", () => {
    const log = evtLog(0x0b, buildQuoteSignerRotatedBody());
    const decoded = decodeEventLog(log);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("QuoteSignerRotated");
    const data = decoded!.data as any;
    expect(data.pool.toBase58()).toBe(new PublicKey(poolBytes(0x10)).toBase58());
    expect(data.admin.toBase58()).toBe(new PublicKey(poolBytes(0x11)).toBase58());
    expect(data.previousSigner.toBase58()).toBe(
      new PublicKey(poolBytes(0x12)).toBase58()
    );
    expect(data.newSigner.toBase58()).toBe(
      new PublicKey(poolBytes(0x13)).toBase58()
    );
    expect(data.slot.toString()).toBe("987");
    expect(data.previousSigner.toBase58()).not.toBe(data.newSigner.toBase58());
  });

  it("decodes PoolInitialized with the new quoteSigner field", () => {
    const log = evtLog(0x01, buildPoolInitializedBody());
    const decoded = decodeEventLog(log);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("PoolInitialized");
    const data = decoded!.data as any;
    expect(data.oracleSigner.toBase58()).toBe(
      new PublicKey(poolBytes(0x22)).toBase58()
    );
    expect(data.quoteSigner.toBase58()).toBe(
      new PublicKey(poolBytes(0x23)).toBase58()
    );
    expect(data.quoteSigner.toBase58()).not.toBe(data.oracleSigner.toBase58());
    expect(data.baseMint.toBase58()).toBe(
      new PublicKey(poolBytes(0x24)).toBase58()
    );
  });
});

describe("decodeEventLog — sol_log_data format (modern path)", () => {
  it("decodes `Program data: <base64>` (no EVT: prefix)", () => {
    const body = buildPoolPausedChangedBody(true);
    const payload = new Uint8Array(1 + body.length);
    payload[0] = 0x04; // POOL_PAUSED_CHANGED
    payload.set(body, 1);
    const b64 = Buffer.from(payload).toString("base64");
    const line = `Program data: ${b64}`;
    const decoded = decodeEventLog(line);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("PoolPausedChanged");
    expect((decoded!.data as any).paused).toBe(true);
  });

  it("Program data: with multiple space-separated blobs decodes the first", () => {
    const body = buildPoolPausedChangedBody(false);
    const payload = new Uint8Array(1 + body.length);
    payload[0] = 0x04;
    payload.set(body, 1);
    const b64 = Buffer.from(payload).toString("base64");
    // Simulate a sol_log_data call with two slices — runtime separates with " ".
    const line = `Program data: ${b64} otherblob==`;
    const decoded = decodeEventLog(line);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("PoolPausedChanged");
  });

  it("rejects garbage after the Program data: prefix", () => {
    expect(decodeEventLog("Program data: !@#notbase64")).toBeNull();
  });
});
