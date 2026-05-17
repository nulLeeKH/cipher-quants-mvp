import * as React from "react";
import { act, render } from "@testing-library/react";

import { useCurveFreshness } from "./useCurveFreshness";

// Mock the connection — we don't need a real RPC.
jest.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({
    connection: { getSlot: jest.fn().mockResolvedValue(100) },
  }),
}));

function Probe({ lastSlot, ttl }: { lastSlot: bigint | null; ttl: number }) {
  const f = useCurveFreshness(lastSlot, ttl, 60_000); // long poll → won't tick mid-test
  return (
    <div data-testid="probe">
      {JSON.stringify({
        currentSlot: f.currentSlot,
        ageSlots: f.ageSlots,
        isFresh: f.isFresh,
        ttl: f.ttl,
      })}
    </div>
  );
}

async function probeState(lastSlot: bigint | null, ttl: number) {
  const utils = render(<Probe lastSlot={lastSlot} ttl={ttl} />);
  // Effects fire after render; wait for the async getSlot promise to resolve
  // (one microtask is enough since the mock resolves synchronously).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const el = utils.getByTestId("probe");
  return JSON.parse(el.textContent ?? "{}");
}

describe("useCurveFreshness", () => {
  it("starts with currentSlot=null then resolves after first tick", async () => {
    const s = await probeState(50n, 3);
    expect(s.currentSlot).toBe(100);
    expect(s.ageSlots).toBe(50);
    expect(s.isFresh).toBe(false); // 50 > TTL=3
    expect(s.ttl).toBe(3);
  });

  it("flags isFresh=true when age within TTL", async () => {
    const s = await probeState(98n, 3);
    expect(s.ageSlots).toBe(2);
    expect(s.isFresh).toBe(true);
  });

  it("TTL=0 → never fresh even when slot matches", async () => {
    const s = await probeState(100n, 0);
    expect(s.isFresh).toBe(false);
  });

  it("lastSlot=null → ageSlots=null, isFresh=false", async () => {
    const s = await probeState(null, 3);
    expect(s.ageSlots).toBeNull();
    expect(s.isFresh).toBe(false);
  });
});
