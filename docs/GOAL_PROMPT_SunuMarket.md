# GOAL PROMPT — SunuMarket
### Social-Commerce Marketplace + Pan-African Mobile Money + GPS Delivery Network (Web + Mobile)
**Version:** 3.0 · **Date:** 2026-08-20 · **Working name:** SunuMarket — rename freely
**Usage:** Paste this entire file as the mission prompt for an autonomous AI build agent (Claude Code / Cowork or equivalent). Pair with `AUTONOMOUS_BUILD_PLAYBOOK.md` v3.0 (process authority).
**What changed vs v2:** grounded in a **deep assessment of the African / mobile-money reality (2026)** — §3. The payment layer is upgraded from "a registry behind one aggregator" to a **pan-African payment architecture**: per-country method matrices, dual-aggregator routing with failover, the BCEAO **PI-SPI interoperable instant-payment rail**, USSD-confirmation UX, settlement reconciliation, tiered KYC, fraud defenses tuned to documented African fraud patterns, and a **Country Config Pack** mechanism so new countries launch as data, not code.

---

## 1. Mission Statement

Build, test, and validate a production-ready **web app (PWA) and mobile app (Android-first, iOS-ready)** that lets micro-businesses — especially TikTok/social sellers in Africa — publish products, receive orders, **get paid through the payment methods that actually dominate their country**, and get orders delivered to a **GPS-pinned point** by themselves, an independent rider, or an affiliated delivery partner.

**Definition of success:** ready-to-market when (a) a seller onboards and publishes in <10 min unaided, (b) a buyer completes a paid order with any configured method — including surviving a failed attempt, an aggregator outage, and a USSD confirmation flow — to a GPS delivery point, (c) an independent rider closes a COD order end to end with cash reconciled, and (d) all Playbook gates are green.

---

## 2. Problem & Context (unchanged core)

Micro-sellers run commerce in TikTok/Instagram/WhatsApp comments and DMs: lost orders, price disputes, no stock control. The two structural frictions attacked head-on: **payment fragmentation** (buyer and seller rarely share a wallet) and **addressing** (no reliable street addresses → GPS pin + landmark is the real address format). Delivery is informal (self / known moto rider / courier company) — the platform supports all three. Launch: **Senegal, Côte d'Ivoire, Burkina Faso**; FCFA; French-first, English toggle; low-end Android; intermittent connectivity; TikTok-native sharing.

---

## 3. DEEP ASSESSMENT — Africa & Mobile Money Reality (2026) → Design Consequences

Binding analysis. Every finding maps to a design consequence (**⇒ DC-n**) enforced in requirements and the Playbook.

### 3.1 Market scale & behavior
- Sub-Saharan Africa processed ≈ **$1.4 trillion** of mobile-money value in 2025 (≈ two-thirds of global MM value; ~92 billion transactions; ~1.2 billion registered accounts on the continent). MM **is** the payment system, not an alternative. **⇒ DC-1:** MM is the primary rail; cards are a minority method (diaspora/ceremonial), never the default UI path.
- Only **~26% of registered accounts are active monthly**; digital-financial-literacy gaps are a leading blocker. **⇒ DC-2:** checkout must teach as it sells — method logos users recognize, 1-screen flows, plain-language French microcopy ("Vous allez recevoir une demande de confirmation sur votre téléphone"), and a first-payment guided mode. **⇒ DC-3:** never assume the buyer's wallet has balance — failure UX must be graceful, retryable, and suggest cash-in via agent ("rechargez chez un agent puis réessayez — la commande reste réservée 30 min").
- Users routinely hold **2–3 wallets simultaneously** and choose per-transaction on fees. **⇒ DC-4:** retry-with-another-method on the same order is a first-class flow, not an edge case; method choice is remembered per buyer but never locked.

