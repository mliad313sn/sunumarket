# ADR-0009 — Tiered KYC model

**Status:** accepted · **Date:** 2026-08-20 · **Refs:** DC-13, FR-20, Phase 3

## Decision
Aligned with BCEAO e-money practice:

| Tier | Who | Requirement | Unlocks |
|------|-----|-------------|---------|
| 0 | Buyer | Phone OTP only | Buy, save delivery points |
| 1 | Seller taking payouts | ID document | Payouts up to pack limit |
| 2 | Rider handling COD / high-volume seller | ID + address/vehicle | COD custody up to pack cap; higher payout limits |

- Limits (payout per day, COD outstanding cap) come from the Country Config Pack, per tier.
- Enforcement at the transaction edge: payout/remittance requests above the caller's tier
  limit are blocked with an explicit upgrade path (never a silent failure).
- Admin review queue for tier upgrade requests; documents in MinIO, encrypted.
- Accounts with balance/payout rights get device-binding + new-device re-verification with
  cool-down (DC-8.3) — enforced from Tier 1 up.
