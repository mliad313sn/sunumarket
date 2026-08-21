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

## Recorded by the FINAL committee assessment (2026-08-21, docs/reports/FINAL-ASSESSMENT.md)
- **Seller experience beyond the minimal web console** — full seller surface (media upload,
  richer order management, payout history, KYC upsell) ships with the Expo app (S1).
- **Partial refunds / split dispute resolutions** — amount-carrying refund contract + `adjustment`
  ledger postings; V1 is full-refund only (C8).
- **Per-provider / per-method fee bps + effective-dated rates** in Country Config Packs; ledger
  transactions should stamp the rate version used (C9).
- **Payout fees + platform treasury account** — payouts currently fee-less against `buyer_funds`;
  model real rail costs and a platform cash account with real adapters (C10).
- **Rider ledger accounts** — credit delivery fees + post remittances (`kind: remittance`) into
  the double-entry ledger; today riders get earnings visibility only (C7/R2).
- **Non-XOF currency support** — `"XOF"` is hardcoded in orders/payouts/remittance/recon-ingest;
  fine for the 7 UEMOA launch packs, THE blocking work item for any non-XOF country (C13).
- **Buyer accounts + order history** — V1 is deliberately guest-first; tracking-link SMS (B1 fix)
  is the durable handle; login + « mes commandes » is V2 (B5).
- **Raw-body HMAC capture** (`fastify-raw-body`) — required before ANY real provider webhook;
  item #1 of the real-adapter contract-test protocol (X3).
- **Redis-backed shared rate limiter + velocity counters** — in-process limiter shipped this
  round; must be shared state before multi-instance staging (X1, joins the breaker-state item).
- **Admin step-up auth** (reuse payout device-trust), JWT `iss`/`aud` claims + key rotation,
  role-revocation list (A2, X5).
- **Server-side funnel analytics ingest** — web funnel events (incl. `ussd_abandoned`) are
  client-only today; add ingest + drain with staging observability (K1).
- **`ratings.comment` scrub on privacy delete** — needs author-linkage design; ratings are
  guest-phone keyed (L3).
- **i18n for rider/admin apps** — internal FR-first tools, hardcoded French accepted for V1 (A3).

## V2 / explicitly out of V1 (Goal Prompt §8)
- Cross-seller cart, live GPS streaming, route optimization, buyer wallets,
  multi-currency checkout, iOS submission, ads, own map tiles,
  cross-border purchases, USSD full storefront, Wave-3 country launches (design-ready only), crypto/stablecoins.
- ~~Privacy note: /me delete must ANONYMIZE (fraud_events/audit are append-only, FKs SetNull is blocked by guard) — implement anonymizing delete in Phase 10/12 hardening.~~
  **DONE 2026-08-21:** `DELETE /me` implemented (`apps/api/src/modules/auth/privacy.service.ts`) — tombstones the user row, kills sessions/devices, scrubs KYC docs + saved pins (immediate FR-25 truncation) + order GPS snapshots + sms_outbox history, writes an audit_log record; 409-guarded on active orders, un-remitted rider COD, and non-zero ledger balances. 4-test suite `apps/api/test/privacy.delete.test.ts`. Legal/DPA review of the anonymization standard still pending (RTM §4.6).
