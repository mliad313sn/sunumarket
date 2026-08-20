# TRACEABILITY — FR-1…FR-50 · DC-1…DC-16

Phase 1 artifact; updated at each phase gate. Status: `planned → built → verified`.
FR-1…12 / 21…48 are carried from v2 by number (Goal §6); v2 text is not in-repo, so their
scope is reconstructed from v3 references — recorded as a deviation in `DECISIONS.log`.

## Functional requirements

| FR | Scope (v2-carried titles inferred) | Where (endpoint / screen / module) | Test anchor | Phase | Status |
|----|-----------------------------------|-------------------------------------|-------------|-------|--------|
| FR-1..3 | Onboarding: phone OTP signup, profile, roles | `POST /auth/otp`, `/auth/verify`; onboarding screens | auth suite | 3 | verified |
| FR-4..6 | Shop create wizard (≤5 steps), shop page, sharing | `POST /shops`, `GET /shops/:slug`; web wizard | wizard timed test | 4 | verified |
| FR-7..9 | Catalogue: product ≤60 s from photos, images ≤200 KB, stock | `POST /products`; compression pipeline | 3G-throttle test | 4 | verified |
| FR-10..12 | Marketplace browse/search, product page, cart (single-seller) | `GET /marketplace`, `GET /products/:id`; cart screen | e2e path 2 | 4 | verified |
| FR-13 | Payment Method Matrix per Country Config Pack | `packages/config` packs + `GET /checkout/methods` | matrix test: SN Wave-first, BF no-Wave | 2/7 | verified |
| FR-14 | PaymentProvider interface; dual-aggregator routing, breaker, webhook-only paid | `packages/shared/payments`; `POST /webhooks/:provider` | failover = path 9.1; replay ×5 | 7 | verified |
| FR-15 | MANUAL_TRANSFER hardened (DC-8.2) | attempt flow + interstitial screen | path 4 + forged-ref rejection | 7 | verified |
| FR-16 | COD method | attempt kind `COD`; settles Phase 9 | path 5 | 7/9 | verified |
| FR-17 | Attempts, retry-other-method, 30-min expiry restores stock once | attempts model + expiry job | path 3; expiry-once test | 7 | verified |
| FR-18 | Refunds per method (incl. PI-SPI reverse) | `POST /orders/:id/refund` | refund suite; path 7 | 8 | verified |
| FR-19 | Double-entry multi-currency ledger, fee/tax-aware | `packages/shared/ledger` | Σd=Σc property, 1000-order fuzz | 8 | verified |
| FR-19b | Settlement reconciliation daily job + admin queue | reconciliation worker + matcher | path 9.2; corrupted-line flag | 8 | verified |
| FR-20 | Payouts & remittances PI-SPI-first, tier limits, payout PIN | `POST /payouts`; PiSpiProvider.transfer | path 10 payout leg; tier-limit test | 8 | verified |
| FR-21..25 | Delivery points: pin+landmark mandatory, 3 capture methods, saved points, zone/radius fee engine, nav deep links, location privacy/retention | GeoService; `POST /delivery-points`; fee resolver | 20-pin fixture suite; airplane capture; retention job | 5 | verified |
| FR-26..35 | Delivery network: SELF/RIDER/PARTNER, broadcast first-accept, rider KYC→Tier 2, proof, partner adapter+dashboard, tracking, incidents, COD reconciliation, ratings | dispatch machine; `DeliveryPartnerAdapter`; rider PWA | dispatch race; COD invariant; paths 5–7 | 9 | verified |
| FR-34b | Rider remittance via PI-SPI or agent guidance; counterfeit-cash card | remittance flow | PI-SPI remittance test | 8/9 | verified |
| FR-36..38 | Orders: state machine, inbox, tracking | order machine; `POST /orders`; tracking token | 100% transition coverage; race test | 6 | verified |
| FR-39..41 | Trust: ratings, verified badge, reports/takedowns | ratings/disputes endpoints | post-delivered gating test | 10 | verified |
| FR-41b | Fraud defense pack (DC-8) | device binding, velocity rules, anomaly queue | 10-fails-in-5-min flag test; SIM-swap scenario | 3/8/12 | verified |
| FR-41c | Per-country compliance checklist at release gate | `docs/compliance/{sn,ci,bf}.md` | gate-12 review | 12 | built (checklists shipped; DPA filings pending) |
| FR-42..44 | Admin: dashboards, global phone search, timelines, audit log | admin app + endpoints | support-scenario e2e | 10 | verified |
| FR-44b | v3 config panels: matrix, routes, taxes, KYC limits, MANUAL_TRANSFER toggle, reconciliation queue | admin config screens | flip-route/no-deploy test | 10 | verified |
| FR-45..48 | Platform: PWA offline, i18n FR/EN, analytics events, perf budgets | service worker; i18n; `track()` | Lighthouse CI; airplane tests | 11 | built (Lighthouse CI deferred to staging) |
| FR-49 | Country Config Pack as expansion unit | `packages/config/countries/*` + loader + `country_packs` | pack validation; hot-reload test; Mali drill | 2/12 | verified |
| FR-50 | Data-saver mode + SMS fallback + first-payment guided mode | web data-saver; sms_outbox; guided checkout | USSD-abandonment event test | 7/11 | verified |

