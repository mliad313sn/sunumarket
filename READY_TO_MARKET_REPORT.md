# READY_TO_MARKET_REPORT — SunuMarket V1

**Date:** 2026-08-20 · **Branch:** `claude/execute-zip-instructions-2qmy1f` ·
**Authorities:** Goal Prompt v3.0 (product) · Autonomous Build Playbook v3.0 (process)

## Recommendation: **CONDITIONAL GO** — beta-ready on mocks; production launch gated on the 5 external integrations listed under "Descoped".

> **Addendum (same day):** the Goal §4 stakeholder committee re-convened for a full scope audit
> and confirmed 6 gaps the phase reports had missed — two of them beta-blockers (COD sales never
> credited the seller ledger; no worker ran the sweeps in production). **All six are remediated
> and regression-tested** — see `docs/reports/COMMITTEE-REVIEW.md`. Suite now 189 tests.

---

## 1. Gates

| Phase | Gate | Result |
|-------|------|--------|
| 0 Bootstrap | monorepo, compose, CI, governance | ✅ green |
| 1 Architecture | C4/ERD/sequences, OpenAPI (24 endpoints) from Zod, ADR-0001..0012, FR+DC traceability | ✅ green (GATE-2 summary) |
| 2 Data layer | 34-table schema, PostGIS, immutability triggers, Money bigint, packs sn/ci/bf + 4 drafts, hot reload | ✅ green |
| 3 Auth/KYC/fraud | OTP, refresh rotation w/ reuse revocation, device binding + cool-down, RBAC, tier limits, velocity rules | ✅ green |
| 4–6 Catalogue/Geo/Orders | wizard, marketplace, fee engine TS↔PostGIS cross-checked, retention, state machine, 20-race → 1 winner, expiry restore-once | ✅ green |
| 7 Payments I | routing + circuit breaker + in-call failover, webhook-only paid, USSD UX, manual transfer hardened | ✅ green (tag gate-7-passed) |
| 8 Payments II | ledger Σ=0 fuzz, PI-SPI payouts, reconciliation matcher + flags + close, education cards | ✅ green (GATE-8 summary) |
| 9 Delivery | dispatch race, COD cycle + OTP proof, offline-idempotent sync, partner webhooks, PI-SPI remittance | ✅ green |
| 10 Trust/Admin | ratings, scoped dispute freeze, takedowns, config flips without deploy | ✅ green |
| 11 PWA | buyer app w/ DC-14 USSD screen, offline queue, i18n FR/EN, data-saver, funnel analytics; rider + admin apps | ✅ green |
| 12 Release | 10/10 golden paths E2E, Mali expansion drill, compliance artifacts, runbooks/guides, security pass, invariants | ✅ green (this report) |

## 2. Test & coverage summary
- **181 automated tests** green from a **fresh database** (clean-room drill: drop DB → migrate →
  seed → full suite → invariants): shared 51 · config 12 · web 6 · api 99 · consolidated E2E 13.
- **10/10 golden paths** automated black-box over real HTTP (`e2e/tests/golden-paths.e2e.ts`).
- Coverage: API statements **91.8%** (payments 91%, ledger 93%, reconciliation 100%);
  money/dispatch machines exhaustively swept (every illegal transition asserted).
- **Invariants:** 8/8 SQL checks return zero rows after the full corpus (ledger balanced globally
  and per txn, COD cache = append-only ledger, no dup orders/jobs, stock ≥ 0, paid ⇔ exactly one
  succeeded attempt).

## 3. Pan-African payment architecture — verified behaviors
- Failover mid-checkout (golden path 9): breaker opens, same order pays via fallback, both
  providers' settlement files reconcile with zero discrepancy; failover attempt provably recorded
  against the fallback provider.
- Both-rails-down: order + stock stay reserved 30 min, DC-3 copy, no order lost (NFR-2).
- USSD (DC-14): dial-code-from-pack, countdown, resend, switch-method escape; Tantie Rokia
  completes without abandonment; abandonment KPI event instrumented.
- Fraud pack (DC-8): `paid` only via verified webhook/PI-SPI; fake-SMS attack cannot mark paid
  (tamper test leaves order unpaid); MANUAL_TRANSFER admin-gated w/ forged-reference flagging and
  mandatory seller balance-check; SIM-swap → re-verify + payout cool-down; velocity soft-blocks.
