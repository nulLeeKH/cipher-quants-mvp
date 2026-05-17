import {
  ERROR_CODE_MESSAGES,
  ERROR_CODE_NAMES,
  errorCodeToMessage,
  errorCodeToName,
  extractErrorCode,
  friendlyError,
} from "./errors.js";

describe("ERROR_CODE_NAMES — mirror of programs/protocol/src/error.rs", () => {
  it("contains every required category boundary", () => {
    // Spot-check one from each category (60xx/61xx/62xx/63xx/64xx/65xx).
    expect(ERROR_CODE_NAMES[6000]).toBe("MathOverflow");
    expect(ERROR_CODE_NAMES[6100]).toBe("InvalidMintPair");
    expect(ERROR_CODE_NAMES[6200]).toBe("UnauthorizedOracle");
    expect(ERROR_CODE_NAMES[6300]).toBe("NoFreshPriceSource");
    expect(ERROR_CODE_NAMES[6400]).toBe("SlippageExceeded");
    expect(ERROR_CODE_NAMES[6500]).toBe("WrongPool");
  });

  it("does not include the removed NotYetImplemented (6599)", () => {
    expect(ERROR_CODE_NAMES[6599]).toBeUndefined();
    expect(ERROR_CODE_MESSAGES[6599]).toBeUndefined();
  });

  it("every NAMES entry has a matching MESSAGES entry", () => {
    for (const code of Object.keys(ERROR_CODE_NAMES)) {
      expect(ERROR_CODE_MESSAGES[Number(code)]).toBeDefined();
    }
  });

  it("every MESSAGES entry has a matching NAMES entry", () => {
    for (const code of Object.keys(ERROR_CODE_MESSAGES)) {
      expect(ERROR_CODE_NAMES[Number(code)]).toBeDefined();
    }
  });
});

describe("errorCodeToName / errorCodeToMessage", () => {
  it("returns names + messages for known codes", () => {
    expect(errorCodeToName(6400)).toBe("SlippageExceeded");
    expect(errorCodeToMessage(6400)).toMatch(/Slippage/);
  });

  it("returns null name + generic message for unknown codes", () => {
    expect(errorCodeToName(9999)).toBeNull();
    expect(errorCodeToMessage(9999)).toMatch(/Unknown protocol error \(9999\)/);
  });
});

describe("extractErrorCode — multiple input shapes", () => {
  it("returns null for non-object inputs", () => {
    expect(extractErrorCode(null)).toBeNull();
    expect(extractErrorCode(undefined)).toBeNull();
    expect(extractErrorCode(42)).toBeNull();
    expect(extractErrorCode("nope")).toBeNull();
  });

  it("extracts AnchorError-shaped errorCode.number", () => {
    const err = { error: { errorCode: { number: 6400 } } };
    expect(extractErrorCode(err)).toBe(6400);
  });

  it("parses 'Error Number: N' from log messages", () => {
    const err = new Error(
      "Transaction failed: Error Number: 6307. Error Message: Quote nonce already consumed.",
    );
    expect(extractErrorCode(err)).toBe(6307);
  });

  it("parses 'custom program error: 0xN' from log messages", () => {
    const err = new Error("custom program error: 0x1900"); // 6400 = 0x1900
    expect(extractErrorCode(err)).toBe(6400);
  });

  it("returns null when neither shape matches", () => {
    const err = new Error("transport closed");
    expect(extractErrorCode(err)).toBeNull();
  });
});

describe("friendlyError", () => {
  it("maps known custom-error codes to the human message", () => {
    const err = new Error("Error Number: 6400");
    expect(friendlyError(err)).toMatch(/Slippage/);
  });

  it("falls back to the raw .message when no code is present", () => {
    expect(friendlyError(new Error("simulation rejected"))).toBe("simulation rejected");
  });

  it("stringifies primitives", () => {
    expect(friendlyError("plain string")).toBe("plain string");
    expect(friendlyError(42)).toBe("42");
  });
});
