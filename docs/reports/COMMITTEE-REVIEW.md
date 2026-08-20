# Committee review vs scope — re-convening of the Goal §4 stakeholder committee

**Date:** 2026-08-20 · **Trigger:** post-gate-12 full scope audit requested by the operator ·
**Basis:** Goal Prompt v3.0 (FR-1..50, DC-1..16, NFR-1..8, golden paths, §10 KPIs) + Playbook v3.0
(incl. adversarial question 0.8: *"How does this fail for Tantie Rokia on 2G, for Moussa carrying
45 000 FCFA of COD, for Awa during an OM outage, and for the ledger when the settlement file
disagrees?"*)

## Method
Each stakeholder seat audited the delivered system against its slice of scope, by inspecting the
actual code paths (not the phase reports). Six findings were confirmed as real gaps, all
**remediated in this session** with a dedicated regression suite
(`apps/api/test/committee.review.test.ts`, one test block per finding). Findings that earlier
reports had already recorded as descopes were re-affirmed, not re-litigated.

## Findings & actions

| # | Seat | Finding | Severity | Action taken |
|---|------|---------|----------|--------------|
| A | CFO + Awa (seller) | **COD sales never credited the seller's ledger.** Cash reached the rider cash ledger but the seller payable balance was never written — a COD-only seller could never withdraw. FR-16/FR-19 gap the phase reports missed. | **Critical** | On COD delivery, `recordSale` posts to the main ledger with **platform fee only** (no provider fee, no MM tax on a cash handover — `feeKinds` filter added). Verified: seller payable = gross − 2% platform fee; txn balanced; anchored to the COD attempt. |
| B | Tantie Rokia (DC-15) | **`sms_outbox` was never written** — notifications went through the in-memory mock only; nothing auditable, nothing retryable, and no "delivered" SMS existed. | High | `OutboxMessagingProvider` now persists every SMS (queued → sent) before the gateway, with a worker retry sweep for gateway failures; delivered-notification SMS added. Verified incl. the failure→retry path. |
| C | Security + DiaLog (partner) | **`/partner/jobs` served the first partner's jobs to any partner-role user** — cross-partner data leak. | High | `partners.contact_user_id` column (migration) + seeded ops user; route now resolves strictly the caller's partner, 403 otherwise. Verified with a linked and an unlinked partner user. |
| D | Ops | **No worker entrypoint** — the sweeps (order expiry FR-17, USSD timeout DC-14, re-broadcast, retention truncation FR-25) existed only as service methods exercised by tests; in production nothing would run them. `delivered → completed` never fired at all. | **Critical** | `apps/api/src/worker.ts` (fast sweep 60 s / slow sweep 1 h, `pnpm --filter @sunumarket/api worker`) covering all sweeps + new `autoCompleteDelivered` (3-day window) + SMS outbox retry. Verified: sweeps run, auto-complete is idempotent. |
| E | Moussa (FR-26) | Re-broadcast **never escalated** — a job could broadcast forever with the seller unaware. | Medium | From the second stale round the seller is SMS-notified to switch to PARTNER/SELF (partner-outage runbook path). Verified. |
| F | Admin + KPI (§10) | KPI *"MM attempt success per method (tracked separately)"* had raw data but **no reporting surface**. | Medium | `GET /admin/metrics/payments`: success rate per method + paid volume per provider (fallback-share input). Verified incl. authz. |

**Also fixed while auditing:** an order-dependent test flake (`catalog.phase4` mutated a seed
shop's method subset that payment suites depend on — now uses a dedicated shop).

## Re-affirmed positions (no action, previously recorded)
- Real provider adapters, Expo mobile app, staging soak (ZAP/k6/chaos/restore), media pipeline,
  Redis-shared breaker state, anonymizing privacy-delete → BACKLOG / RTM §4, unchanged.
- FR-1..12/21..48 v2 titles remain reconstructed (v2 text absent from the zip) — standing note.

## Post-remediation verification
- **189 tests green** (shared 51 · config 12 · web 6 · api **107** · E2E 13) including the new
  8-test committee suite; api suite stable ×2.
- Invariant SQL sweep **8/8 clean** — notably invariant #1/#2 (ledger balance) now also covers
  the new COD sale postings.
- Typecheck 0 errors, lint clean, `pnpm audit --prod` still 0 vulnerabilities.

## Committee verdict
The earlier **conditional GO stands and is strengthened**: findings A and D were genuine
launch-blockers for a beta with real sellers (unpayable COD sellers; dead sweeps) and are now
closed with tests. The production gate list in READY_TO_MARKET_REPORT §7 is unchanged.
