# BACKLOG

## ⚠ DESCOPED in this build environment (see READY_TO_MARKET_REPORT §4)
- Expo mobile app + EAS signed Android build (Phase 12) — PWAs cover flows meanwhile.
- Staging/prod deploy, Sentry wiring, backup+restore drill (no deploy target in sandbox).
- ZAP baseline / k6 execution / infra-level chaos / Lighthouse CI — scripts + criteria shipped (load/, scripts/invariants.sql), to run against staging.
- Redis-backed circuit-breaker + pack-override store for multi-instance prod (in-memory today).
- Client image compression ≤200KB + MinIO upload wiring (media pipeline).

## V1 open items (tracked per phase in Playbook)
- Phase 12: Expo mobile app (seller + rider tabs), EAS signed build.
- Real aggregator adapters (AggregatorA/B) against sandboxes — mock-first per Playbook rule 0.5; credentials via env only.
- Real PI-SPI adapter (mock ships first).
- MinIO media pipeline wiring in web upload UI.

## V2 / explicitly out of V1 (Goal Prompt §8)
- Cross-seller cart, live GPS streaming, route optimization, buyer wallets,
  multi-currency checkout, iOS submission, ads, own map tiles,
  cross-border purchases, USSD full storefront, Wave-3 country launches (design-ready only), crypto/stablecoins.
- ~~Privacy note: /me delete must ANONYMIZE (fraud_events/audit are append-only, FKs SetNull is blocked by guard) — implement anonymizing delete in Phase 10/12 hardening.~~
  **DONE 2026-08-21:** `DELETE /me` implemented (`apps/api/src/modules/auth/privacy.service.ts`) — tombstones the user row, kills sessions/devices, scrubs KYC docs + saved pins (immediate FR-25 truncation) + order GPS snapshots + sms_outbox history, writes an audit_log record; 409-guarded on active orders, un-remitted rider COD, and non-zero ledger balances. 4-test suite `apps/api/test/privacy.delete.test.ts`. Legal/DPA review of the anonymization standard still pending (RTM §4.6).
