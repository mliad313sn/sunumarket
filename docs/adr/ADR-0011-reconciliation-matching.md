# ADR-0011 — Settlement reconciliation matching rules

**Status:** accepted · **Date:** 2026-08-20 · **Refs:** FR-19b, golden path 9, Phase 8

## Decision
Matching runs per settlement line, in order; first hit wins:

1. **Exact:** `settlement_line.provider_ref === payment_attempt.provider_ref` and amounts
   equal → `match_kind=exact`.
2. **Fuzzy:** same amount + settlement date within ±1 day + normalized reference
   similarity (case/whitespace/prefix-insensitive equality) → `match_kind=fuzzy`
   (flagged for spot-audit sampling, not for admin action).
3. **Amount mismatch:** ref matches but amount differs → flag `amount_mismatch` (open).
4. **No match:** flag `unmatched_line` (open).

Cross-check after file pass: every `paid` order for that provider/date **must** appear in
the file — absent orders raise `missing_order` (this is the chaos-test case: a settlement
file silently missing a paid order must flag, never pass).

- Flags carry `opened_at` → aging buckets (24 h / 72 h / 7 d) in the admin queue; KPI:
  discrepancies < 0.5% of volume, cleared < 72 h (Goal §10).
- Matcher is one of the five TDD-critical machines (Playbook 0.4): pure function over
  (lines, attempts/ledger view) → (matches, flags).
- Month-end close: report totals per provider — gross, fees, net, matched %, open flags.
