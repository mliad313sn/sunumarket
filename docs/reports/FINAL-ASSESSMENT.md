# FINAL COMMITTEE ASSESSMENT — SunuMarket V1 (post UI-elevation)

> Convened 2026-08-21 against commit `fe7e75f` (final product: 13 phases complete, first
> committee remediation applied, privacy delete shipped, buyer/rider/admin UI elevation done).
> Method: three independent code audits (money/reconciliation · buyer/seller/rider experience ·
> security/ops/compliance/partner/KPI) over the **actual code paths**, not prior reports.
> Baseline re-verified before assessment: lint + typecheck clean, 180 DB tests, e2e 13/13,
> invariants 8/8.
>
> Verdicts per finding: **FIXED** (remediated in this round, regression-tested),
> **RECORDED** (real gap, deliberately deferred with rationale — tracked in BACKLOG.md),
> **ACCEPTED** (conscious design trade-off, documented).

## Seat-by-seat verdicts

### 1. CFO — money, ledger, reconciliation

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| C1 | Dispute resolved in buyer's favour releases the seller payout freeze **before** the refund executes, and the refund error is silently swallowed — a failed refund leaves the seller paid for a lost dispute | Critical | FIXED |
| C2 | Refund is non-atomic (order marked `refunded` before provider+ledger succeed) and non-idempotent (2nd call → 500); `succeeded_late` attempts unrefundable | Critical | FIXED |
| C3 | Payout double-spend window: balance check and payout creation run without any lock — two concurrent requests can overdraw an append-only ledger | Critical | FIXED |
| C4 | PI-SPI rail failure still marks the payout `settled` and debits the ledger (fallback was a dead in-memory array) | Critical | FIXED |
| C5 | Reconciliation `ingestCsv`/`runMatch` had **no route and no worker job** — in production nothing would ever ingest settlement files; close report would claim 100% matched over zero batches | High | FIXED |
| C6 | Reconciliation flag resolution had no reason, no actor, no audit row | High | FIXED |
| C7 | Rider COD remittance not idempotent (dup lookup discarded) and never posted to the double-entry ledger | High | FIXED (idempotency); ledger posting RECORDED (V2 with rider ledger accounts) |
| C8 | No partial refunds (amount-less contract), no split dispute resolution | Medium | RECORDED — V2; full-refund path is correct and V1 golden paths never need partials |
| C9 | `provider_fee` is one flat country-wide bps — real Wave/Orange cost differentials and effective-dated rates unmodellable | Medium | RECORDED — pack schema extension planned with real adapters |
| C10 | Payouts carry no fee and counter-account is `buyer_funds` (semantically wrong for treasury) | Medium | RECORDED — payout fee schedule + platform cash account with real rails |
| C11 | No-float-money lint rule only covered `packages/shared/src/money` — honour-system where money actually moves | Medium | FIXED (scope extended to api ledger/payments/payouts/reconciliation modules) |
| C12 | `ledger_transactions` parent rows had no immutability trigger (children did) | Medium | FIXED (trigger migration) |
| C13 | Hardcoded `"XOF"` in orders/payouts/remittance/recon-ingest instead of pack currency | Medium | RECORDED — all 7 launch packs are XOF (UEMOA); flagged as the single blocking work item for any non-XOF pack (e.g. Ghana/Nigeria), with `z.literal("XOF")` edge guards making the assumption explicit and safe rather than silent |
| C14 | Invariants script lacked negative-seller-balance and refund-follows-dispute checks | Medium | FIXED (now 10 checks) |

DC-5 (bigint minor units everywhere — zero float-money hits) and DC-8.1 (`paid` only via
verified webhook / PI-SPI / documented COD+manual exceptions) were **re-verified clean**.

### 2. Buyers — Yao & Tantie Rokia

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| B1 | No order-confirmation SMS: the tracking link existed only in the HTTP response — close the browser, lose the order forever (worst for COD: first SMS ever was the proof code) | High | FIXED — order creation now sends SMS with tracking link via outbox |
| B2 | Buyer cannot cancel: state machine allowed it but no route/service/UI existed — mis-orders locked stock for 30 min | High | FIXED — cancel via tracking token while `payment_pending`, stock restored, wired into tracking page |
| B3 | Dispute + rating APIs complete but zero UI wiring; the delivered SMS **promised** rating via the tracking link which had no rating control | High | FIXED — tracking page now has dispute + rating controls (guest, via `guest_phone`) |
| B4 | Tracking page leaked raw English enums (`payment_pending`, `delivery_issue`…) to a French-first, low-literacy audience | Medium | FIXED — status labels via i18n dictionary |
| B5 | No buyer order history / account (tracking links are the only handle) | Medium | RECORDED — V1 is deliberately guest-first (DC-15/low-literacy); B1's SMS makes the link durable; account-based history is V2 |

