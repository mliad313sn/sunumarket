# PRIME GOAL PROMPT — SunuMarket continuous improvement mission
**Version:** 1.0 · **Pairs with:** `.claude/agents/prime.md` (executor) · `CLAUDE.md` (hard rules)
· `docs/GOAL_PROMPT_SunuMarket.md` v3.0 (product authority — still supreme on scope)

## Mission
You are the **Prime Agent**. Review, improve, and complete SunuMarket toward its
ready-to-market definition, using the project's installed skills as force multipliers:

- **`playwright-cli`** — drive a *real browser* (Chromium is pre-installed) against the
  running stack to verify what unit/E2E-HTTP tests cannot: the actual buyer journey through
  the web UI. This is how you close the "browser-level verification" descope.
- **`impeccable`** — design language for auditing and polishing the three PWAs (web, rider,
  admin): hierarchy, spacing, typography, states, accessibility, anti-patterns.
- **`design-taste-frontend`** (+ pack) — anti-generic frontend taste: the buyer PWA must
  feel like a crafted West-African commerce product, not templated AI output.

## Priorities (work top-down; one coherent increment at a time)
1. **Anything red** — failing gate, broken invariant, un-reviewed working-tree changes.
2. **Browser-verified golden path (new capability):** boot API + web (seeded DB), use
   `playwright-cli` to walk golden path 2 through the real UI — marketplace → product →
   checkout (GPS pin + landmark + consent) → method chips → pay → PAYÉ — and capture
   screenshots as evidence into `docs/reports/browser-evidence/`. Turn this into a
   repeatable script/spec, not a one-off.
3. **UI elevation under constraints:** apply `impeccable`/`design-taste-frontend` to the
   buyer PWA first (then rider, then admin). Non-negotiables while doing it:
   FR-first microcopy stays; DC-14 USSD screen elements (dial code, countdown, resend,
   switch-method) stay; DC-15 budget holds (≤300 KB initial, data-saver honored, system
   font stack or self-hosted only — **no CDN fonts**); accessibility ≥ WCAG AA contrast;
   trust artifacts (DC-16) become *more* prominent, never less.
4. **Backlog burn-down:** items in `BACKLOG.md` not gated on external credentials.
5. **V2 preparation** only when 1–4 are clean.

## Rules of engagement
- Everything in `CLAUDE.md` binds. Product scope conflicts resolve to
  `docs/GOAL_PROMPT_SunuMarket.md`; process to the Playbook. Deviations → ADR.
- Skills are advisors, not authorities: if a skill's guidance conflicts with DC-15's
  performance budget or the product's low-end-Android reality, the DC wins — note the
  tension in your report instead of silently following the skill.
- Verification gate for every increment (all must pass before "done"):
  ```bash
  pnpm lint && pnpm typecheck
  DATABASE_URL=postgresql://sunu:sunu@localhost:5432/sunumarket pnpm test
  (cd e2e && DATABASE_URL=postgresql://sunu:sunu@localhost:5432/sunumarket pnpm test:e2e)
  psql "$DATABASE_URL" -f scripts/invariants.sql        # all queries: 0 rows
  pnpm --filter @sunumarket/web build                   # bundle budget check
  ```
  plus, for UI work, a `playwright-cli` browser pass with screenshots.
- Update `SESSION.md` every increment; conventional commits on the working branch.

## Definition of "complete" for this mission
Browser-verified buyer golden path (repeatable + evidenced) · buyer PWA passes an
`impeccable`-style audit with zero critical findings while holding the DC-15 budget ·
no red gates · SESSION/BACKLOG/reports reflect reality · everything committed and pushed.
