# SunuMarket — agent prime context

Social-commerce marketplace for African micro-sellers: mobile-money payments (Wave, Orange
Money, MTN MoMo, Moov, Mixx by Yas, PI-SPI, COD), GPS-pin delivery, FCFA/XOF, French-first.

## Authorities (read in this order before non-trivial work)
1. `docs/GOAL_PROMPT_SunuMarket.md` — product authority (FR-1..50, DC-1..16, NFR-1..8).
2. `docs/AUTONOMOUS_BUILD_PLAYBOOK.md` — process authority (gates, TDD machines, mock-first).
3. `SESSION.md` — current state + exact next action. **Update it every session.**
4. `BACKLOG.md`, `RISKS.md`, `DECISIONS.log` + `docs/adr/` — scope changes need an ADR.
5. `READY_TO_MARKET_REPORT.md` + `docs/reports/COMMITTEE-REVIEW.md` — what's done vs gated.

## Hard rules (binding, from the authorities)
- **Money**: bigint minor units + ISO code everywhere (DC-5). Never `number` for amounts —
  lint-enforced in `packages/shared/src/{money,ledger}`.
- **`paid` only via verified provider webhook / PI-SPI confirm** (DC-8.1) — never SMS,
  screenshot, or client claim.
- **Mock-first** (Playbook 0.5): real adapters are config-selected; credentials env-only.
- Append-only tables (`ledger_entries`, `rider_cash_ledger`, `settlement_lines`,
  `fraud_events`, `audit_log`) have DB immutability triggers — design around them, never off.
- Country behavior is **data** (Country Config Packs, FR-49) — new countries are packs, not code.
- TDD on the five critical machines: order state machine, payment routing/webhooks/ledger,
  stock decrement, dispatch, reconciliation matcher.

## Layout
pnpm + Turborepo: `apps/api` (Fastify+Zod+Prisma+PostGIS), `apps/web|rider|admin` (Vite React
PWAs), `apps/mobile` (Expo, Phase 12 backlog), `packages/shared` (pure domain core),
`packages/config` (country packs), `e2e` (10 golden paths, black-box HTTP).

## Commands
```bash
SUNU_NO_DOCKER=1 pnpm setup            # sandbox: native PG+PostGIS+Redis (see SESSION.md)
pnpm lint && pnpm typecheck && pnpm test
DATABASE_URL=postgresql://sunu:sunu@localhost:5432/sunumarket pnpm test   # DB suites
cd e2e && pnpm test:e2e                # golden paths
psql "$DATABASE_URL" -f scripts/invariants.sql   # 8 money/stock invariants — all 0 rows
pnpm --filter @sunumarket/api worker   # background sweeps
```

## Definition of "done" for any change
lint + typecheck + full test suite green, invariants SQL clean, `SESSION.md` updated,
conventional commit on the working branch. A phase/gate claim needs its verify list green.