### 3. Seller — Awa

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| S1 | **No seller-facing UI existed at all** — shop/product/orders/payout were API-only (the intended surface was the descoped Expo app); Awa could not onboard without a developer | Critical (beta-blocking) | FIXED (minimal) — seller space in the web PWA: OTP login, shop overview, product + stock management, order inbox, balance + payout request. Full seller experience remains the Expo deliverable (BACKLOG top item) |

### 4. Rider — Moussa

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| R1 | Incident-reporting orphaned the job: no dispatch-machine edge back to `broadcasting`, rider cleared client-side, no one notified — order stuck in `delivery_issue` until an admin noticed | High | FIXED — `failed_attempt → broadcasting` edge added (shared machine + tests), incident re-broadcasts with rider cleared and seller notified by SMS |
| R2 | Rider saw only COD cash owed (a liability), never earnings; delivery fees were never credited anywhere; `/balance` returned the seller account for riders | High | FIXED (visibility) — cash endpoint now returns cumulative delivered-fee earnings, shown in rider PWA. Ledger-backed rider accounts RECORDED (V2, with C7's remittance posting) |
| R3 | Rebroadcast sweep event-ids keyed on `Date.now()` — crash mid-loop could double-fire seller escalation | Low | FIXED — deterministic per-round event ids |
| R4 | Rider PWA auth is paste-token (dev flow) | Medium | ACCEPTED for sandbox — OTP login ships with the Expo app (already in RTM §5) |

### 5. Delivery partner — DiaLog

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| P1 | **All partners shared one webhook HMAC secret** (`webhook_secret_ref` column existed but was never read) — partner A could sign payloads driving partner B's jobs to `delivered` | Critical | FIXED — per-partner secret resolution from `webhook_secret_ref` (env-indirected), bad-signature now also records a fraud event |
| P2 | Partner read-side isolation (own jobs only) | — | Re-verified OK |

### 6. Admin & support — Fatou

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| A1 | 4 of 5 admin decision categories (KYC review, fraud review, dispute resolution, recon-flag closure) wrote **no audit row and didn't even receive the admin's id** — only config flips were audited, contradicting the module's own docstring | High | FIXED — all four now write `audit_log` rows with actor, subject and outcome |
| A2 | Admin has no step-up auth (same 15-min OTP token as any user; `admin` bypasses every role guard) | Medium | RECORDED — hardening backlog (device-trust step-up exists for payouts and can be reused) |
| A3 | Admin console French-only hardcoded strings (no EN) | Low | ACCEPTED — internal FR-first operators tool |

### 7. Security

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| X1 | No HTTP-layer rate limiting anywhere; OTP throttle was per-phone only → SMS-pump cost attack by rotating numbers | High | FIXED — in-process fixed-window limiter on OTP request (per-IP) and webhook endpoints; Redis-backed shared limiter RECORDED with the existing multi-instance item |
| X2 | Payment webhooks had HMAC + eventId dedupe but no freshness bound (captured signature valid forever if the events table is ever rotated) | Medium | FIXED — `occurred_at` freshness window with fraud-event on stale |
| X3 | HMAC computed over re-serialized JSON (no raw-body plugin) — correct against mocks, breaks against byte-exact real providers | Medium | RECORDED — raw-body capture is item #1 of the real-adapter contract-test protocol (mock-first descope) |
| X4 | Dev-default secrets (`agg-a-secret`, `dev-secret-change-me`…) activate silently if env unset in production | Medium | FIXED — startup assertion refuses dev defaults when `NODE_ENV=production` |
| X5 | JWT: HS single static key, no `iss`/`aud`, roles snapshot valid ≤15 min after demotion; refresh rotation + family revocation solid | Low/Medium | RECORDED — hardening backlog |

### 8. Ops / SRE

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| O1 | Worker had **no liveness signal at all** — if it died, orders silently stopped expiring; `/health` was a static `ok` with no DB check | High | FIXED — worker heartbeat row per sweep; `/health` now checks DB and reports heartbeat age |
| O2 | SMS outbox is at-least-once (send-then-mark) — crash between the two re-sends | Low | ACCEPTED — at-least-once is the right trade-off for SMS; documented |
| O3 | Breaker/velocity/pack-override state per-instance in-memory | Medium | RECORDED (already RTM §5) — Redis-shared state before multi-instance staging |

### 9. Compliance / privacy

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| L1 | Anonymizing delete missed PII: seller's `shops.whatsapp_phone`/name, own-phone `orders.guest_phone`, `sms_outbox.body` text (contains names/addresses) | High | FIXED — scrub extended |
| L2 | `job_events.gps` (rider GPS trail) had no retention clock and no scrub, re-exposed to admins forever | High | FIXED — nulled by the retention sweep after the same configurable window as buyer pins |
| L3 | `ratings.comment` free text survives deletion | Low | RECORDED — needs author linkage design (ratings are guest-phone keyed) |
| L4 | Anonymize-not-delete model; DPA filings pending | — | ACCEPTED/RECORDED (already RTM §4.6) — legal review item |

### 10. KPI / growth

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| K1 | Funnel analytics client-only and lost (in-memory array, never drained, no ingest endpoint) — USSD-abandonment metric never reaches a server | Medium | RECORDED — server ingest + drain scheduled with staging observability; per-method success + paid-per-provider metrics already live server-side |
| K2 | Metrics route comment promised "fallback share" it didn't compute | Low | FIXED — comment corrected to what is exposed |

## Committee verdict

**GO for beta on mocks, reaffirmed — now without financial-correctness reservations.**
The assessment found that the product's domain core (money types, state machines, immutability,
DC-8.1) was sound, but four critical defects lived exactly where the first review didn't look:
the *edges* between subsystems (dispute→refund ordering, payout concurrency, partner secret
sharing, seller having no surface at all). All four are fixed and regression-tested in this
round. Everything deferred is recorded in BACKLOG.md with rationale; nothing was silently
dropped.

