// Runs in `setupFiles` (before the test framework is installed). Anything
// that consumers like @solana/web3.js or jose touch at module-load time
// must be polyfilled here, BEFORE any test or test-utility file is
// imported.

import { TextEncoder, TextDecoder } from "node:util";

if (typeof globalThis.TextEncoder === "undefined") {
  (globalThis as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
  (globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}
if (typeof globalThis.crypto === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { webcrypto } = require("node:crypto");
  (globalThis as unknown as { crypto: unknown }).crypto = webcrypto;
}

// jest-dom matchers live in jest.setup.ts (loaded via setupFilesAfterEnv —
// the correct Jest option name; `setupFilesAfterEach` does not exist).
