#!/usr/bin/env -S deno run -A --unstable-sloppy-imports

// Polyfill Node.js Buffer for Deno compatibility with Anchor SDK
import { Buffer } from "node:buffer";
if (typeof (globalThis as Record<string, unknown>).Buffer === "undefined") {
  (globalThis as Record<string, unknown>).Buffer = Buffer;
}

import { parseArgs } from "@std/cli/parse-args";
import { bold, cyan, dim, yellow, red } from "@std/fmt/colors";

import { loadConfig } from "./config.ts";
import { JsonFileKeypairProvider } from "./wallet.ts";
import { createRpcAdapter } from "./connection.ts";
import { buildProgram } from "./program.ts";
import { runInitPool } from "./commands/init_pool.ts";
import { runStatus } from "./commands/status.ts";
import { runOracle } from "./commands/oracle.ts";

const VERSION = "0.1.0";

const HELP = `
${bold(cyan("Cipher Quants Keeper"))} ${dim(`v${VERSION}`)}

Oracle pusher — calls update_oracle while Mode A/B is active.
The RFQ webhook runs separately in ${cyan("api/")} (24/7).

${bold("USAGE:")}
  keeper-bot <command> [options]

${bold("COMMANDS:")}
  init-pool          Initialize a pool (admin op, one-shot)
  status             Show pool state, vault balances, freshness
  oracle             Start oracle worker loop (PoC: mock price source)
  start              Alias for 'oracle'

${bold("OPTIONS:")}
  -h, --help             Show this help
  -V, --version          Show version
  -v, --verbose          Verbose logging
      --oracle-wallet    Path to oracle worker keypair JSON
      --admin-wallet     Path to admin keypair JSON
      --fee-payer-wallet Path to fee payer keypair JSON

${bold("ENV VARS:")} (see keeper/.env.example)
  RPC_URL, RPC_PROVIDER, ORACLE_WALLET_PATH, ADMIN_WALLET_PATH,
  BASE_MINT, QUOTE_MINT, ORACLE_MODE_A_PUSH_INTERVAL_MS, ...

${bold("RELATED:")}
  - api/         RFQ webhook (24/7, JupiterZ-compatible)
  - programs/    on-chain program
  - sdk/         shared TypeScript SDK
`;

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version", "verbose"],
    string: ["oracle-wallet", "admin-wallet", "fee-payer-wallet"],
    alias: { h: "help", V: "version", v: "verbose" },
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

  const rpc = createRpcAdapter({
    rpcUrl: config.rpcUrl,
    wsUrl: config.rpcWsUrl,
    provider: config.rpcProvider,
  });
  console.log(dim(`  RPC: ${rpc.provider} (${config.rpcUrl})`));

  // Common: oracle wallet load (used by all commands except init-pool which loads admin too)
  const loadProgram = async () => {
    const provider = new JsonFileKeypairProvider(config.oracleWalletPath);
    const payer = await provider.getKeypair();
    return buildProgram(rpc, payer, config.programIdOverride);
  };

  switch (command) {
    case "init-pool": {
      const program = await loadProgram();
      await runInitPool(config, program);
      break;
    }

    case "status": {
      const program = await loadProgram();
      await runStatus(config, program);
      break;
    }

    case "oracle":
    case "start": {
      const program = await loadProgram();
      await runOracle(config, program);
      break;
    }

    default:
      console.error(red(`Unknown command: ${command}`));
      console.log(HELP);
      Deno.exit(1);
  }
}

main().catch((err) => {
  console.error(red("Fatal error:"), err);
  Deno.exit(1);
});
