import { createRequire } from "node:module";
import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";

import type { KeeperConfig } from "../config.ts";
import type { KeeperProgram } from "../program.ts";

const require = createRequire(import.meta.url);
const sdkAccounts = require("../../../sdk/dist/accounts/index.js") as {
  derivePoolState: any;
  fetchPoolState: any;
  fetchVaultBalances: any;
};

export async function runStatus(
  config: KeeperConfig,
  program: KeeperProgram
): Promise<void> {
  console.log(bold(cyan("Pool status")));
  console.log(dim(`  Program: ${program.programId.toBase58()}`));

  if (!config.baseMint || !config.quoteMint) {
    console.log(yellow("  BASE_MINT/QUOTE_MINT not set — pool lookup skipped"));
    return;
  }

  try {
    const { address, state } = await sdkAccounts.fetchPoolState(
      program.program,
      config.baseMint,
      config.quoteMint
    );
    const { baseAmount, quoteAmount } = await sdkAccounts.fetchVaultBalances(
      program.program,
      address,
      config.baseMint,
      config.quoteMint
    );
    const currentSlot = await program.provider.connection.getSlot();
    const curveAge = currentSlot - state.lastOracleUpdateSlot.toNumber();
    const fresh = state.currentModeTtl > 0 && curveAge <= state.currentModeTtl;

    console.log(dim(`  Pool address:  ${address.toBase58()}`));
    console.log(dim(`  Admin:         ${state.admin.toBase58()}`));
    console.log(dim(`  Oracle signer: ${state.authorizedOracleSigner.toBase58()}`));
    console.log(dim(`  Base mint:     ${state.baseMint.toBase58()}`));
    console.log(dim(`  Quote mint:    ${state.quoteMint.toBase58()}`));
    console.log("");
    console.log(dim(`  Fair value:    ${state.fairValue.toString()}`));
    console.log(dim(`  Spread bps:    ${state.spreadBps}`));
    console.log(dim(`  TTL:           ${state.currentModeTtl} slots`));
    console.log(
      `  Freshness:     ${fresh ? green(`fresh (age=${curveAge}/${state.currentModeTtl})`) : red(`stale (age=${curveAge}, TTL=${state.currentModeTtl})`)}`
    );
    console.log(dim(`  Oracle nonce:  ${state.oracleNonce.toString()}`));
    console.log(`  Paused:        ${state.paused ? red("yes") : green("no")}`);
    console.log("");
    console.log(dim(`  Base vault:    ${baseAmount.toString()}`));
    console.log(dim(`  Quote vault:   ${quoteAmount.toString()}`));
  } catch (err) {
    console.error(red(`  Failed to fetch pool: ${(err as Error).message}`));
  }
}
