import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { createRequire } from "node:module";
import { BN } from "../anchor.ts";

import { bold, cyan, dim, green, red } from "@std/fmt/colors";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { KeeperConfig } from "../config.ts";
import type { KeeperProgram } from "../program.ts";
import { JsonFileKeypairProvider } from "../wallet.ts";

const require = createRequire(import.meta.url);
const sdkAccounts = require("../../../sdk/dist/accounts/index.js") as {
  derivePoolState: any;
  deriveVault: any;
  sortMints: any;
};
const sdkConstants = require("../../../sdk/dist/constants/index.js") as {
  MODE_C_TTL: number;
};

// ============================================================================
// init-pool subcommand
// ============================================================================
// One-shot admin op: call init_pool.
// Startup checks:
//   - BASE_MINT/QUOTE_MINT env vars are required.
//   - Admin wallet keypair must exist.
//   - Mints must be sorted (base < quote) — SDK's sortMints handles swapping.

export async function runInitPool(
  config: KeeperConfig,
  program: KeeperProgram
): Promise<void> {
  if (!config.baseMint || !config.quoteMint) {
    console.error(red("BASE_MINT and QUOTE_MINT env vars are required"));
    Deno.exit(1);
  }

  // Sort mints.
  const [baseMint, quoteMint] = sdkAccounts.sortMints(
    config.baseMint,
    config.quoteMint
  );
  if (!baseMint.equals(config.baseMint)) {
    console.log(
      dim(
        `  Mints reordered: base/quote in env was swapped, using ${baseMint.toBase58()}/${quoteMint.toBase58()}`
      )
    );
  }

  const adminProvider = new JsonFileKeypairProvider(config.adminWalletPath);
  const oracleProvider = new JsonFileKeypairProvider(config.oracleWalletPath);
  const admin = await adminProvider.getKeypair();
  const oracleSigner = await oracleProvider.getKeypair();

  const [poolState] = sdkAccounts.derivePoolState(
    baseMint,
    quoteMint,
    program.programId
  );
  const [baseVault] = sdkAccounts.deriveVault(poolState, baseMint, program.programId);
  const [quoteVault] = sdkAccounts.deriveVault(poolState, quoteMint, program.programId);

  console.log(bold(cyan("init-pool")));
  console.log(dim(`  Admin:        ${admin.publicKey.toBase58()}`));
  console.log(dim(`  Oracle signer: ${oracleSigner.publicKey.toBase58()}`));
  console.log(dim(`  Base mint:    ${baseMint.toBase58()}`));
  console.log(dim(`  Quote mint:   ${quoteMint.toBase58()}`));
  console.log(dim(`  Pool PDA:     ${poolState.toBase58()}`));

  try {
    const sig = await program.program.methods
      .initPool(
        oracleSigner.publicKey,
        new BN(100_000_000), // initial_fair_value = $100 (PoC default — the worker overwrites via update_oracle)
        20,                  // spread 20 bps
        {
          depthCoefBps: 2,
          sizeUnit: new BN(1_000_000),
          maxDepthBps: 100,
          reserved: Array(6).fill(0),
        },
        {
          targetBaseBps: 5_000,
          skewCoefBps: 50,
          maxSkewOffsetBps: 100,
          reserved: Array(10).fill(0),
        },
        sdkConstants.MODE_C_TTL // Start in Mode C — admin deposits vault, then the worker starts
      )
      .accountsPartial({
        admin: admin.publicKey,
        poolState,
        baseMint,
        quoteMint,
        baseVault,
        quoteVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    console.log(green(`  ✓ Pool initialized. Tx: ${sig}`));
    console.log(dim(`  Next steps:`));
    console.log(dim(`    1. Deposit base/quote tokens into vaults (SPL Token transfer to ${baseVault.toBase58()} / ${quoteVault.toBase58()})`));
    console.log(dim(`    2. Start oracle worker: keeper oracle`));
    console.log(dim(`    3. Start RFQ webhook: keeper webhook`));
    console.log(dim(`    Or combined: keeper start`));
  } catch (err) {
    console.error(red(`  ✗ init_pool failed: ${(err as Error).message}`));
    Deno.exit(1);
  }
}
