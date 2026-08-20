# GATE 2 — Architecture checkpoint (async, ≤1 page)

**Status: PASSED — continuing per Playbook 0.9 (async checkpoint, continue unless instructed).**

## What Phase 1 delivered
- **C4** context + containers + payment routing layer + reconciliation worker (`docs/ARCHITECTURE.md`).
- **ERD** covering v2 set + v3 payment/fraud/KYC tables: `payment_providers`, `provider_routes`, `settlement_batches/lines`, `reconciliation_flags`, `kyc_records`, `device_bindings`, `fraud_events`, `country_packs`, append-only ledgers (`docs/ERD.md`). All 10 golden paths walked against it.
- **8 sequence diagrams**: webhook confirm, mid-checkout failover, USSD-pending (DC-14), PI-SPI pay+payout, settlement ingest/match, manual-transfer review, rider broadcast/first-accept, COD remittance (`docs/SEQUENCES.md`).
- **OpenAPI 3.1** generated from shared Zod contracts — 24 endpoints, money always `{amount_minor, currency}` (`docs/api/openapi.json`, lint-tested in CI).
- **ADRs 0002–0012**: Fastify+Vite stack, domain-core-in-shared, dual-aggregator breaker, PI-SPI adapter, late-webhook policy, pack format, KYC tiers, fraud velocity rules, reconciliation matching, idempotency/webhook isolation.
- **Traceability**: FR-1…50 + DC-1…16 → module/test/phase (`docs/TRACEABILITY.md`).

## Key decisions needing eyes (none blocking)
1. ADR-0007: late webhook after expiry → **auto-refund, never resurrect** (except same-order in-flight retry).
2. ADR-0003: web apps are Vite React PWAs, not Next.js — fits ≤300 KB / low-end Android target.
3. FR-1..12/21..48 v2 texts are not in-repo; scopes reconstructed from v3 references (flagged in TRACEABILITY).

## Risks
See RISKS.md — top: Wave merchant API access (R-1), OM onboarding lead time (R-2).
