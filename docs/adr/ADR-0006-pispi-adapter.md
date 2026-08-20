# ADR-0006 — PI-SPI as payment method and payout rail

**Status:** accepted · **Date:** 2026-08-20 · **Refs:** DC-6, DC-7, FR-13, FR-20, golden path 10

## Decision
- `PiSpiProvider` implements the same `PaymentProvider` interface as aggregators, plus a
  `transfer()` payout capability. Pay-in: pay-by-alias/QR — buyer pays from **any**
  participating wallet or bank app ("payez depuis n'importe quel portefeuille").
- Confirmation is the PI-SPI instant notification (<10 s), treated with the same trust level
  as a signed aggregator webhook (DC-8.1).
- **Payout rail preference:** seller payouts and rider remittances try PI_SPI first
  (instant, wallet-agnostic, near-zero cost), fall back to aggregator payout APIs.
- Refunds over PI-SPI: reverse instant transfer where supported (FR-18); otherwise queue
  aggregator refund.
- V1 ships `MockPiSpiProvider`; the real adapter is config-selected with a contract-test
  file (Playbook failure protocol) before enablement.

## Consequences
- UEMOA-wide: the same rail covers all 8 XOF countries → Wave-2 launches stay config-only.
- KYC alias registration for sellers/riders happens at Tier 1/2 onboarding.
