#!/usr/bin/env -S deno run -A --unstable-sloppy-imports

// Polyfill Node.js Buffer for Deno compatibility with Anchor SDK
import { Buffer } from "node:buffer";
if (typeof (globalThis as Record<string, unknown>).Buffer === "undefined") {
  (globalThis as Record<string, unknown>).Buffer = Buffer;
}

import { parseArgs } from "@std/cli/parse-args";
import { bold, cyan, dim, yellow } from "@std/fmt/colors";
import { loadConfig } from "./config.ts";

const VERSION = "0.1.0";

const HELP = `
${bold(cyan("Keeper Bot"))} ${dim(`v${VERSION}`)}

Off-chain automation service for the Solana protocol.
Watches on-chain state and triggers actions automatically.

${bold("USAGE:")}
  keeper-bot <command> [options]

${bold("COMMANDS:")}
  start              Start the keeper service
  status             Show current protocol status

${bold("OPTIONS:")}
  -h, --help         Show this help message
  -V, --version      Show version
  -v, --verbose      Enable verbose logging

${bold("ENVIRONMENT VARIABLES:")}
  RPC_URL            Solana RPC endpoint (required)
  WALLET_PATH        Path to wallet JSON file
  VERBOSE            Enable verbose logging (default: false)

${bold("EXAMPLES:")}
  # Start keeper
  RPC_URL=https://api.devnet.solana.com keeper-bot start

  # Check status
  keeper-bot status
`;

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version", "verbose"],
    string: ["wallet"],
    alias: {
      h: "help",
      V: "version",
      v: "verbose",
      w: "wallet",
    },
  });

  if (args.help || args._.length === 0) {
    console.log(HELP);
    Deno.exit(0);
  }

  if (args.version) {
    console.log(VERSION);
    Deno.exit(0);
  }

  const command = String(args._[0]);
  const config = loadConfig(args);

  switch (command) {
    case "start": {
      console.log(`${bold(cyan("Starting keeper service..."))}`)
      console.log(`  RPC: ${config.rpcUrl}`);
      console.log(`  Verbose: ${config.verbose}`);
      // TODO: Import and call your service loop
      // import { startService } from "./service.ts";
      // await startService(config);
      console.log(yellow("Service not yet implemented. Add your logic to service.ts"));
      break;
    }

    case "status": {
      console.log(`${bold("Protocol Status")}`);
      // TODO: Fetch and display on-chain state
      console.log(yellow("Status command not yet implemented."));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      Deno.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
