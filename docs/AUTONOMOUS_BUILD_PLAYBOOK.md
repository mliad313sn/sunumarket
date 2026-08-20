# AUTONOMOUS BUILD PLAYBOOK — SunuMarket
**Version:** 3.0 · **Date:** 2026-08-20
**Pairs with:** `GOAL_PROMPT_SunuMarket.md` v3.0 (product authority — FR/NFR/DC/golden paths referenced by number)
**Audience:** autonomous AI build agent (Claude Code / Cowork or equivalent), minimal human intervention.
**What changed vs v2:** the payment phase is rebuilt around the Africa deep assessment — **dual-aggregator routing/failover, PI-SPI rail, USSD-confirmation UX, settlement reconciliation, multi-currency-ready money types, tiered KYC, fraud defense pack (DC-8), and Country Config Packs** — with new golden paths 9–10, an expansion drill, and compliance artifacts at the release gate.

---

## 0. Agent Operating Rules (apply always)

1. `PLAN → BUILD → VERIFY → RECORD → GATE` per phase; a phase closes only fully green; never open N+1 with N red.
2. State files from Phase 0, updated every session: `SESSION.md` (current phase, checkpoint, exact next action), `DECISIONS.log`, `BACKLOG.md`, `RISKS.md`.
3. Git: conventional commits; branch per phase; CI-green merges only; tag each gate (`gate-7-passed`).
4. **TDD on the five critical machines:** order state machine, payment processing (routing/webhooks/ledger), stock decrement, dispatch state machine, **reconciliation matcher**.
5. **Mock-first:** `MockPaymentProvider` (every method × success/failure/timeout/late-webhook/**USSD-pending**), `MockPiSpiProvider`, `MockPartnerAdapter`, `MessagingProvider`, `PushProvider`, `GeoService`. Real adapters config-selected only; credentials only via env.
6. No silent scope change: deviations → ADR + `DECISIONS.log`; descoping → `⚠ DESCOPED` in the final report. **DC-1…DC-16 are requirements** — trace them.
7. Context safety: ≤ ~8 files per session; split oversized phases, record splits.
8. Adversarial self-review before closing a phase: *"How does this fail for Tantie Rokia confirming by USSD on 2G, for Moussa carrying 45 000 FCFA of COD, for Awa during an Orange Money outage, and for the ledger when the aggregator's settlement file disagrees?"*
9. Human checkpoints (async): Gate 2 (architecture), Gate 8 (core feature-complete), Gate 12 (release candidate). ≤ 1-page summaries; continue unless instructed.

---

## Phase Map & Budget

| # | Phase | Type | Est. | Gate output |
|---|-------|------|------|-------------|
| 0 | Bootstrap & governance | Infra | 2 h | Monorepo, Compose (Postgres+PostGIS/Redis/MinIO), CI green |
| 1 | Architecture, contracts, ADRs | Design | 5 h | C4, ERD, OpenAPI, traceability FR-1…50 + DC-1…16 |
| 2 | Data layer, money types, Country Config Packs | DB | 5 h | Schema, immutability, packs SN/CI/BF loaded & validated |
| 3 | Auth, tiered KYC, RBAC, fraud base | API | 5 h | OTP + device binding, 5 roles, KYC tiers, velocity rules |
| 4 | Catalogue, media, shop pages | API+UI | 5 h | Products, sharing, marketplace |
| 5 | Geo module — delivery points & fee engine | API+UI | 5 h | Pin ×3 methods, zones, fees, deep links, retention |
| 6 | Orders & state machine | API+UI | 5 h | Lifecycle, inbox, tracking skeleton, idempotency |
| 7 | Payments I — providers, routing, methods, USSD UX | Integration | 8 h | Method matrix, dual-aggregator failover, PI-SPI, DC-14 UX |
| 8 | Payments II — ledger, payouts, reconciliation, fraud pack | Integration | 6 h | Multi-currency ledger, PI-SPI payouts, settlement matcher, DC-8 |
| 9 | Delivery network — riders, partners, COD | Integration | 8 h | Dispatch, rider flow, partner adapter+dashboard, COD ledger |
| 10 | Trust, disputes, moderation, admin | API+UI | 5 h | Ratings, disputes, admin console + v3 config panels |
| 11 | PWA hardening, i18n, data-saver, analytics | UI | 4 h | Offline queues, perf, FR/EN, DC-15 |
| 12 | Mobile app + system test + security + load + release | Mobile+Release | 10 h | Signed Android, 10 golden paths, expansion drill, RTM report |

Total ≈ 73 h agent time. Budgets, not promises — gates rule.

---

## Phase 0 — Bootstrap & Governance
As v2: pnpm+Turborepo (`apps/api|web|rider|admin|mobile`, `packages/shared`, ★`packages/config`), Compose (Postgres16+PostGIS, Redis, MinIO), CI (lint/typecheck/unit + e2e scaffold + coverage artifact), state files, ADR-0001, README one-command setup.
**Verify:** fresh clone → dev env ≤ 10 min; `PostGIS_Version()` OK; CI green. **Exit:** reproducible dev env.

---

## Phase 1 — Architecture, Contracts, ADRs
**Tasks**
- [ ] C4 diagrams incl. the **payment routing layer** (matrix → router → {AggregatorA, AggregatorB, PiSpi} → webhooks) and reconciliation worker.
- [ ] ERD (v2 set) **plus**: `payment_providers`, `provider_routes` (country+method→primary/fallback), `settlement_batches`, `settlement_lines`, `reconciliation_flags`, `kyc_tiers`, `device_bindings`, `fraud_events`, `country_packs` (versioned).
- [ ] Sequence diagrams: webhook confirm; **failover mid-checkout**; **USSD-pending confirm (DC-14)**; PI-SPI pay + payout; settlement ingest/match; manual-transfer review; rider broadcast/accept; COD remittance.
- [ ] OpenAPI v1 from shared Zod schemas; **money = {amount_minor: bigint, currency: ISO}** everywhere (DC-5).
- [ ] ADRs 0002–0012 incl.: dual-aggregator + circuit breaker; PI-SPI adapter; late-webhook-after-expiry policy; country-pack format; KYC tiering; fraud velocity rules; reconciliation matching rules (exact / fuzzy by ref+amount+date).
- [ ] `/docs/TRACEABILITY.md`: FR-1…FR-50 **and DC-1…DC-16** → endpoint/screen/adapter/test.

**Verify:** every FR **and DC** traced; all 10 golden paths walkable on ERD+sequences; OpenAPI lints. **Exit:** implementable-from-contract. **GATE 2 summary.**

---

## Phase 2 — Data Layer, Money Types, Country Config Packs
**Tasks**
- [ ] Prisma + PostGIS migrations (v2 geo set) + v3 payment/fraud/KYC tables; GiST indexes; append-only + immutability triggers on `ledger_entries`, `rider_cash_ledger`, `settlement_lines`, `fraud_events` (+ tests).
- [ ] Money value object in `packages/shared` (bigint minor units, XOF no-decimals rule, formatting FCFA) + property tests (no float anywhere — lint rule).
- [ ] ★**Country Config Packs** `packages/config/countries/{sn,ci,bf}.json` seeded from Goal Prompt §3.2: method matrix + ordering, provider routes, tax/fee pass-through defaults, KYC tier limits, phone regex (+221/+225/+226), SMS sender IDs, language default, compliance checklist stub, zones GeoJSON refs. Zod-validated, versioned, hot-loadable; ★drafts for `ml,tg,bj,ne` (wave 2) to prove the format.
- [ ] Seeds: 3 cities+zones, shops, products, riders, partner, delivery points (v2) + provider fixtures.

**Verify:** migrations up/down; immutability enforced; packs validate & hot-reload flips checkout config without restart; money property tests green; point-in-polygon correct. **Exit:** schema+packs support all 10 golden paths on paper.

---

## Phase 3 — Auth, Tiered KYC, RBAC, Fraud Base
**Tasks**
- [ ] OTP (mock messaging): 6 digits, 5 min TTL, 5 attempts, resend throttle; JWT 15 min + refresh rotation.
- [ ] ★**Device binding + new-device re-verification** with cool-down for accounts holding balance/payout rights; optional payout PIN (DC-8.3).
- [ ] Roles buyer/seller/rider/partner/admin; guest-checkout + tokenized tracking links.
- [ ] ★KYC tiers (DC-13): Tier 0 buyer → Tier 1 seller-payout (ID) → Tier 2 rider/high-volume (ID+vehicle/address); tier limits read from country pack; admin review queue.
- [ ] ★Fraud base: velocity rules (failed-payment bursts, mass signup per device/IP), `fraud_events` feed, anomaly queue (DC-8.5); consent, privacy/ToS, export/delete endpoints.

**Verify:** OTP suite (happy/lockout/throttle/rotation); new-device login on Tier-1 account forces re-verify + cool-down (test); RBAC matrix 5 roles × routes incl. rider/partner isolation; velocity test: 10 failed payments in 5 min → flag raised; tier-limit test: Tier-1 payout above pack limit → blocked with upgrade path. **Exit:** auth+fraud-base suites green; RBAC table in `/docs/reports/`.

---

## Phase 4 — Catalogue, Media, Shop Pages
As v2 (wizard ≤5 steps, product ≤60 s from photos, ≤200 KB images, deep links + share card, marketplace + trust-block/fee-estimator slots).
**Verify:** timed product creation under 3G throttle; compression proof; 360 px check; empty states. **Exit:** golden path 1 (minus config finalization) manual pass.

---

## Phase 5 — Geo Module
As v2 (GeoService unit-tested first; pin capture ×3 incl. tile-less device GPS; saved points; polygon>radius>out-of-zone fee resolution; nav deep links; consent + encryption + retention truncation).
**Verify:** 20 fixture pins/city → 100% expected commune/band/fee; airplane-mode capture; retention job; deep-link formats. **Exit:** fee pre-payment for any seeded pin; privacy proven.

---

## Phase 6 — Orders & State Machine
As v2 (pure state machine incl. `payment_pending|payment_review|delivery_issue`; guest checkout w/ pin; race-protected stock; idempotency keys; inbox; tracking skeleton).
**Verify:** 100% transition coverage incl. illegal; 20-parallel race → 1 winner; duplicate idempotency → 1 order; tracking token rotation. **Exit:** golden path 8a automated; ≥90% coverage on order module.

---

## Phase 7 — Payments I: Providers, Routing, Methods, USSD UX
**Tasks (TDD)**
- [ ] `PaymentProvider` interface (init, status, refund, verifyWebhook) + **MockPaymentProvider** covering `WAVE, ORANGE_MONEY, MTN_MOMO, MOOV_MONEY, MIXX_BY_YAS, CARD` with scenarios: success / decline / **ussd_pending→confirm** / ussd_pending→timeout / late-webhook / provider-500.
- [ ] ★**Routing layer** (FR-14): `provider_routes` from country pack (primary/fallback per method); health checks; **circuit breaker** (open on N failures/timeouts, half-open probe, close on success); new attempts auto-route to fallback; per-attempt provider recorded.
- [ ] ★**PI_SPI method** via `PiSpiProvider` (mock): pay-by-alias/QR, instant confirm callback (DC-6).
- [ ] **Method Matrix checkout UI**: pack-ordered method chips with recognizable branding, seller-subset intersection, remembered-per-buyer non-locking default (DC-4); **first-payment guided mode** microcopy (DC-2).
- [ ] ★**DC-14 USSD confirmation screen**: "confirmez sur votre téléphone" + operator dial-code hint from pack, countdown, resend, **switch-method escape**, and DC-3 cash-in guidance on failure ("la commande reste réservée 30 min").
- [ ] Attempts model + **retry-with-other-method** (FR-17); 30-min expiry restores stock exactly once; late-webhook-after-expiry per ADR (tested both branches).
- [ ] `MANUAL_TRANSFER` per DC-8.2: pack-gated (default OFF), unique reference, advisory proof, seller balance-check confirm step, scam-warning interstitial; `COD` marking (settles Phase 9).

**Verify**
- [ ] Webhook replay ×5 → single `paid`; tampered signature → 401+alert; per-provider signature isolation.
- [ ] ★Failover test = **golden path 9 (part 1)**: primary forced down mid-checkout → breaker opens ≤ 60 s → fallback completes same order; breaker half-open/close observed.
- [ ] ★USSD tests: `ussd_pending` → confirm → paid; → timeout → friendly retry/switch; **Tantie Rokia E2E (golden path 10 variant)** completes without abandonment.
- [ ] Retry path (WAVE fail → MTN pay) = golden path 3; manual-transfer path (enabled only in a test pack) = golden path 4 incl. forged-reference rejection; matrix test: SN pack shows Wave first, BF pack shows no Wave.
**Exit:** golden paths 3, 4, 9(part 1), 10(USSD variant) green; payment-attempt coverage ≥ 90%. Tag `gate-7-passed`.

---

## Phase 8 — Payments II: Ledger, Payouts, Reconciliation, Fraud Pack
**Tasks (TDD)**
- [ ] ★**Multi-currency-ready double-entry ledger** (FR-19): gross / provider fee / tax pass-through (pack config, DC-11) / net; currencies typed (XOF live); refunds per method incl. PI-SPI reverse transfer; property-based invariant Σdebits=Σcredits.
- [ ] ★**Payout rail** (FR-20): PI-SPI-first payouts + rider remittances, aggregator payout fallback, tier limits (DC-13), optional payout PIN; balance view.
- [ ] ★**Settlement reconciliation** (FR-19b): ingestion of provider settlement reports (CSV fixtures for both mock aggregators + PI-SPI), matcher (exact ref → fuzzy ref+amount+date per ADR), `reconciliation_flags` queue with aging, month-end close report.
- [ ] ★**Fraud pack completion** (DC-8): scam-education onboarding cards (seller + rider), fake-payment-SMS warning at manual-transfer and at seller order screen ("attendez le statut PAYÉ"), anomaly queue surfacing in admin.

**Verify**
- [ ] Ledger invariant after 1 000 randomized orders across all methods incl. refunds & fee/tax splits.
- [ ] ★Reconciliation = **golden path 9 (part 2)**: day-after settlement files from *both* aggregators (order paid via fallback) match ledger with zero discrepancy; a deliberately corrupted line raises a flag with correct aging.
- [ ] ★PI-SPI payout + Moussa remittance settle instantly in mock = golden path 10 (payout leg).
- [ ] Tier-limit + payout-PIN enforcement tests; education cards shown exactly once (state persisted).
**Exit:** golden paths 9 & 10 fully green; money coverage ≥ 90%. **GATE 8 summary.**

---

## Phase 9 — Delivery Network (riders, partners, COD)
As v2 in full (delivery job model; broadcast first-accept dispatch with race test; rider registration → **KYC Tier 2**; rider status flow with GPS snapshots + offline queue; proof of delivery photo/OTP-code; `DeliveryPartnerAdapter` + MockPartner + fallback partner dashboard; buyer tracking completion; `failed_attempt` incidents wired to refunds; **COD reconciliation ledger**; delivery ratings data model). ★Addendum: remittance via PI-SPI rail or agent-deposit guidance (FR-34b); counterfeit-cash education card.
**Verify:** v2 list in full (dispatch race exactly-one-winner; timeout re-broadcast escalation; proof-gated close; offline rider sync idempotent; partner webhook replay/tamper; COD invariant Σcollected=Σremitted+outstanding) + PI-SPI remittance test. **Exit:** golden paths 5, 6, 7 green; dispatch+COD coverage ≥ 85%.

---

## Phase 10 — Trust, Disputes, Moderation, Admin
As v2 (ratings seller+delivery post-`delivered`; reports/takedowns incl. riders/partners; disputes with scoped payout freeze + auto-attached delivery proof; dashboards; phone-number global search; timelines with map preview; audit log) **plus ★v3 config panels** (FR-44b): method matrix per country, provider routes primary/fallback, tax/fee pass-through, KYC tier limits, MANUAL_TRANSFER toggle, reconciliation queue, fraud/anomaly queue.
**Verify:** v2 list + config-change tests (flip provider route → next attempt uses it, no deploy; toggle MANUAL_TRANSFER off → method disappears from checkout). **Exit:** full support scenario incl. reconciliation-flag resolution runs end-to-end in admin.

---

## Phase 11 — PWA Hardening, i18n, Data-Saver, Analytics
As v2 (service worker: catalogue cache + offline queues for order+pin and rider statuses; ≤300 KB initial; LCP <2.5 s @3G; Lighthouse PWA ≥90; rider high-contrast; full FR+EN; `track()` events) **plus** ★DC-15: data-saver mode (thumbnail-first, no autoplay), **SMS notification fallback** path for buyers/riders without data (mock messaging), and payment-funnel events per method incl. USSD-step abandonment metric (KPI §10).
**Verify:** airplane buyer + airplane rider tests (single idempotent sync); Lighthouse CI budgets; i18n lint zero hardcoded strings; every golden path emits its event set; USSD-abandonment event fires correctly. **Exit:** golden path 8 fully automated; perf/i18n/data-saver gates in CI.

---

## Phase 12 — Mobile App, System Test, Security, Load, Expansion Drill, Release
**Tasks**
- [ ] **Mobile (Expo)** as v2: seller tab (shop, camera product create, inbox, dispatch, balance) + rider tab (feed, accept, status+GPS snapshot, proof, cash ledger); FCM push (order/job); deep links + Maps/Waze hand-off; EAS signed Android AAB/APK; iOS compiles; Maestro E2E golden paths 1 & 5.
- [ ] **Consolidated Playwright E2E: all 10 golden paths** vs docker-composed stack (all mocks) + admin/partner scenarios.
- [ ] **Security:** dependency+secrets scan; OWASP ZAP baseline; authz fuzz (sellers/riders/partners isolation, tracking-token brute force); OTP brute force; ★SIM-swap scenario (new device on Tier-1 → re-verify enforced); webhook signature fuzz per provider; ★fraud-rule bypass attempts.
- [ ] **Load (k6):** 200 concurrent checkouts mixed methods **with primary-provider outage injected mid-run** + 100 concurrent rider updates + 1 000 rps reads, 10 min → zero lost/dup orders/jobs, p95 <400 ms, ledger+COD invariants hold, breaker behaves.
- [ ] **Chaos:** kill Redis mid-broadcast; delay webhook 60 s; out-of-order partner webhooks; ★settlement file missing a paid order (flag raised, not silent).
- [ ] ★**Expansion drill (NFR-8):** load the `ml` (Mali) draft Country Config Pack + mock credentials in staging → checkout shows OM+Moov ordering, phone validation +223, tax config applied — **no code change**; record the drill.
- [ ] ★**Compliance artifacts (FR-41c / DC-12):** per-country checklist (DPA registration refs CDP/ARTCI/CIL, localized ToS/privacy, prohibited items, tax pass-through disclosure) completed for SN/CI/BF.
- [ ] Deploy staging+prod; ENV matrix; Sentry, health checks, uptime, daily backup + **tested restore**.
- [ ] Runbooks: incident, **payment-provider outage & failback**, **reconciliation discrepancy SOP**, refund SOP, COD discrepancy SOP, rider incident SOP, partner outage fallback (PARTNER→RIDER re-route), moderation SOP; guides: admin, seller, rider, partner (screenshots).
- [ ] Beta plan (20 sellers, 10 riders, 1 partner) + KPI dashboard mapped to Goal Prompt §10.
- [ ] **READY_TO_MARKET_REPORT.md**: gates, coverage, perf/load/security/reconciliation summaries, expansion-drill result, compliance status, descoped items, known issues, V2 top-10, go/no-go.

**Verify:** `pnpm test:e2e` green from clean clone — **10/10 paths**; mobile E2E green; ZAP zero high/medium; load+chaos reports stored with invariants held; drill recorded; restore drill passed; non-author completes golden path 1 (seller guide) and path 5 rider-side (rider guide) from docs alone.
**Exit:** production live behind beta flag; report delivered. **GATE 12 → launch decision.**

---

## Failure & Recovery Protocol
As v2 (fix in-phase; >2 blocked attempts → risk-log + smallest safe ADR'd workaround; session recovery via `SESSION.md`; Goal Prompt wins on scope) **plus:** for each real provider (AggregatorA/B, PI-SPI, partner), maintain a **contract-test file** encoding assumed behavior (statuses, webhook shapes, settlement format); run against sandboxes at integration time; divergences → adapter fix + `RISKS.md`, never a core change.

## Definition of DONE (whole programme)
All 13 phase exits met · **10/10 golden paths** automated green on web (paths 1 & 5 also mobile) · money coverage ≥ 90%, dispatch/COD ≥ 85% · reconciliation proven · expansion drill passed (NFR-8) · compliance artifacts for SN/CI/BF delivered · Goal Prompt §10 engineering gates green · signed Android build · runbooks + 4 guides · READY_TO_MARKET_REPORT with go recommendation and no unresolved high risks.
