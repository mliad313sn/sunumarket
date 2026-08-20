# ADR-0012 — Idempotency & webhook signature isolation

**Status:** accepted · **Date:** 2026-08-20 · **Refs:** FR-14, NFR-3, Phase 6/7

## Decision
- **Client idempotency:** order creation and attempt creation take an
  `Idempotency-Key`; replays return the original result (unique index, no double order,
  no double stock decrement).
- **Webhook idempotency:** dedupe on (provider, event_id); replay → `outcome=duplicate`,
  no state change; out-of-order events resolved by state-machine guards (a `paid` order
  ignores a later `failed` event for an older attempt).
- **Signature isolation (NFR-3):** each provider has its own verification secret and
  verifier implementation inside its adapter; a valid AggregatorA signature can never
  authorize an AggregatorB (or partner) webhook. Secrets via env only; tampered
  signature → 401 + alert + `fraud_event`.
- Offline sync (rider statuses, order+pin queue) reuses the same idempotency machinery:
  client-generated event UUIDs, server dedupe, order-independent application.
