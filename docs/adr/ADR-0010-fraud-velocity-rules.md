# ADR-0010 — Fraud velocity rules & anomaly queue

**Status:** accepted · **Date:** 2026-08-20 · **Refs:** DC-8.5, FR-41b, Phase 3/8

## Decision
Rules evaluated in-line (cheap counters in Redis) writing append-only `fraud_events`:

| Rule | Threshold (initial, pack-tunable) | Action |
|------|-----------------------------------|--------|
| Failed-payment burst | ≥10 failed attempts / 5 min per buyer or device | flag `velocity_failed_payments`; soft-block new attempts 15 min |
| Mass signup | ≥5 accounts / hour per device or IP | flag `mass_signup`; require OTP re-verify; queue review |
| New device on Tier≥1 account | always | forced re-verification + 24 h payout cool-down (DC-8.3) |
| Payout anomaly | payout > 3× trailing 30-day median | flag `payout_anomaly`; hold for review if also new device |
| Forged manual-transfer reference | reference reuse/unknown | reject + flag |

- Flags feed the admin **anomaly queue** (Phase 10 UI) with review states
  `open|cleared|actioned`. Thresholds are config, not code.
- Soft-block ≠ ban: blocked users see a friendly retry-later message (false positives are
  expected in a low-literacy market — DC-2).
