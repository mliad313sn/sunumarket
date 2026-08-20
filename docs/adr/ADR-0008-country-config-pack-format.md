# ADR-0008 — Country Config Pack format, versioning, hot reload

**Status:** accepted · **Date:** 2026-08-20 · **Refs:** FR-49, NFR-8, DC-9, DC-11, DC-13

## Decision
- One versioned JSON document per country in `packages/config/countries/{cc}.json`,
  Zod-validated (`countryPackSchema`), plus zone GeoJSON files referenced by path.
- Shape (summary): `country, version, currency, language_default, phone` (regex + example),
  `methods[]` (ordered by market share; type, enabled, ussd_dial_code?, notes),
  `provider_routes[]` (method → primary/fallback provider code),
  `fees_taxes` (pass-through config: bearer per fee kind, display strings),
  `kyc_tiers` (per-tier payout/COD limits in minor units),
  `sms_sender_ids`, `compliance_checklist[]`, `zones_ref`.
- Market-share figures live in `methods[].market_share_note` as **dated planning inputs**,
  never runtime constants (Goal §12).
- DB table `country_packs` stores the active version; the loader hot-reloads on version
  bump (admin action or file change) — checkout config flips **without restart**.
- Activating a new UEMOA country = add pack + provider credentials (env). Zero code
  (NFR-8; proven by the Phase 12 Mali drill).

## Consequences
- Wave-2 drafts (`ml, tg, bj, ne`) ship in Phase 2 to prove the format.
- Packs are data → reviewed like code (PR + validation CI step).
