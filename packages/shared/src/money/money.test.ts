import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  add,
  allocate,
  compare,
  CurrencyMismatchError,
  equals,
  format,
  fromWire,
  isNegative,
  isZero,
  money,
  multiply,
  negate,
  percentBps,
  subtract,
  sum,
  toWire,
  zero
} from "./money.js";

const arbAmount = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
const arbMoneyXof = arbAmount.map((n) => money(n, "XOF"));

describe("money — construction & wire format", () => {
  it("constructs from bigint and string", () => {
    expect(money(1500n, "XOF").amountMinor).toBe(1500n);
    expect(money("1500", "XOF").amountMinor).toBe(1500n);
  });

  it("is frozen (immutable value object)", () => {
    const m = money(10n, "XOF");
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("round-trips via wire format", () => {
    fc.assert(
      fc.property(arbMoneyXof, (m) => {
        expect(equals(fromWire(toWire(m)), m)).toBe(true);
      })
    );
  });

  it("rejects non-integer wire amounts", () => {
    expect(() => fromWire({ amount_minor: "12.5", currency: "XOF" })).toThrow();
    expect(() => fromWire({ amount_minor: "abc", currency: "XOF" })).toThrow();
  });
});

describe("money — arithmetic", () => {
  it("adds and subtracts exactly (property: a+b-b === a)", () => {
    fc.assert(
      fc.property(arbMoneyXof, arbMoneyXof, (a, b) => {
        expect(equals(subtract(add(a, b), b), a)).toBe(true);
      })
    );
  });

  it("addition is commutative and associative", () => {
    fc.assert(
      fc.property(arbMoneyXof, arbMoneyXof, arbMoneyXof, (a, b, c) => {
        expect(equals(add(a, b), add(b, a))).toBe(true);
        expect(equals(add(add(a, b), c), add(a, add(b, c)))).toBe(true);
      })
    );
  });

  it("throws on cross-currency arithmetic", () => {
    expect(() => add(money(1n, "XOF"), money(1n, "NGN"))).toThrow(CurrencyMismatchError);
    expect(() => compare(money(1n, "XOF"), money(1n, "GHS"))).toThrow(CurrencyMismatchError);
  });

  it("multiply matches repeated addition", () => {
    const m = money(325n, "XOF");
    expect(equals(multiply(m, 4n), sum("XOF", [m, m, m, m]))).toBe(true);
  });

  it("negate/isNegative/isZero/compare behave", () => {
    expect(isNegative(negate(money(5n, "XOF")))).toBe(true);
    expect(isZero(zero("XOF"))).toBe(true);
    expect(compare(money(2n, "XOF"), money(3n, "XOF"))).toBe(-1);
    expect(compare(money(3n, "XOF"), money(3n, "XOF"))).toBe(0);
  });
});

describe("money — allocate (fee/tax splits, DC-11)", () => {
  it("never loses or invents a minor unit (property)", () => {
    fc.assert(
      fc.property(
        arbMoneyXof,
        fc.array(fc.bigInt({ min: 0n, max: 1000n }), { minLength: 1, maxLength: 8 }),
        (m, ratios) => {
          fc.pre(ratios.some((r) => r > 0n));
          const parts = allocate(m, ratios);
          expect(equals(sum("XOF", parts), m)).toBe(true);
          expect(parts).toHaveLength(ratios.length);
        }
      )
    );
  });

  it("splits proportionally with deterministic remainder to earliest ratios", () => {
    const parts = allocate(money(100n, "XOF"), [1n, 1n, 1n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([34n, 33n, 33n]);
  });

  it("handles negative amounts symmetrically", () => {
    const parts = allocate(money(-100n, "XOF"), [1n, 1n, 1n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([-34n, -33n, -33n]);
    expect(equals(sum("XOF", parts), money(-100n, "XOF"))).toBe(true);
  });

  it("rejects empty, negative, and zero-total ratios", () => {
    expect(() => allocate(money(10n, "XOF"), [])).toThrow();
    expect(() => allocate(money(10n, "XOF"), [-1n, 2n])).toThrow();
    expect(() => allocate(money(10n, "XOF"), [0n, 0n])).toThrow();
  });
});

describe("money — percentBps (provider fees, taxes)", () => {
  it("computes basis points with half-up rounding", () => {
    expect(percentBps(money(10000n, "XOF"), 150n).amountMinor).toBe(150n); // 1.5%
    expect(percentBps(money(333n, "XOF"), 100n).amountMinor).toBe(3n); // 3.33 → 3
    expect(percentBps(money(350n, "XOF"), 100n).amountMinor).toBe(4n); // 3.5 → 4 (half-up)
  });

  it("is symmetric for negative amounts", () => {
    fc.assert(
      fc.property(arbMoneyXof, fc.bigInt({ min: 0n, max: 10000n }), (m, bps) => {
        expect(percentBps(negate(m), bps).amountMinor).toBe(-percentBps(m, bps).amountMinor);
      })
    );
  });

  it("fee never exceeds amount for bps <= 10000", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10000n }),
        (n, bps) => {
          const fee = percentBps(money(n, "XOF"), bps);
          expect(fee.amountMinor <= n).toBe(true);
        }
      )
    );
  });
});

describe("money — formatting (XOF no-decimals rule)", () => {
  it("formats FCFA with space grouping", () => {
    expect(format(money(0n, "XOF"))).toBe("0 FCFA");
    expect(format(money(12500n, "XOF"))).toBe("12 500 FCFA");
    expect(format(money(4500000n, "XOF"))).toBe("4 500 000 FCFA");
    expect(format(money(-2500n, "XOF"))).toBe("-2 500 FCFA");
  });

  it("formats 2-exponent currencies with decimals", () => {
    expect(format(money(123456n, "GHS"))).toBe("1 234.56 GHS");
    expect(format(money(5n, "NGN"))).toBe("0.05 NGN");
  });
});
