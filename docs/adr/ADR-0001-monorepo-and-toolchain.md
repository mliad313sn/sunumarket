# ADR-0001 — Monorepo layout & toolchain

**Status:** accepted · **Date:** 2026-08-20

## Context
Playbook Phase 0 mandates pnpm + Turborepo with `apps/api|web|rider|admin|mobile`,
`packages/shared`, `packages/config`, Compose infra (Postgres16+PostGIS, Redis, MinIO), CI.

## Decision
- pnpm workspaces + Turborepo task graph (`build/lint/typecheck/test/test:coverage/test:e2e`).
- **apps/api** — Fastify 5 + Zod + Prisma (PostgreSQL/PostGIS). Zod schemas live in
  `packages/shared` and generate OpenAPI (Phase 1), keeping one source of truth (ADR-0002).
- **apps/web** (buyer+seller PWA), **apps/admin**, **apps/rider** — Vite + React + TypeScript
  PWAs (ADR-0003). French-first i18n, ≤300 KB initial budget.
- **apps/mobile** — Expo (Phase 12); placeholder README until then.
- **packages/shared** — domain core: Money value object, order/dispatch state machines,
  payment routing + circuit breaker, ledger engine, reconciliation matcher, geo fee engine,
  Zod contracts. Pure TS, no I/O ⇒ TDD without infra (ADR-0004).
- **packages/config** — versioned Country Config Packs (`countries/{sn,ci,bf,ml,tg,bj,ne}.json`)
  + Zod validator + loader with hot reload.
- Infra: docker-compose (postgis/postgis:16-3.4, redis:7, minio). CI: GitHub Actions,
  service containers for Postgres+PostGIS/Redis; lint → typecheck → unit+coverage → e2e scaffold.

## Consequences
- One-command setup (`pnpm setup`) for a fresh clone; ≤10 min target.
- Domain logic testable at high coverage without infra; DB-touching tests isolated
  behind `DATABASE_URL` and run in CI service containers.
