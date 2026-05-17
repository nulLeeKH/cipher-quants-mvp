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