### 3.2 Country method landscape (V1 + expansion waves) — drives the Method Matrix (FR-13)
| Country (wave) | Dominant methods (order matters) | Notes binding the build |
|---|---|---|
| 🇸🇳 Senegal (V1) | **WAVE (~55–60%)**, **ORANGE_MONEY (~25%)**, MIXX_BY_YAS (ex-Free Money), + COD, PI_SPI, CARD | Wave has no full self-service merchant API — reach it **via aggregator or Wave Business dynamic QR**; OM merchant onboarding is slow (weeks) — start early; new MM **transaction-tax pressure** (see 3.5). |
| 🇨🇮 Côte d'Ivoire (V1) | **WAVE + ORANGE_MONEY (~85% combined)**, MTN_MOMO, MOOV_MONEY, + COD, PI_SPI, CARD | Four-operator market — matrix must show ≥3 methods. |
| 🇧🇫 Burkina Faso (V1) | **ORANGE_MONEY**, **MOOV_MONEY**, Coris Money (bank wallet), + COD, PI_SPI | No Wave; lower smartphone penetration → USSD-confirm UX and SMS notifications weigh more here. |
| 🇲🇱 Mali · 🇹🇬 Togo · 🇧🇯 Benin · 🇳🇪 Niger (Wave 2, config-only) | ML: OM+MOOV; TG: MIXX_BY_YAS (ex-T-Money)+MOOV(Flooz); BJ: MTN+MOOV+CELTIIS; NE: airtel/moov/zamani mix | Same currency (XOF) + PI-SPI ⇒ launchable as **Country Config Packs** with zero new code (DC-9). |
| 🇬🇭 Ghana · 🇳🇬 Nigeria · 🇰🇪 Kenya (Wave 3, design-ready only) | GH: MTN_MOMO dominant (GHS); NG: **instant bank transfer (NIP)** + OPay/PalmPay dominate, MM secondary (NGN); KE: M-PESA (KES) | **⇒ DC-5:** money is stored as integer minor units + ISO currency code from day 1; the registry must support a `BANK_TRANSFER_INSTANT` method type (Nigeria) and non-XOF currencies without refactor. Not launched in V1. |

### 3.3 Interoperability — PI-SPI changes the game (UEMOA)
- The BCEAO launched **PI-SPI** (Plateforme Interopérable du Système de Paiement Instantané) on 30 Sept 2025: instant (<10 s), 24/7, **interoperable transfers between banks, e-money issuers (incl. Wave, OM), microfinance and payment institutions across all 8 UEMOA countries**; participation mandatory for regulated actors since **30 June 2026**; consumer-side transfers free or near-free; 80+ institutions live.
- **⇒ DC-6:** add **PI_SPI as a method** (pay-by-alias/QR through any participating wallet or bank app) *and* as the **preferred payout rail** (seller payouts and rider remittances become instant, wallet-agnostic, near-zero cost). **⇒ DC-7:** PI-SPI also de-risks the "buyer's wallet ≠ seller's wallet" problem structurally — checkout copy can say "payez depuis n'importe quel portefeuille".
- Interop momentum is continental (bank↔wallet flows grew ~35–37% in 2025; PAPSS for cross-border). Cross-border buying stays **V2**, but the ledger models currency + corridor from day 1 (DC-5).

### 3.4 Fraud reality (documented industry-wide)
- **Identity fraud hit ~90% of MM providers; social-engineering scams ~88%**; estimated ~$4B/year siphoned from African economies; fake "payment received" SMS/screenshots are an endemic scam against small sellers.
- **⇒ DC-8 (fraud defense pack, binding):**
  1. `paid` **only** via server-verified provider webhook or PI-SPI confirmation — never SMS, never screenshot, never client claim (already core; now doubly justified).
  2. `MANUAL_TRANSFER` (screenshot-proof method) is **default OFF**, admin-enabled per country only where aggregator coverage is missing; when on, proof is advisory — seller must confirm actual wallet balance; in-app warning explains fake-SMS scams.
  3. OTP hardening vs SIM-swap: device binding, re-verification + cool-down on new-device login for accounts with balance/payout rights, optional payout PIN.
  4. In-product scam education: one-time seller onboarding card ("Ne livrez jamais sur la base d'un SMS ou d'une capture d'écran — attendez le statut PAYÉ dans l'app") and rider card for COD counterfeit-cash basics.
  5. Velocity rules & anomaly flags (many failed payments, mass account creation from one device) feeding the admin review queue.

