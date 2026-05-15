#!/usr/bin/env -S deno run -A --unstable-sloppy-imports

import { Buffer } from "node:buffer";
if (typeof (globalThis as Record<string, unknown>).Buffer === "undefined") {
  (globalThis as Record<string, unknown>).Buffer = Buffer;
}

import { parseArgs } from "@std/cli/parse-args";
import { bold, cyan, dim, red } from "@std/fmt/colors";

import { loadConfig } from "./config.ts";
import { startApiServer } from "./server.ts";

const VERSION = "0.1.0";

const HELP = `
${bold(cyan("Cipher Quants API Server"))} ${dim(`v${VERSION}`)}

24/7 RFQ webhook (JupiterZ-compatible) + read-only on-chain query layer.
Runs even when keeper is sleeping (Mode C, market closed).

${bold("USAGE:")}
  api-server [options]

${bold("OPTIONS:")}
  -h, --help                Show this help
  -V, --version             Show version
  -v, --verbose             Verbose logging
      --quote-signer-wallet Path to quote signer keypair JSON

${bold("ENV VARS:")} (see api/.env.example)
  RPC_URL, RPC_PROVIDER, QUOTE_SIGNER_WALLET_PATH,
  BASE_MINT, QUOTE_MINT, API_PORT, QUOTE_VALID_WINDOW_SLOTS, ...

${bold("ENDPOINTS:")} (JupiterZ-compatible)
  GET  /health                  liveness
  GET  /tokens                  supported mints
  POST /quote                   request signed RFQ quote
  POST /swap                    finalize swap tx (returns signedQuote + verifyIx)
`;

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version", "verbose"],
    string: ["quote-signer-wallet"],
    alias: { h: "help", V: "version", v: "verbose" },
  });

  if (args.help) {
    console.log(HELP);
    Deno.exit(0);
  }
  if (args.version) {
    console.log(VERSION);
    Deno.exit(0);
  }

  const config = loadConfig(args);
  console.log(dim(`  RPC: ${config.rpcProvider} (${config.rpcUrl})`));

  const handle = await startApiServer(config);

  // Graceful shutdown
  const cleanup = async () => {
    console.log(dim("\nShutting down..."));
    await handle.stop();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", cleanup);
  Deno.addSignalListener("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error(red("Fatal:"), err);
  Deno.exit(1);
});
