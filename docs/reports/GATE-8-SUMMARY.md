# GATE 8 — Core feature-complete checkpoint (async, ≤1 page)

**Status: PASSED — continuing per Playbook 0.9.**

## Payments architecture is live (mock-first) and TDD-proven
- **Method matrix** (FR-13): pack ∩ seller subset, dominant-first; SN shows Wave first, BF has no Wave; remembered non-locking default; first-payment guided flag (DC-2/DC-4).
- **Dual-aggregator routing** (FR-14/ADR-0005): per (provider,method) circuit breakers; failover inside one attempt call — golden path 9 part 1 green; both-down keeps the order reserved (NFR-2), DC-3 copy.
- **Webhook-only paid** (DC-8.1): HMAC per-provider signature isolation (cross-provider signature rejected), replay ×5 deduped, tampered → 401 + fraud event.
- **USSD UX** (DC-14): ussd_pending with pack dial code, countdown, resend, timeout sweep, switch-method escape — Tantie Rokia variant green.
- **Late webhooks** (ADR-0007): after expiry → succeeded_late + auto-refund, never resurrect; cancelled-attempt-while-payable exception applies money to the order.
- **MANUAL_TRANSFER** (DC-8.2): admin-gated, unique reference, forged ref → fraud event, seller balance-check gate; golden path 4 green.
- **Ledger** (FR-19/DC-11): double-entry, pack fee/tax splits, refund reversal; invariant Σ=0 after 300 randomized orders incl. refunds; DB-level append-only + non-zero checks.
- **Payouts** (FR-20): PI-SPI-first instant, aggregator fallback, KYC tier limits w/ upgrade path, payout PIN + device cool-down gates, idempotent.
- **Reconciliation** (FR-19b/ADR-0011): CSV ingest → exact/fuzzy matcher (pure, property-tested) → write-once matches, flags with aging, month-end close; golden path 9 part 2 green (failover order settles in fallback's file, zero discrepancy); chaos case (missing paid order → flag) green.
- **Fraud pack** (DC-8): education cards served exactly once (state persisted).

## Numbers
- 129 tests green (47 shared, 12 config, 82 api — DB-backed, serialized); API statement coverage 91.8% (payments 91%, ledger 93%, reconciliation 100%).

## Notes
- Breaker state is per-instance (Redis-shared: BACKLOG for multi-instance prod).
- COD money settles via rider cash ledger in Phase 9.