- Expansion (NFR-8): **Mali drill passed** — activating the draft pack via hot reload exposed
  OM+Moov ordering, +223 validation, ML tax config, routes — zero code change, restore verified.

## 4. ⚠ DESCOPED (environment or V1-scope; all recorded in BACKLOG.md)
1. **Real provider adapters** (Aggregator A/B, PI-SPI, SMS gateway, partner) — mock-first per
   Playbook 0.5; interfaces + contract-test slots ready; credentials env-only.
2. **Expo mobile app + EAS signed Android build** — Phase 12 mobile deliverable not built in this
   sandbox (no EAS); rider/seller PWAs cover the flows; app shell is the top follow-up.
3. **Staging/prod deploy, Sentry, backups + restore drill** — no deploy target from this
   environment; compose + CI + ENV matrix (.env.example) + runbooks shipped.
4. **ZAP baseline, k6 execution, infra chaos, Lighthouse CI budgets** — tooling absent in
   sandbox; k6 script + invariants SQL + pass criteria shipped; application-level equivalents
   (late/out-of-order webhooks, missing settlement lines, offline sync) are tested.
5. **Media pipeline** (image compression ≤200 KB, MinIO wiring in upload UI) — storage schema +
   compose service ready; client compression is a web follow-up.
6. Privacy "delete" endpoint anonymizes rather than hard-deletes (append-only fraud/audit
   retention) — documented; legal review with DPA filings.

## 5. Known issues / notes
- Circuit-breaker and pack-override state is per-API-instance (in-memory); multi-instance prod
  needs the Redis-backed store (interface ready).
- `docs/TRACEABILITY.md` carries FR-1..12/21..48 with titles reconstructed from v3 references
  (v2 text not provided in the zip) — flagged since Phase 1.
- Market-share figures live in packs as dated planning inputs (Goal §12) — revisit quarterly.

## 6. V2 top-10 (from Goal §8 + build learnings)
1. Expo mobile app + FCM push (restores Phase 12 descope). 2. Real aggregator adapters + sandbox
   contract tests. 3. Redis-shared breaker/override state + BullMQ workers for sweeps.
4. Cross-border PAPSS corridors. 5. USSD full storefront. 6. Buyer wallets/loyalty.
7. Route optimization + live GPS streaming. 8. Multi-currency checkout (GHS/NGN/KES schema-ready).
9. Media pipeline + CDN. 10. Wave-3 country launches (design-ready packs).

## 7. Go / No-Go
- **Beta on mocks (staging):** **GO** — all Playbook gates green, definition of DONE met except
  environment-descoped items.
- **Public production launch:** **NO-GO until** real adapters pass contract tests, staging soak
  (k6+ZAP+chaos+restore) is green, and compliance items 1–4 are cleared for Senegal.

## 8. Addendum — FINAL committee assessment (2026-08-21, docs/reports/FINAL-ASSESSMENT.md)

A second, final committee round audited the finished product (post UI-elevation) with three
independent code audits. It confirmed the domain core sound (DC-5, DC-8.1, immutability,
state machines re-verified clean) and found the remaining defects at subsystem *edges*; all
critical/high items were remediated in three gated passes:

- **Money:** dispute-refund ordering (freeze held until refund succeeds), atomic + idempotent
  refunds, payout advisory-lock (double-spend closed), honest rail-down (503, no fake
  settlement), reconciliation ingest/match wired to admin HTTP routes, KYC/fraud/dispute/
  recon-flag decisions now audited with actor, webhook freshness window,
  `ledger_transactions` immutability trigger, invariants extended to **10 checks**.
- **Platform:** per-partner webhook secrets, OTP/webhook rate limiting, production
  dev-default-secret refusal, worker heartbeat + deep `/health`, privacy scrub extended
  (shop PII, guest_phone, SMS bodies, rider GPS retention), incident re-dispatch, remittance
  idempotency, order-confirmation SMS with tracking link, buyer cancel.
- **Frontend:** minimal **seller console** in the web PWA (OTP login → shop → products →
  orders → payouts), tracking-page cancel/dispute/rating with translated statuses, rider
  earnings line. Browser-verified with fresh evidence (01→09).

Final gate: **209 unit/DB tests + 13 e2e green**, invariants 10/10, bundles ≤58 KB gz.
Deferred findings are recorded with rationale in BACKLOG.md ("Recorded by the FINAL committee
assessment"). **Verdict: GO for beta on mocks reaffirmed — without financial-correctness
reservations. Production gates in §7 unchanged.**
