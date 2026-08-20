# Security verification — Phase 12

## Executed in this build environment
- **Dependency scan:** `pnpm audit --prod` → **0 known vulnerabilities** (1 high transitive
  advisory in `deepmerge-ts <8` via prisma CLI config was remediated with a pnpm override to ≥8).
- **Authz isolation (tested):** RBAC matrix 5 roles × routes + anonymous + expired tokens;
  seller↔seller shop/product isolation; rider↔rider job isolation; partner job list scoped;
  buyer/guest order ownership checks; tracking is tokenized with rotation invalidating old links.
- **Webhook signature fuzzing (tested):** tampered signature → 401 + fraud event; cross-provider
  signature rejected (per-provider secret isolation, NFR-3); replay ×5 deduped; partner webhooks
  tamper/replay covered; malformed hex signatures rejected without exceptions.
- **OTP brute force (tested):** 5-attempt lockout, 60 s resend throttle, 5-min TTL, hash-at-rest.
- **SIM-swap scenario (tested):** new device on Tier≥1 → forced re-verify + fraud event +
  24 h payout cool-down; refresh-token reuse revokes the whole session family.
- **Fraud-rule bypass attempts (tested):** forged manual-transfer reference rejected + flagged;
  velocity soft-block engages at threshold and expires (no permanent ban);
  `paid` unreachable except via verified webhook/PI-SPI confirm (state machine proves the only
  entries to `paid` are payment_pending/payment_review).
- **Money integrity:** DB-level append-only triggers (update/delete rejected — tested),
  write-once settlement matching, non-zero entry constraint, invariants SQL suite 8/8 clean
  after the full test corpus on a fresh database.
- **Secrets:** none in repo (credentials env-only; mock secrets are dev defaults); `.env` ignored.

## Deferred to staging (no Docker/ZAP/k6 in this build sandbox) — ⚠ DESCOPED here, CI-ready
- OWASP ZAP baseline scan (target: staging URL; add to release pipeline).
- k6 load profile with mid-run provider outage: script shipped (`load/k6-checkout.js`),
  pass criteria + post-run invariants (`scripts/invariants.sql`) defined.
- Chaos drills at infra level (kill Redis mid-broadcast, 60 s webhook delay): application-level
  equivalents are tested (late webhooks, out-of-order partner events, settlement file missing a
  paid order → flags raised); infra-level runs belong to the staging soak.
- Container/image scanning and secret scanning in CI (add trivy/gitleaks steps).
