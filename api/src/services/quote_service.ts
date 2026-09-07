import type { Connection, PublicKey } from "@solana/web3.js";
import { PublicKey as SolanaPublicKey } from "@solana/web3.js";

import type { ResolvedApiConfig } from "../runtime.ts";
import { computeFreshness } from "../freshness.ts";
import { nextQuoteNonce } from "../nonce.ts";
import { computeQuotePricing } from "../quote_pricing.ts";
import type { PendingQuote, QuoteStore } from "../quote_store.ts";
import type {
  ApiStatus,
  QuoteRequest,
  QuoteResponse,
} from "../http/contracts.ts";

interface NumberLike {
  toNumber(): number;
}

interface StringLike {
  toString(): string;
}

interface PoolQuoteState {
  paused: boolean;
  lastOracleUpdateSlot: NumberLike;
  currentModeTtl: number;
  fairValue: StringLike;
  spreadBps: number;
}

interface VaultBalances {
  baseAmount: bigint;
  quoteAmount: bigint;
}

interface ProgramLike {
  programId: PublicKey;
}

export interface QuoteServiceDeps {
  config: ResolvedApiConfig;
  connection: Pick<Connection, "getSlot">;
  program: ProgramLike;
  quoteStore: QuoteStore;
  sdk: {
    PRICE_SCALE: bigint;
    directionFromMints(
      inputMint: PublicKey,
      outputMint: PublicKey,
      baseMint: PublicKey,
      quoteMint: PublicKey,
    ): "buy" | "sell";
  };
  sdkAccounts: {
    fetchPoolState(
      program: ProgramLike,
      baseMint: PublicKey,
      quoteMint: PublicKey,
    ): Promise<{ address: PublicKey; state: PoolQuoteState }>;
    fetchVaultBalances(
      program: ProgramLike,
      poolAddr: PublicKey,
      baseMint: PublicKey,
      quoteMint: PublicKey,
    ): Promise<VaultBalances>;
    deriveQuoteNonceMarker(
      poolAddr: PublicKey,
      nonce: bigint,
      programId: PublicKey,
    ): [PublicKey];
  };
}

export type QuoteServiceResult = {
  status: ApiStatus;
  body: unknown;
  metric?: "success" | "inventory";
  recordLatency?: boolean;
  log?: {
    direction: "buy" | "sell";
    price: bigint;
    outAmount: bigint;
    nonce: bigint;
  };
};

export async function createQuote(
  deps: QuoteServiceDeps,
  body: QuoteRequest,
): Promise<QuoteServiceResult> {
  const { config, connection, program, quoteStore, sdk, sdkAccounts } = deps;

  const inputMint = new SolanaPublicKey(body.inputMint);
  const outputMint = new SolanaPublicKey(body.outputMint);
  const userPk = new SolanaPublicKey(body.userPubkey);
  const inAmount = BigInt(body.inAmount);
  if (inAmount <= 0n) {
    return { status: 400, body: { error: "inAmount must be > 0" } };
  }

  const direction = sdk.directionFromMints(
    inputMint,
    outputMint,
    config.baseMint,
    config.quoteMint,
  );

  // Read on-chain pool state (24/7 fresh)
  const { address: poolAddr, state: pool } = await sdkAccounts.fetchPoolState(
    program,
    config.baseMint,
    config.quoteMint,
  );

  if (pool.paused) {
    return { status: 503, body: { error: "Pool is paused" } };
  }

  // OPERATIONS §3.1: when the curve is fresh, the quote is ignored on-chain,
  // so the caller should trade directly via the curve path instead.
  const currentSlot = await connection.getSlot();
  const freshness = computeFreshness({
    lastOracleUpdateSlot: pool.lastOracleUpdateSlot.toNumber(),
    currentModeTtl: pool.currentModeTtl,
    paused: pool.paused,
    currentSlot,
  });
  if (freshness.fresh) {
    return {
      status: 409,
      body: {
        error: "Curve is fresh — use direct execute_swap (curve path) instead",
      },
    };
  }

  const fairValue = BigInt(pool.fairValue.toString());
  const pricing = computeQuotePricing({
    fairValue,
    spreadBps: pool.spreadBps,
    inAmount,
    direction,
    priceScale: sdk.PRICE_SCALE,
  });
  const { price, outAmount } = pricing;

  // Inventory check — pre-rejecting protects the fill-rate SLA and avoids a
  // user paying fees for an on-chain InsufficientReserves failure.
  const balances = await sdkAccounts.fetchVaultBalances(
    program,
    poolAddr,
    config.baseMint,
    config.quoteMint,
  );
  const availableOut = direction === "buy"
    ? balances.baseAmount
    : balances.quoteAmount;
  if (availableOut < outAmount) {
    return {
      status: 503,
      body: {
        error: "Insufficient inventory",
        requested: outAmount.toString(),
        available: availableOut.toString(),
        side: direction === "buy" ? "base" : "quote",
      },
      metric: "inventory",
      recordLatency: true,
    };
  }

  // Reserve nonce + derive marker. MM does NOT sign here — signing is deferred
  // to /swap so the MM retains a last-look reject point.
  const expirySlot = BigInt(currentSlot + config.quoteValidWindowSlots);
  const nonce = nextQuoteNonce();
  const [marker] = sdkAccounts.deriveQuoteNonceMarker(
    poolAddr,
    nonce,
    program.programId,
  );

  const quoteId = nonce.toString();
  const pending: PendingQuote = {
    quoteId,
    poolAddr,
    userPk,
    direction,
    inAmount,
    outAmount,
    price,
    fairValueAtQuote: fairValue,
    expirySlot,
    nonce,
    marker,
  };
  quoteStore.set(pending);

  const response: QuoteResponse = {
    quoteId,
    inputMint: body.inputMint,
    outputMint: body.outputMint,
    inAmount: inAmount.toString(),
    outAmount: outAmount.toString(),
    price: price.toString(),
    fairValueAtQuote: fairValue.toString(),
    expirySlot: Number(expirySlot),
  };

  return {
    status: 200,
    body: response,
    metric: "success",
    recordLatency: true,
    log: { direction, price, outAmount, nonce },
  };
}
