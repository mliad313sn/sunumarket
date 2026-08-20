# SESSION STATE

> Updated every working session per Playbook rule 0.2. This file is the recovery point.

- **Current phase:** 7 — Payments I (providers, routing, USSD UX)
- **Checkpoint:** Phases 4-6 closed green (gates 4,5,6). Catalogue (shops/products/marketplace/method subset), geo (pins+consent, fee engine TS↔PostGIS cross-check, retention truncation, nav links), orders (state machine 100% coverage, 20-parallel race 1 winner, idempotency, 30-min expiry restore-once, tokenized tracking + rotation, seller inbox). 54 api tests + 35 shared tests.
- **Exact next action:** Phase 7 — PaymentProvider interface + MockPaymentProvider (all methods × success/decline/ussd_pending/timeout/late-webhook/500), routing + circuit breaker, PI-SPI mock, attempts + retry-other-method, webhooks idempotent + signature isolation, DC-14 USSD flow, MANUAL_TRANSFER gated.
- **Branch:** `claude/execute-zip-instructions-2qmy1f`

## Environment notes (this build sandbox)
- No Docker daemon available in-sandbox → local Postgres 16 + PostGIS 3.4 + Redis 7 installed natively; `docker-compose.yml` is authored for normal dev machines and CI uses service containers. Use `SUNU_NO_DOCKER=1 pnpm setup` here.
- Local DB: `postgresql://sunu:sunu@localhost:5432/sunumarket` (PostGIS enabled, verified `PostGIS_Version() = 3.4`).

## Phase gate log
- 2026-08-20 gate-0 PASSED: pnpm lint/typecheck/test/test:e2e all green; PostGIS_Version()=3.4; prisma migrate deploy OK; fresh-clone setup script authored.
- 2026-08-20 gate-1 PASSED: architecture+contracts complete; OpenAPI lint test green; FR/DC traceability committed; GATE-2 summary in docs/reports/.
- 2026-08-20 gate-2 PASSED: migrations deploy on fresh DB; immutability triggers reject mutation (5 suites); ST_Contains zone resolution correct; money bigint precision proven; packs validate + hot reload; seeds idempotent. Note: prisma has no down-migrations — fresh-DB redeploy drill used instead (recorded).
- 2026-08-20 gate-3 PASSED: OTP happy/lockout/throttle/expiry; refresh rotation + reuse revokes family; new-device Tier-1 re-verify + cool-down gate; RBAC matrix 5 roles + anonymous + expired; velocity 10-in-5min flag once + soft-block expiry; tier-limit block with upgrade path; COD cap. RBAC report in docs/reports/.
- 2026-08-20 gates 4-6 PASSED: catalog suite (6), geo suite (5, incl. PostGIS cross-check + retention idempotent), orders suite (9: race 20→1, idempotency, expiry-once, illegal transitions, tracking rotation, inbox isolation); shared order machine exhaustive sweep + geo fixtures 20/20.
