import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function formatTokenAmount(
  rawAmount: bigint | string,
  decimals: number = 6,
  maxFractionDigits: number = 6
): string {
  const big = typeof rawAmount === "bigint" ? rawAmount : BigInt(rawAmount);
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFractionDigits).replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${out}` : out;
}

export function formatPrice(price: bigint, scale: bigint = 1_000_000n, maxDigits = 4): string {
  return formatTokenAmount(price, Number(BigInt(scale).toString().length - 1), maxDigits);
}

export function bpsToPct(bps: number | bigint): string {
  const n = typeof bps === "bigint" ? Number(bps) : bps;
  return `${(n / 100).toFixed(2)}%`;
}

export function isValidPubkeyString(s: string): boolean {
  if (!s || s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

/**
 * Parse decimal user input → raw integer amount (bigint) using mint decimals.
 * Avoids floating-point precision loss by working on the string directly.
 * Returns null when the input is invalid or non-positive.
 */
export function parseDecimalAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Accept "1", "1.", "1.23", ".5". Reject anything else.
  if (!/^\d*\.?\d*$/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "") return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  if (combined === "" || combined === "0") return null;
  try {
    return BigInt(combined);
  } catch {
    return null;
  }
}
