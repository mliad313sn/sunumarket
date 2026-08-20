# ADR-0005 — Dual-aggregator routing & circuit breaker

**Status:** accepted · **Date:** 2026-08-20 · **Refs:** FR-14, NFR-2, DC-4, golden path 9

## Decision
- `provider_routes` (from Country Config Pack): per (country, method) a **primary** and
  **fallback** provider. No single point of failure for money-in.
- Circuit breaker keyed by (provider, method), state in Redis (shared across API instances):
  - **closed → open** after 3 consecutive failures/timeouts *or* 5 failures in a rolling
    60 s window (detection ≤ 60 s, NFR-2). Timeout budget per init call: 10 s.
  - **open → half-open** after 30 s cool-down; a single probe attempt is allowed.
  - **half-open → closed** on success; → open on failure (cool-down doubles, cap 5 min).
- While open, new attempts route to the fallback provider **for new attempts only** —
  in-flight attempts finish on the provider that initiated them (webhooks stay valid).
- Every `payment_attempt` records the provider that served it; settlement reconciliation
  depends on this (a failover order settles in the fallback provider's report).
- Health: passive (attempt outcomes) + active probe endpoint per adapter, polled by worker.

## Consequences
- KPI: <5% of paid orders on fallback in steady state — alert otherwise (Goal §10).
- Queued attempts during simultaneous dual outage: attempt stays `initiated`, buyer sees
  retry UX; order hold keeps stock reserved 30 min (FR-17). No order is lost (NFR-2).
