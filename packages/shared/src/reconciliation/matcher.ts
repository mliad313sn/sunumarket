/**
 * Settlement reconciliation matcher — FR-19b / ADR-0011.
 * Pure function over (settlement lines, internal payment view) → matches + flags.
 * One of the five TDD-critical machines (Playbook 0.4).
 */

export interface SettlementLineIn {
  lineId: string;
  providerRef: string;
  amountMinor: bigint;
  currency: string;
  settlementDate: string; // YYYY-MM-DD
}

export interface InternalPayment {
  transactionId: string;
  providerRef: string;
  amountMinor: bigint;
  currency: string;
  paidDate: string; // YYYY-MM-DD
}

export type MatchKind = "exact" | "fuzzy";

export interface MatchResult {
  lineId: string;
  transactionId: string;
  kind: MatchKind;
}

export type ReconFlag =
  | { kind: "unmatched_line"; lineId: string }
  | { kind: "amount_mismatch"; lineId: string; transactionId: string; expected: bigint; got: bigint }
  | { kind: "missing_order"; transactionId: string };

function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase().replace(/[\s\-_]/g, "");
}

function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/**
 * Matching per line, first hit wins:
 *  1. exact: providerRef equal AND amount equal
 *  2. amount_mismatch flag: providerRef equal but amount differs
 *  3. fuzzy: normalized-ref equal AND amount equal AND settlement date within ±1 day
 *  4. unmatched_line flag
 * Cross-check: every internal payment must appear in the file set → missing_order flag.
 * Each internal payment matches at most one line (double-settlement lines flag unmatched).
 */
export function matchSettlement(
  lines: readonly SettlementLineIn[],
  payments: readonly InternalPayment[]
): { matches: MatchResult[]; flags: ReconFlag[] } {
  const matches: MatchResult[] = [];
  const flags: ReconFlag[] = [];
  const byExactRef = new Map<string, InternalPayment>();
  const byNormRef = new Map<string, InternalPayment>();
  for (const p of payments) {
    byExactRef.set(p.providerRef, p);
    byNormRef.set(normalizeRef(p.providerRef), p);
  }
  const consumed = new Set<string>();

  for (const line of lines) {
    const exact = byExactRef.get(line.providerRef);
    if (exact && !consumed.has(exact.transactionId)) {
      if (exact.amountMinor === line.amountMinor && exact.currency === line.currency) {
        matches.push({ lineId: line.lineId, transactionId: exact.transactionId, kind: "exact" });
        consumed.add(exact.transactionId);
        continue;
      }
      flags.push({
        kind: "amount_mismatch",
        lineId: line.lineId,
        transactionId: exact.transactionId,
        expected: exact.amountMinor,
        got: line.amountMinor
      });
      consumed.add(exact.transactionId); // the payment is accounted for — by a disputed line
      continue;
    }

    const fuzzy = byNormRef.get(normalizeRef(line.providerRef));
    if (
      fuzzy &&
      !consumed.has(fuzzy.transactionId) &&
      fuzzy.amountMinor === line.amountMinor &&
      fuzzy.currency === line.currency &&
      dayDiff(fuzzy.paidDate, line.settlementDate) <= 1
    ) {
      matches.push({ lineId: line.lineId, transactionId: fuzzy.transactionId, kind: "fuzzy" });
      consumed.add(fuzzy.transactionId);
      continue;
    }

    flags.push({ kind: "unmatched_line", lineId: line.lineId });
  }

  for (const p of payments) {
    if (!consumed.has(p.transactionId)) {
      flags.push({ kind: "missing_order", transactionId: p.transactionId });
    }
  }

  return { matches, flags };
}
