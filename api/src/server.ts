// ============================================================================
// RFQ webhook server (JupiterZ-compatible)
// ============================================================================
// docs/OPERATIONS.md §5 — /quote /swap /tokens.
//
// Responsibilities:
//   - Runs 24/7 (especially responsible for RFQ responses during Mode C).
//   - Reads on-chain `pool_state` (fair_value, spread, depth, skew, paused, ttl).
//   - Returns ed25519-signed quotes for user quote requests.
//   - Handles requests from the frontend and the Jupiter router.
//
// Separation from the keeper:
//   - Keeper = oracle push (write to chain)
//   - API server = quote response (read chain + sign)
//   - Both currently hold the oracle hot key (future split: dedicated quote_signer).

import { Buffer } from "node:buffer";
import { Hono } from "@hono/hono";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
import { bold, cyan, dim, red } from "@std/fmt/colors";

import type { ApiConfig } from "./config.ts";

// Load Anchor + SDK via CommonJS require to bypass Deno's strict ESM resolution.
const require = createRequire(import.meta.url);
// deno-lint-ignore no-explicit-any
const anchor: any = require("@coral-xyz/anchor");
const { AnchorProvider, Wallet } = anchor;
// deno-lint-ignore no-explicit-any
const sdk: any = require("../../sdk/dist/index.js");
// deno-lint-ignore no-explicit-any
const sdkAccounts: any = require("../../sdk/dist/accounts/index.js");

// ============================================================================
// Request / Response schemas (JupiterZ-compatible simple v0)
// ============================================================================
// Align with the full JupiterZ spec at Stage 2 entry; verify via the
// jup-ag/rfq-webhook-toolkit integration tests at that point.

interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  userPubkey: string;
}

interface QuoteResponse {
  quoteId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  expirySlot: number;
  signedQuote: any;
  verifyIxBase64: string;
  quoteNonceMarker: string;
}

interface SwapRequest {
  quoteId: string;
  userPubkey: string;
}

// ============================================================================

export interface ApiServerHandle {
  stop(): Promise<void>;
}