## Design consequences (binding — Goal §3)

| DC | Consequence | Enforced by | Phase |
|----|-------------|-------------|-------|
| DC-1 | MM primary rail; card never default UI path | Method matrix ordering from packs (FR-13) | 2/7 |
| DC-2 | Checkout teaches: logos, 1-screen, plain FR microcopy, first-payment guided mode | checkout UI + FR-50 | 7/11 |
| DC-3 | Graceful balance-failure UX + agent cash-in guidance, 30-min reservation | DC-14 screen failure branch | 7 |
| DC-4 | Retry-with-another-method first-class; remembered non-locking default | FR-17 attempts model + checkout | 7 |
| DC-5 | Integer minor units + ISO currency everywhere; BANK_TRANSFER_INSTANT/non-XOF schema-ready | `Money` (built, tested); method enum | 0/2 |
| DC-6 | PI_SPI as method + preferred payout rail | ADR-0006; FR-13/20 | 7/8 |
| DC-7 | "Pay from any wallet" copy via PI-SPI | checkout copy | 7 |
| DC-8 | Fraud pack: webhook-only paid; MANUAL_TRANSFER off-default; OTP/SIM-swap hardening; scam education; velocity rules | ADR-0010/0012; FR-15/41b | 3/7/8 |
| DC-9 | Wave-2 countries as config packs, zero code | ADR-0008; FR-49; NFR-8 drill | 2/12 |
| DC-10 | Never hold client funds outside licensed rails | Architecture (no internal wallet); ledger models flows only | 1+ |
| DC-11 | Tax/fee pass-through config per country; COD permanent | pack `fees_taxes`; FR-19 splits | 2/8 |
| DC-12 | Per-country compliance checklist artifact at release gates | FR-41c | 12 |
| DC-13 | Tiered KYC 0/1/2 with pack limits | ADR-0009; FR-20 | 3/8 |
| DC-14 | USSD confirm UX: dial code, countdown, resend, switch-method | checkout screen + `ussd_pending` states | 7 |
| DC-15 | Data-saver, ≤300 KB initial, APK <40 MB, SMS fallback | FR-50; perf budgets in CI | 11/12 |
| DC-16 | Trust artifacts + call/WhatsApp one-taps; "prix verrouillé, paiement prouvé" | shop/product/order screens | 4/10 |

## Golden paths

All 10 paths automated and green in `e2e/tests/golden-paths.e2e.ts` (consolidated black-box HTTP
suite; the Mali expansion drill rides in the same file). Per-path anchors also exist in the api
integration suites (payments.phase7 / reconciliation.phase8 / delivery.phase9).
