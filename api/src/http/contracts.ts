// ============================================================================
// HTTP request/response contracts
// ============================================================================
// External endpoint DTOs live in the HTTP layer. Domain/pure-helper input and
// output types stay with their owning modules.

export type ApiStatus = 200 | 400 | 403 | 404 | 409 | 410 | 500 | 503;

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  userPubkey: string;
}

export interface QuoteResponse {
  quoteId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Quoted price in PRICE_SCALE units (raw_quote_per_raw_base × 1e6). */
  price: string;
  /** Pool's fair_value at quote time. Last-look at /swap compares against the
   *  current fair_value and rejects if drift exceeds MM_MAX_DRIFT_BPS. */
  fairValueAtQuote: string;
  expirySlot: number;
}

export interface SwapRequest {
  quoteId: string;
  userPubkey: string;
}

export interface SwapResponse {
  quoteId: string;
  /** Base64-encoded unsigned VersionedTransaction. */
  tx: string;
  lastValidBlockHeight: number;
  /** Same data, broken out for callers that want to assemble their own
   *  transaction shell (FE swap UI, raw integrations). */
  components: {
    signedQuote: {
      pool: string;
      user: string;
      direction: number;
      inputAmount: string;
      price: string;
      expirySlot: string;
      nonce: string;
      signature: string;
    };
    verifyIxBase64: string;
    quoteNonceMarker: string;
  };
}