Production launch remains gated on the unchanged RTM §4 externals (real adapters + raw-body
contract tests, staging soak, Expo app, media pipeline, DPA filings).

## Remediation verification (this round)

Delivered in three sequenced passes, each behind the full gate:

1. **Money core** (`11af538`) — C1–C6, C11, C12, C14, X2 + 11-test regression suite
   `final.money.test.ts`.
2. **Platform** (`8a51442`) — P1, X1, X4, O1, L1–L2, R1–R3, B1–B2 (API side), C7, K2
   + 16-test regression suite `final.platform.test.ts`, two new migrations
   (`ledger_transactions` immutability trigger, `worker_heartbeats`).
3. **Frontend** — S1 (seller console in the web PWA: OTP login, create-shop, products/stock,
   order inbox, balance + payout), B2/B3/B4 on the tracking page (cancel, dispute, rating,
   translated statuses — ~90 new FR/EN i18n keys), R2 rider earnings line. Browser-walked
   end-to-end with playwright-cli: golden path re-verified with fresh evidence (01→07), seller
   space and tracking actions captured as `browser-evidence/08-seller-space.png` and
   `09-tracking-actions.png`; dispute + rating submitted as a guest and confirmed as DB rows.
   The walk surfaced and fixed three real defects (fixture-archive regex gap flooding the
   marketplace, header overflow at 360px making the language toggle unreachable,
   non-deterministic `GET /me/shop` shop selection).

**Final gate on the finished tree:** lint + typecheck clean · **209 unit/DB tests**
(shared 51 · config 12 · web 8 · api 138) · **e2e 13/13** · **invariants 10/10** zero rows ·
bundles web 57.89 KB + rider 49.04 KB + admin ~47.7 KB gz (budget ≤300 KB) · audit 0 vulns.
Contract additions during remediation: `GET /track/:token` now returns `order_id`, new public
`GET /cities`, `GET /me/shop`, `POST /track/:token/cancel`, admin reconciliation
ingest/run-match routes — all covered by tests and reflected where the OpenAPI document is
generated from the shared contracts.
