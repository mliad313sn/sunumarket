# SESSION STATE

> Updated every working session per Playbook rule 0.2. This file is the recovery point.

- **Current phase:** 4-6 — Catalogue, geo module, orders
- **Checkpoint:** Phase 3 closed green (gate-3). OTP auth + refresh rotation w/ reuse-revocation, device binding + Tier≥1 new-device re-verify + payout cool-down, payout PIN, RBAC 5 roles, KYC tiers/limits from packs w/ upgrade paths, velocity rules + fraud_events + admin queues. 34 api tests green.
- **Exact next action:** Phase 4 (catalogue/shops), Phase 5 (GeoService + fee engine), Phase 6 (order state machine + race-protected stock + idempotency).
- **Branch:** `claude/execute-zip-instructions-2qmy1f`

## Environment notes (this build sandbox)
- No Docker daemon available in-sandbox → local Postgres 16 + PostGIS 3.4 + Redis 7 installed natively; `docker-compose.yml` is authored for normal dev machines and CI uses service containers. Use `SUNU_NO_DOCKER=1 pnpm setup` here.
- Local DB: `postgresql://sunu:sunu@localhost:5432/sunumarket` (PostGIS enabled, verified `PostGIS_Version() = 3.4`).

## Phase gate log
- 2026-08-20 gate-0 PASSED: pnpm lint/typecheck/test/test:e2e all green; PostGIS_Version()=3.4; prisma migrate deploy OK; fresh-clone setup script authored.
- 2026-08-20 gate-1 PASSED: architecture+contracts complete; OpenAPI lint test green; FR/DC traceability committed; GATE-2 summary in docs/reports/.
- 2026-08-20 gate-2 PASSED: migrations deploy on fresh DB; immutability triggers reject mutation (5 suites); ST_Contains zone resolution correct; money bigint precision proven; packs validate + hot reload; seeds idempotent. Note: prisma has no down-migrations — fresh-DB redeploy drill used instead (recorded).
- 2026-08-20 gate-3 PASSED: OTP happy/lockout/throttle/expiry; refresh rotation + reuse revokes family; new-device Tier-1 re-verify + cool-down gate; RBAC matrix 5 roles + anonymous + expired; velocity 10-in-5min flag once + soft-block expiry; tier-limit block with upgrade path; COD cap. RBAC report in docs/reports/.