export async function startApiServer(
  config: ApiConfig
): Promise<ApiServerHandle> {
  if (!config.baseMint || !config.quoteMint) {
    console.error(red("BASE_MINT and QUOTE_MINT env vars required"));
    Deno.exit(1);
  }

  // Load quote signer keypair
  const text = await Deno.readTextFile(config.quoteSignerWalletPath);
  const secretArr = JSON.parse(text);
  const quoteSigner = Keypair.fromSecretKey(Uint8Array.from(secretArr));
  console.log(
    dim(`  Quote signer:  ${quoteSigner.publicKey.toBase58()} (loaded)`)
  );

  // Anchor provider + SDK program
  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: config.rpcWsUrl,
  });
  const wallet = new Wallet(quoteSigner);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = sdk.createProgram(provider);
  const programId = config.programIdOverride ?? sdk.PROGRAM_ID;

  console.log(dim(`  Program:       ${programId.toBase58()}`));
  console.log(dim(`  Base mint:     ${config.baseMint.toBase58()}`));
  console.log(dim(`  Quote mint:    ${config.quoteMint.toBase58()}`));

  // ──────────────────────────────────────────────────────────────────────
  // Quote cache (in-memory). Replace with Redis or a dedicated store at Stage 2.
  const quoteCache = new Map<string, QuoteResponse>();

  const app = new Hono();

  app.get("/health", (c) => c.text("ok"));

  app.get("/tokens", (c) =>
    c.json({
      tokens: [
        { mint: config.baseMint!.toBase58(), name: "base", decimals: 6 },
        { mint: config.quoteMint!.toBase58(), name: "quote", decimals: 6 },
      ],
    })
  );

  app.post("/quote", async (c) => {
    let body: QuoteRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const inputMint = new PublicKey(body.inputMint);
      const outputMint = new PublicKey(body.outputMint);
      const userPk = new PublicKey(body.userPubkey);
      const inAmount = BigInt(body.inAmount);
      if (inAmount <= 0n) return c.json({ error: "inAmount must be > 0" }, 400);

      const direction = sdk.directionFromMints(
        inputMint,
        outputMint,
        config.baseMint!,
        config.quoteMint!
      ) as "buy" | "sell";

      // Read on-chain pool state (24/7 fresh)
      const { address: poolAddr, state: pool } = await sdkAccounts.fetchPoolState(
        program,
        config.baseMint!,
        config.quoteMint!
      );

      if (pool.paused) {
        return c.json({ error: "Pool is paused" }, 503);
      }

      // OPERATIONS §3.1: when the curve is fresh, the quote is ignored on-chain,
      // so it's more efficient for the API server to *reject* during that window
      // (the user trades directly via the curve path instead).
      const currentSlot = await connection.getSlot();
      const curveAge = currentSlot - pool.lastOracleUpdateSlot.toNumber();
      const curveFresh = pool.currentModeTtl > 0 && curveAge <= pool.currentModeTtl;
      if (curveFresh) {
        return c.json(
          {
            error:
              "Curve is fresh — use direct execute_swap (curve path) instead",
          },
          404
        );
      }

      // Quote price = fair_value × spread (simple v0; depth/skew come in v1).
      const fairValue = BigInt(pool.fairValue.toString());
      const halfBps = BigInt(Math.floor(pool.spreadBps / 2));
      const price =
        direction === "buy"
          ? (fairValue * (10_000n + halfBps)) / 10_000n
          : (fairValue * (10_000n - halfBps)) / 10_000n;
      const PRICE_SCALE = sdk.PRICE_SCALE as bigint;
      const outAmount =
        direction === "buy"
          ? (inAmount * PRICE_SCALE) / price
          : (inAmount * price) / PRICE_SCALE;

      // Build signed quote
      const expirySlot = BigInt(currentSlot + config.quoteValidWindowSlots);
      const nonce =
        BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const built = sdk.buildSignedQuoteWithVerifyIx(quoteSigner, {
        pool: poolAddr,
        user: userPk,
        direction,
        inputAmount: inAmount,
        price,
        expirySlot,
        nonce,
      });

      const [marker] = sdkAccounts.deriveQuoteNonceMarker(
        poolAddr,
        nonce,
        program.programId
      );

      const quoteId = nonce.toString();
      const resp: QuoteResponse = {
        quoteId,
        inputMint: body.inputMint,
        outputMint: body.outputMint,
        inAmount: inAmount.toString(),
        outAmount: outAmount.toString(),
        expirySlot: Number(expirySlot),
        signedQuote: {
          pool: built.signedQuote.pool.toBase58(),
          user: built.signedQuote.user.toBase58(),
          direction: built.signedQuote.direction,
          inputAmount: built.signedQuote.inputAmount.toString(),
          price: built.signedQuote.price.toString(),
          expirySlot: built.signedQuote.expirySlot.toString(),
          nonce: built.signedQuote.nonce.toString(),
          signature: built.signedQuote.signature,
        },
        verifyIxBase64: Buffer.from(built.verifyIx.data).toString("base64"),
        quoteNonceMarker: marker.toBase58(),
      };
      quoteCache.set(quoteId, resp);

      if (config.verbose) {
        console.log(
          dim(
            `  [/quote] dir=${direction} price=${price} out=${outAmount} nonce=${nonce}`
          )
        );
      }
      return c.json(resp);
    } catch (err) {
      console.error(red(`  [/quote] ${(err as Error).message}`));
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/swap", async (c) => {
    let body: SwapRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const cached = quoteCache.get(body.quoteId);
    if (!cached) return c.json({ error: "Unknown or expired quoteId" }, 404);

    return c.json({
      quoteId: cached.quoteId,
      signedQuote: cached.signedQuote,
      verifyIxBase64: cached.verifyIxBase64,
      quoteNonceMarker: cached.quoteNonceMarker,
      message:
        "Client must build tx: [verifyIx, executeSwap(signedQuote, marker)]",
    });
  });

  const server = Deno.serve({ port: config.port }, app.fetch);
  console.log(
    bold(cyan(`  RFQ webhook listening on http://0.0.0.0:${config.port}`))
  );

  return {
    async stop() {
      await server.shutdown();
    },
  };
}
