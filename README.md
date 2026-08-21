# SunuMarket

Social-commerce marketplace for African micro-sellers: publish products, get paid through
the mobile-money methods that actually dominate each country (Wave, Orange Money, MTN MoMo,
Moov, Mixx by Yas, PI-SPI, COD…), and deliver to a **GPS-pinned point** by self, independent
rider, or partner courier.

Launch countries: 🇸🇳 Senegal · 🇨🇮 Côte d'Ivoire · 🇧🇫 Burkina Faso — FCFA (XOF), French-first.

- Product authority: [`docs/GOAL_PROMPT_SunuMarket.md`](docs/GOAL_PROMPT_SunuMarket.md) (v3.0)
- Process authority: [`docs/AUTONOMOUS_BUILD_PLAYBOOK.md`](docs/AUTONOMOUS_BUILD_PLAYBOOK.md) (v3.0)
- Decisions: [`DECISIONS.log`](DECISIONS.log) + [`docs/adr/`](docs/adr/)

## One-command setup

```bash
pnpm setup
```

Requires Node ≥ 22, pnpm ≥ 10, Docker (for Postgres+PostGIS / Redis / MinIO).
No Docker? Run local Postgres 16 + PostGIS and Redis, then `SUNU_NO_DOCKER=1 pnpm setup`.

## Workspace

| Path | What |
|------|------|
| `apps/api` | Fastify + Zod + Prisma API (PostGIS) |
| `apps/web` | Buyer + seller PWA (Vite React, FR/EN) |
| `apps/admin` | Admin console |
| `apps/rider` | Rider PWA (high-contrast, offline queue) |
| `apps/mobile` | Expo app (Phase 12) |
| `packages/shared` | Domain core: Money, state machines, payment routing, ledger, reconciliation, geo fees, Zod contracts |
| `packages/config` | Country Config Packs (versioned JSON + GeoJSON, Zod-validated, hot-loadable) |

## AI tooling (Claude Code)

- `CLAUDE.md` — prime context loaded automatically by Claude Code sessions (authorities, hard rules, gate).
- `.claude/agents/prime.md` — **Prime Agent**: senior improvement engineer; primes on the
  project authorities, executes one high-value improvement per run, and only reports done
  when lint + typecheck + full test suite + `scripts/invariants.sql` are green.
- `.claude/commands/prime.md` — `/prime` slash command: primes any session on project state
  and proposes (or executes) the next highest-value improvement.

## Commands

```bash
pnpm dev             # all apps in dev mode
pnpm test            # unit + property tests
pnpm test:coverage   # with coverage artifacts
pnpm test:e2e        # golden-path E2E (composed stack)
pnpm lint && pnpm typecheck
pnpm db:migrate && pnpm db:seed
```
