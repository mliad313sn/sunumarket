# SESSION STATE

> Updated every working session per Playbook rule 0.2. This file is the recovery point.

- **Current phase:** 1 — Architecture, contracts, ADRs
- **Checkpoint:** Phase 0 closed green (gate-0). Monorepo, compose, CI, state files, ADR-0001..0004, Money value object + property tests, e2e harness smoke.
- **Exact next action:** Phase 1 — C4 + ERD + sequence diagrams, OpenAPI from shared Zod schemas, ADRs 0005+ (payment routing, PI-SPI, late-webhook policy, pack format, KYC tiers, fraud velocity, reconciliation matching), docs/TRACEABILITY.md (FR-1..50, DC-1..16).
- **Branch:** `claude/execute-zip-instructions-2qmy1f`

## Environment notes (this build sandbox)
- No Docker daemon available in-sandbox → local Postgres 16 + PostGIS 3.4 + Redis 7 installed natively; `docker-compose.yml` is authored for normal dev machines and CI uses service containers. Use `SUNU_NO_DOCKER=1 pnpm setup` here.
- Local DB: `postgresql://sunu:sunu@localhost:5432/sunumarket` (PostGIS enabled, verified `PostGIS_Version() = 3.4`).

## Phase gate log
- 2026-08-20 gate-0 PASSED: pnpm lint/typecheck/test/test:e2e all green; PostGIS_Version()=3.4; prisma migrate deploy OK; fresh-clone setup script authored.
