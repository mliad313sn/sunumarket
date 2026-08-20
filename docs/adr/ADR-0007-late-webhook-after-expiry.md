# ADR-0007 — Late-webhook-after-expiry policy

**Status:** accepted · **Date:** 2026-08-20 · **Refs:** FR-17, Phase 7 verify

## Context
An attempt expires 30 min after creation; expiry restores reserved stock **exactly once**.
A provider webhook can still arrive after that (network delays, provider retries) — the
buyer's money moved but the order is expired and stock may be resold.

## Decision
- The order is **never silently resurrected**. On a valid late webhook for an expired
  attempt:
  1. Webhook recorded with `outcome=late` (idempotent, never dropped).
  2. Attempt → `succeeded_late`; ledger txn recorded (money really moved — the ledger
     must reflect reality).
  3. **Auto-refund** is queued immediately via the same provider (or PI-SPI reverse).
  4. Buyer + seller notified ("paiement arrivé trop tard — remboursement en cours");
     admin queue entry tracks the refund to completion.
- Exception — same-order retry in flight: if the order is still `payment_pending` on
  another attempt and unpaid, the late confirmation is applied to the order (money
  arrived, order proceeds) and the newer pending attempt is cancelled.

## Consequences
Both branches are TDD-covered in Phase 7. Reconciliation treats `succeeded_late` +
refund as a matched pair.
