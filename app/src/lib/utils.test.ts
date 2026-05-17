import {
  bpsToPct,
  cn,
  formatPrice,
  formatTokenAmount,
  isValidPubkeyString,
  parseDecimalAmount,
  shortAddr,
} from "./utils";

describe("cn (clsx + tailwind-merge)", () => {
  it("joins truthy classes", () => {
    expect(cn("a", false && "b", "c", undefined)).toBe("a c");
  });
  it("merges conflicting tailwind classes (last wins)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});

describe("shortAddr", () => {
  it("returns the full string when short enough", () => {
    expect(shortAddr("abcd")).toBe("abcd");
  });
  it("ellipsises the middle by default head=4, tail=4", () => {
    expect(shortAddr("abcdefghijkl")).toBe("abcd…ijkl");
  });
  it("respects custom head/tail", () => {
    expect(shortAddr("abcdefghijkl", 2, 2)).toBe("ab…kl");
  });
  it("empty input returns empty", () => {
    expect(shortAddr("")).toBe("");
  });
});

describe("formatTokenAmount", () => {
  it("integer amount", () => {
    expect(formatTokenAmount(1_000_000n, 6)).toBe("1");
  });
  it("decimal amount", () => {
    expect(formatTokenAmount(1_500_000n, 6)).toBe("1.5");
  });
  it("strips trailing zeros in fractional part", () => {
    expect(formatTokenAmount(1_500_000n, 6, 4)).toBe("1.5");
  });
  it("respects maxFractionDigits", () => {
    expect(formatTokenAmount(1_123_456n, 6, 2)).toBe("1.12");
  });
  it("handles negative values with a leading minus", () => {
    expect(formatTokenAmount(-500_000n, 6)).toBe("-0.5");
  });
  it("accepts string input", () => {
    expect(formatTokenAmount("2500000", 6)).toBe("2.5");
  });
});

describe("formatPrice", () => {
  it("formats price using PRICE_SCALE-derived decimals (1e6 → 6dp)", () => {
    expect(formatPrice(100_000_000n)).toBe("100");
    expect(formatPrice(100_500_000n)).toBe("100.5");
  });
});

describe("bpsToPct", () => {
  it("integer bps", () => {
    expect(bpsToPct(150)).toBe("1.50%");
  });
  it("bigint bps", () => {
    expect(bpsToPct(25n)).toBe("0.25%");
  });
});

describe("isValidPubkeyString", () => {
  it("accepts a valid 44-char base58 pubkey", () => {
    expect(isValidPubkeyString("3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy")).toBe(true);
  });
  it("rejects too-short strings", () => {
    expect(isValidPubkeyString("abc")).toBe(false);
  });
  it("rejects strings with invalid base58 characters (0, O, I, l)", () => {
    expect(isValidPubkeyString("0br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy")).toBe(false);
  });
  it("rejects empty string", () => {
    expect(isValidPubkeyString("")).toBe(false);
  });
});

describe("parseDecimalAmount", () => {
  it("integer input", () => {
    expect(parseDecimalAmount("5", 6)).toBe(5_000_000n);
  });
  it("fractional input", () => {
    expect(parseDecimalAmount("1.5", 6)).toBe(1_500_000n);
  });
  it("trailing fraction beyond decimals truncates", () => {
    expect(parseDecimalAmount("1.1234567", 6)).toBe(1_123_456n);
  });
  it("leading dot", () => {
    expect(parseDecimalAmount(".5", 6)).toBe(500_000n);
  });
  it("trailing dot", () => {
    expect(parseDecimalAmount("5.", 6)).toBe(5_000_000n);
  });
  it("rejects empty string", () => {
    expect(parseDecimalAmount("", 6)).toBeNull();
  });
  it("rejects just a dot", () => {
    expect(parseDecimalAmount(".", 6)).toBeNull();
  });
  it("rejects non-numeric characters", () => {
    expect(parseDecimalAmount("1a", 6)).toBeNull();
    expect(parseDecimalAmount("-5", 6)).toBeNull();
  });
  it("zero returns null (positive-only)", () => {
    expect(parseDecimalAmount("0", 6)).toBeNull();
    expect(parseDecimalAmount("0.0", 6)).toBeNull();
  });
  it("strips leading zeros", () => {
    expect(parseDecimalAmount("007.5", 6)).toBe(7_500_000n);
  });
  it("trims whitespace", () => {
    expect(parseDecimalAmount("  10  ", 6)).toBe(10_000_000n);
  });
});