### 3.5 Regulation, tax & compliance (UEMOA-first)
- Platform must **never hold client funds outside licensed rails** — all pay-in/pay-out flows through licensed aggregators / e-money issuers / PI-SPI participants; SunuMarket stays a technical intermediary (avoids e-money licensing). **⇒ DC-10.**
- **Transaction taxes on MM are live or looming** (Senegal, Mali, Cameroon precedents; Ghana's e-levy was abolished in 2025 after damaging usage) and demonstrably push users back to cash. **⇒ DC-11:** a per-country **tax/fee pass-through config** (who bears which fee: platform / seller / buyer; displayed transparently pre-payment) and COD must remain a permanently supported method — cash resilience is a feature, not a failure.
- Data protection: CDP (Sénégal), ARTCI (CI), CIL (BF) — GDPR-inspired. Location data is sensitive: consent per capture, encryption, retention truncation (already FR-25). **⇒ DC-12:** add a per-country compliance checklist artifact to release gates (DPA registration references, localized ToS/privacy, prohibited-items list per jurisdiction).
- **Tiered KYC** aligned with BCEAO e-money practice: Tier 0 buyer (phone only) → Tier 1 seller payout (ID) → Tier 2 high-volume seller / rider handling COD (ID + address/vehicle). Payout and COD limits per tier, configurable. **⇒ DC-13.**

### 3.6 Device, network & channel reality
- Dominant device: low-cost Android (1–2 GB RAM, Android Go common); data is expensive; connectivity intermittent; **USSD remains the confirmation channel for Orange/MTN/Moov payments** (buyer receives a USSD push or must dial e.g. `#144#` to approve).
- **⇒ DC-14:** checkout for USSD-confirmed methods shows an explicit "confirm on your phone" state with the operator's dial code, countdown, resend, and "switch method" escape. **⇒ DC-15:** data-saver mode (no autoplay, thumbnail-first), total page ≤ 300 KB initial, APK < 40 MB (already NFR); SMS remains a notification fallback for buyers/riders without data. Full USSD storefront = V2/BACKLOG.
- Agent networks (cash-in/out points) are the physical backbone. **⇒ DC-3** (cash-in guidance) and rider remittance guidance reference agents.

### 3.7 Trust & commerce culture
- Social commerce runs on relationships and voice; COD persists because trust is asymmetric. **⇒ DC-16:** trust artifacts (verified badge, completed-order count, delivery-proof, ratings incl. rider) + "call/WhatsApp" one-taps everywhere remain load-bearing product features, and the platform's pitch to sellers leads with *"le prix est verrouillé et le paiement est prouvé"*.

---

## 4. Stakeholder Committee — v3 addendum
The v2 eleven-stakeholder committee stands. Re-convened on the assessment, it adds four arbitrated decisions:
1. **Dual-aggregator strategy** (e.g., two of PayDunya / CinetPay / Bizao / Flutterwave class): per-method primary + fallback, health-checked routing; no single point of failure for money-in (⇒ FR-14b).
2. **PI-SPI adapter** as method + payout rail (⇒ FR-13, FR-20).
3. **Country Config Pack** as the expansion unit: methods matrix, taxes/fees pass-through, KYC tier limits, phone formats (+221/+225/+226 validation), zone GeoJSON, language defaults, compliance checklist — all data (⇒ FR-49).
4. **Settlement reconciliation** is an operator non-negotiable: daily automated match of aggregator settlement reports vs internal ledger (⇒ FR-19b).

---

## 5. Personas (add one)
Awa (Dakar seller, Wave), Yao (Abidjan buyer, OM, pin+landmark), Moussa (Ouaga rider, Moov, COD), DiaLog Express (partner), Admin Fatou — unchanged — plus:
- **Tantie Rokia, 41, Bamako (Wave-2 test persona)** — buys via her daughter's phone, Orange Money, confirms payments by USSD, needs the DC-14 flow and SMS notifications.

---

## 6. Functional Requirements (v3 — deltas marked ★; unchanged FRs carried from v2 by number)

FR-1…FR-12 (onboarding, shop, catalogue, marketplace, cart) — **unchanged from v2.**

### D. Payments — pan-African architecture
- ★FR-13: **Payment Method Matrix** (replaces flat registry): methods available per **Country Config Pack**, ordered by market share (§3.2 table is the seed data); seller enables a subset; checkout shows the intersection, dominant methods first. V1 method types: `WAVE`, `ORANGE_MONEY`, `MTN_MOMO`, `MOOV_MONEY`, `MIXX_BY_YAS`, `PI_SPI`, `CARD`, `COD`, `MANUAL_TRANSFER` (default OFF, DC-8.2). Schema-ready (not launched): `MPESA`, `BANK_TRANSFER_INSTANT`, `AIRTEL_MONEY`.
- ★FR-14: `PaymentProvider` interface per aggregator; **dual-aggregator routing**: per country+method a primary and fallback provider; health checks + circuit breaker auto-route new attempts to fallback on outage; `paid` only on server-verified signed webhook (or PI-SPI confirmation), idempotent. USSD-confirmed methods implement the **DC-14 confirmation UX** (dial-code hint, countdown, resend, switch-method).
- ★FR-15: `MANUAL_TRANSFER` hardened per DC-8.2 (default OFF; advisory proof; unique reference; seller balance-check confirm step; scam warning interstitial).
- FR-16 (COD), FR-17 (attempts, retry-with-other-method, 30-min expiry restoring stock once) — unchanged, elevated by DC-4.
- FR-18 (refunds per method) — unchanged; PI-SPI refunds via reverse instant transfer where supported.
- ★FR-19: double-entry ledger — now **multi-currency-ready** (integer minor units + ISO code, XOF at launch, DC-5) and fee-aware (gross, provider fee, tax pass-through, net per DC-11 config).
- ★FR-19b: **Settlement reconciliation**: daily job ingests aggregator settlement reports (CSV/API), matches to ledger, flags discrepancies to an admin queue with aging; month-end close report.
- ★FR-20: payouts & rider remittances prefer the **PI-SPI rail** (instant, wallet-agnostic) with aggregator payout as fallback; tiered limits per KYC tier (DC-13); payout PIN optional (DC-8.3).

### E. Delivery points (GPS) — FR-21…FR-25 **unchanged from v2** (pin+landmark mandatory, 3 capture methods, saved points, zone/radius fee engine, nav deep links, location privacy).

### F. Delivery network — FR-26…FR-35 **unchanged from v2** (SELF/RIDER/PARTNER, dispatch broadcast first-accept, rider KYC-lite → now mapped to KYC Tier 2 (DC-13), proof of delivery, partner adapter + dashboard, tracking, incidents, COD reconciliation, delivery ratings). ★Addendum FR-34b: rider remittance via **PI-SPI** or agent cash-deposit guidance; counterfeit-cash education card (DC-8.4).

### G. Orders — FR-36…FR-38 unchanged.

### H. Trust & compliance — FR-39…FR-41 unchanged, plus:
- ★FR-41b: fraud defense pack per DC-8 (device binding, new-device re-verify, velocity rules, anomaly queue, scam-education cards).
- ★FR-41c: per-country compliance checklist artifact (DC-12) required at release gate.

### I. Admin — FR-42…FR-44 unchanged, plus:
- ★FR-44b: config panels extended: method matrix per country, provider routing (primary/fallback), tax/fee pass-through, KYC tier limits, MANUAL_TRANSFER toggle, reconciliation queue.

### J. Platform — FR-45…FR-48 unchanged, plus:
- ★FR-49: **Country Config Pack** — one versioned data bundle per country (methods, providers, taxes, KYC limits, phone regex, zones GeoJSON, language default, compliance checklist, SMS sender IDs). Activating a Wave-2 country = loading a pack + credentials, **zero code**.
- ★FR-50: data-saver mode + SMS notification fallback (DC-15); first-payment guided mode (DC-2).

## 7. Non-Functional Requirements — v2 NFR-1…7 stand, amended:
- ★NFR-2: money-in resilience — aggregator failover ≤ 60 s detection; no order lost during provider outage (queued attempts).
- ★NFR-3: adds SIM-swap mitigations (device binding, re-verify) and webhook signature isolation per provider.
- ★NFR-8 (new): **expansion NFR** — adding a UEMOA country must require only a Country Config Pack + credentials (proven by test, see Playbook Phase 12).

## 8. Non-Goals (V1)
As v2 (cross-seller cart, live GPS streaming, route optimization, buyer wallets, multi-currency **checkout**, iOS submission, ads, own tiles) **plus**: cross-border purchases, USSD full storefront, Wave-3 country launches (design-ready only), crypto/stablecoins.

## 9. Recommended Stack — v2 stands, amended:
- Money types: `bigint` minor units + currency code everywhere; `dinero.js`-style value objects in `packages/shared`.
- `PaymentProvider` implementations: `MockPaymentProvider` (all methods × success/failure/timeout/late-webhook/USSD-pending), `AggregatorA`, `AggregatorB` (thin, config-mapped), `PiSpiProvider` (mock + real), routing layer with health/circuit-breaker (BullMQ + Redis).
- Reconciliation worker: settlement-report ingestion (CSV/API) + matcher.
- Country Config Packs: versioned JSON + GeoJSON in `packages/config/countries/{sn,ci,bf,...}`, validated by Zod, hot-loadable.

## 10. Success Factors & KPIs — v2 stands, amended/added:
- Payment: ≥ 70% MM attempt success **per method** (tracked separately); < 5% of paid orders touched the fallback aggregator in steady state (else investigate primary); reconciliation discrepancies < 0.5% of volume, cleared < 72 h.
- Adoption realism (DC-2): ≥ 50% of first-time buyers complete payment without abandoning at the USSD-confirm step.
- Tax resilience (DC-11): COD share monitored per country as a market-health signal, not suppressed.
- Engineering gates: as v2 **plus** golden paths 9–10 green, reconciliation job proven, Wave-2 config-pack drill passed (NFR-8).

## 11. Golden Paths (v3 — 10 canonical E2E scenarios, automate all)
1–8 as v2 (onboard · OM-to-pin · method fallback WAVE→MTN · manual transfer (only in a pack where enabled) · rider COD full cycle · partner delivery · delivery issue+refund · stock race + offline pin).
9. ★**Aggregator outage:** primary provider down mid-checkout → circuit breaker → same order retried via fallback provider → paid; next-day settlement reports from both providers reconcile to the ledger with zero discrepancy.
10. ★**PI-SPI end-to-end:** buyer pays via PI-SPI from a non-partnered wallet → instant confirmation → order paid; later, seller payout and Moussa's COD remittance both settle over the PI-SPI rail; Tantie Rokia variant: Orange Money with USSD-confirm screen (DC-14) completes without abandonment.

## 12. Operating Instructions to the Autonomous Agent
As v2 (Playbook = process authority; mock-first everything; TDD on money/stock/dispatch; ADR every deviation; a phase closes only green) **plus**:
- §3's design consequences DC-1…DC-16 are **binding requirements**; trace them in `/docs/TRACEABILITY.md` alongside FRs.
- Seed the Method Matrix and Country Config Packs directly from the §3.2 table.
- Market-share figures in §3 are planning inputs, not runtime constants — keep them in config, dated, and easy to revise.
