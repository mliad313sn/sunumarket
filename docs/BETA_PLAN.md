# Beta plan — SunuMarket V1

**Cohort:** 20 sellers · 10 riders · 1 delivery partner (DiaLog Express) — Dakar first,
then Abidjan + Ouagadougou after 2 green weeks.

## Week 0 (setup)
- Provider onboarding finalized: Aggregator A + B merchant accounts (start OM early — R-2),
  Wave via aggregator/QR (R-1), PI-SPI participation via sponsor institution.
- Real adapter contract tests run against sandboxes (Playbook failure protocol);
  divergences → adapter fixes + RISKS.md, never core changes.
- Compliance checklists SN cleared to at least items 1–4 (docs/compliance/sn.md).
- Staging soak: k6 profile (load/k6-checkout.js) + chaos drills + `scripts/invariants.sql` clean.

## Weeks 1–2 (Dakar)
- 20 sellers recruited from TikTok commerce groups; onboarding unaided, timed (target <10 min — success metric a).
- 10 riders KYC Tier 2; COD enabled with pack caps.
- Support rota with runbooks; admin console staffed daily.

## KPI dashboard (maps to Goal §10)
| KPI | Target | Source |
|-----|--------|--------|
| MM attempt success per method | ≥ 70% | `payment_attempts` by method/status |
| Orders touching fallback aggregator | < 5% steady-state | attempts.provider vs pack primary |
| Reconciliation discrepancies | < 0.5% volume, cleared < 72 h | reconciliation_flags aging |
| First-buyer USSD completion | ≥ 50% no abandonment | `ussd_abandoned` / `ussd_confirm_shown` events |
| COD share per country | monitored, not suppressed (DC-11) | attempts method=COD share |
| Seller onboarding time | < 10 min unaided | onboarding funnel events |
| Rider COD outstanding | 100% within tier caps | rider_cash_ledger vs pack caps |

## Exit criteria to public launch
All KPI targets green for 2 consecutive weeks · zero unresolved high-severity incidents ·
compliance items 1–4 done for the launch country · restore drill re-passed on prod backups.
