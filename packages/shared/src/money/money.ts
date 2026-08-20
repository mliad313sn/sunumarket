import { z } from "zod";

/**
 * Money — DC-5: integer minor units + ISO 4217 code from day 1.
 * XOF is live at launch (0 decimal places: 1 minor unit = 1 FCFA).
 * Schema-ready currencies for expansion waves carry their own exponent.
 * No floating point may ever touch an amount (lint-enforced).
 */
export const CURRENCY_EXPONENTS = {
  XOF: 0,
  GHS: 2,
  NGN: 2,
  KES: 2
} as const;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

export const currencyCodeSchema = z.enum(["XOF", "GHS", "NGN", "KES"]);

/** Wire format: amount_minor as decimal string (JSON has no bigint). */
export const moneySchema = z.object({
  amount_minor: z.string().regex(/^-?\d+$/, "amount_minor must be a decimal integer string"),
  currency: currencyCodeSchema
});
export type MoneyWire = z.infer<typeof moneySchema>;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

export function money(amountMinor: bigint | string, currency: CurrencyCode): Money {
  const amt = typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor);
  return Object.freeze({ amountMinor: amt, currency });
}

export function zero(currency: CurrencyCode): Money {
  return money(0n, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

/** Multiply by an integer quantity (e.g. line item qty). */
export function multiply(a: Money, qty: bigint): Money {
  return money(a.amountMinor * qty, a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0n;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function sum(currency: CurrencyCode, items: readonly Money[]): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

/**
 * Percentage fee in basis points, rounding half-up on the minor unit.
 * Used for provider fees / tax pass-through (DC-11). Never loses or invents units:
 * feeBps(gross) + remainder(gross) reconstruct gross via allocate() where needed.
 */
export function percentBps(a: Money, bps: bigint): Money {
  const numerator = a.amountMinor * bps;
  const div = numerator / 10000n;
  const rem = numerator % 10000n;
  const half = rem * 2n;
  const rounded =
    numerator >= 0n ? (half >= 10000n ? div + 1n : div) : (half <= -10000n ? div - 1n : div);
  return money(rounded, a.currency);
}

/**
 * Split an amount into n parts by integer ratios without losing a single minor unit.
 * Remainder units are distributed to the earliest parts (deterministic).
 * Invariant: sum(parts) === a. Throws on empty or non-positive total ratio.
 */
export function allocate(a: Money, ratios: readonly bigint[]): Money[] {
  if (ratios.length === 0) throw new Error("allocate: ratios must be non-empty");
  const total = ratios.reduce((s, r) => {
    if (r < 0n) throw new Error("allocate: ratios must be non-negative");
    return s + r;
  }, 0n);
  if (total <= 0n) throw new Error("allocate: total ratio must be positive");

  const negative = a.amountMinor < 0n;
  const abs = negative ? -a.amountMinor : a.amountMinor;
  const parts: bigint[] = ratios.map((r) => (abs * r) / total);
  let remainder = abs - parts.reduce((s, p) => s + p, 0n);
  for (let i = 0; remainder > 0n; i = (i + 1) % parts.length) {
    if (ratios[i]! > 0n) {
      parts[i] = parts[i]! + 1n;
      remainder -= 1n;
    }
  }
  return parts.map((p) => money(negative ? -p : p, a.currency));
}

export function toWire(a: Money): MoneyWire {
  return { amount_minor: a.amountMinor.toString(), currency: a.currency };
}

export function fromWire(w: MoneyWire): Money {
  const parsed = moneySchema.parse(w);
  return money(BigInt(parsed.amount_minor), parsed.currency);
}

/**
 * Display formatting. XOF: "12 500 FCFA" (fr grouping with narrow spaces replaced
 * by regular spaces for low-end font compatibility). Other currencies: symbol-less
 * "1 234.56 GHS" style derived from the exponent.
 */
export function format(a: Money, _locale: "fr" | "en" = "fr"): string {
  const exp = CURRENCY_EXPONENTS[a.currency];
  const negative = a.amountMinor < 0n;
  const abs = negative ? -a.amountMinor : a.amountMinor;
  const s = abs.toString().padStart(exp + 1, "0");
  const intPart = exp === 0 ? s : s.slice(0, -exp);
  const fracPart = exp === 0 ? "" : s.slice(-exp);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const label = a.currency === "XOF" ? "FCFA" : a.currency;
  const num = fracPart ? `${grouped}.${fracPart}` : grouped;
  return `${negative ? "-" : ""}${num} ${label}`;
}
