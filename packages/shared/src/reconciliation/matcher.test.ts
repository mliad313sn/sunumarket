import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { InternalPayment, SettlementLineIn } from "./matcher.js";
import { matchSettlement } from "./matcher.js";

const pay = (id: string, ref: string, amt: bigint, date = "2026-08-20"): InternalPayment => ({
  transactionId: id,
  providerRef: ref,
  amountMinor: amt,
  currency: "XOF",
  paidDate: date
});
const line = (id: string, ref: string, amt: bigint, date = "2026-08-21"): SettlementLineIn => ({
  lineId: id,
  providerRef: ref,
  amountMinor: amt,
  currency: "XOF",
  settlementDate: date
});

describe("reconciliation matcher (ADR-0011)", () => {
  it("exact ref+amount matches; clean file has zero flags (golden path 9 part 2)", () => {
    const payments = [pay("t1", "AGG_A-001", 15000n), pay("t2", "AGG_A-002", 8000n)];
    const lines = [line("l1", "AGG_A-001", 15000n), line("l2", "AGG_A-002", 8000n)];
    const r = matchSettlement(lines, payments);
    expect(r.matches).toHaveLength(2);
    expect(r.matches.every((m) => m.kind === "exact")).toBe(true);
    expect(r.flags).toHaveLength(0);
  });

  it("fuzzy: normalized ref (case/space/dash) + amount + ±1 day", () => {
    const payments = [pay("t1", "AGG_A-0 01", 15000n, "2026-08-20")];
    const lines = [line("l1", "agga001", 15000n, "2026-08-21")];
    const r = matchSettlement(lines, payments);
    expect(r.matches[0]).toEqual({ lineId: "l1", transactionId: "t1", kind: "fuzzy" });
    expect(r.flags).toHaveLength(0);
  });

  it("fuzzy refuses when date drifts beyond ±1 day or amount differs", () => {
    const payments = [pay("t1", "REF 1", 15000n, "2026-08-20")];
    expect(matchSettlement([line("l1", "ref1", 15000n, "2026-08-23")], payments).matches).toHaveLength(0);
    expect(matchSettlement([line("l1", "ref1", 14999n, "2026-08-21")], payments).matches).toHaveLength(0);
  });

  it("amount mismatch on exact ref raises amount_mismatch (not unmatched)", () => {
    const r = matchSettlement([line("l1", "R1", 9999n)], [pay("t1", "R1", 15000n)]);
    expect(r.matches).toHaveLength(0);
    expect(r.flags).toEqual([
      { kind: "amount_mismatch", lineId: "l1", transactionId: "t1", expected: 15000n, got: 9999n }
    ]);
  });

  it("unknown line → unmatched_line; paid order absent from file → missing_order (chaos case)", () => {
    const r = matchSettlement([line("l1", "GHOST", 1000n)], [pay("t1", "R1", 15000n)]);
    expect(r.flags).toContainEqual({ kind: "unmatched_line", lineId: "l1" });
    expect(r.flags).toContainEqual({ kind: "missing_order", transactionId: "t1" });
  });

  it("double-settled line: second line for the same payment flags unmatched", () => {
    const r = matchSettlement(
      [line("l1", "R1", 15000n), line("l2", "R1", 15000n)],
      [pay("t1", "R1", 15000n)]
    );
    expect(r.matches).toHaveLength(1);
    expect(r.flags).toContainEqual({ kind: "unmatched_line", lineId: "l2" });
  });

  it("property: every payment is either matched once or flagged missing; every line matched or flagged", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ref: fc.hexaString({ minLength: 4, maxLength: 8 }),
            amt: fc.bigInt({ min: 1n, max: 10n ** 9n }),
            settled: fc.boolean(),
            corrupt: fc.boolean()
          }),
          { maxLength: 25 }
        ),
        (rows) => {
          const seen = new Set<string>();
          const unique = rows.filter((r) => !seen.has(r.ref) && (seen.add(r.ref), true));
          const payments = unique.map((r, i) => pay(`t${i}`, r.ref, r.amt));
          const lines = unique
            .filter((r) => r.settled)
            .map((r, i) => line(`l${i}`, r.ref, r.corrupt ? r.amt + 1n : r.amt));
          const { matches, flags } = matchSettlement(lines, payments);

          const matchedTxns = new Set(matches.map((m) => m.transactionId));
          expect(matchedTxns.size).toBe(matches.length); // no double match
          for (const p of payments) {
            const accounted =
              matchedTxns.has(p.transactionId) ||
              flags.some(
                (f) =>
                  (f.kind === "missing_order" && f.transactionId === p.transactionId) ||
                  (f.kind === "amount_mismatch" && f.transactionId === p.transactionId)
              );
            expect(accounted).toBe(true);
          }
          const matchedLines = new Set(matches.map((m) => m.lineId));
          for (const l of lines) {
            const accounted =
              matchedLines.has(l.lineId) ||
              flags.some((f) => (f.kind === "unmatched_line" || f.kind === "amount_mismatch") && f.lineId === l.lineId);
            expect(accounted).toBe(true);
          }
        }
      )
    );
  });
});
