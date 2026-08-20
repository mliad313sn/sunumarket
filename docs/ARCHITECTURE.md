# SunuMarket — Architecture (C4)

Phase 1 deliverable. Product authority: `GOAL_PROMPT_SunuMarket.md` v3.0.

## C1 — System context

```mermaid
flowchart TB
    Buyer([Buyer — Yao / Tantie Rokia<br/>low-end Android, FR-first])
    Seller([Seller — Awa<br/>TikTok/WhatsApp social seller])
    Rider([Rider — Moussa<br/>moto, COD cash])
    PartnerOps([Delivery partner ops<br/>DiaLog Express])
    Admin([Admin — Fatou])

    SM[SunuMarket platform<br/>PWA + mobile + API]

    AggA[Aggregator A<br/>pay-in/pay-out<br/>Wave, OM, MTN, Moov, Mixx, Card]
    AggB[Aggregator B<br/>fallback routes]
    PISPI[BCEAO PI-SPI<br/>instant interoperable rail]
    SMSGW[SMS gateway<br/>OTP + notifications fallback]
    Maps[Maps/Waze deep links<br/>no own tiles]
    Social[TikTok / WhatsApp / Instagram<br/>share targets]

    Buyer --> SM
    Seller --> SM
    Rider --> SM
    PartnerOps --> SM
    Admin --> SM

    SM <--> AggA
    SM <--> AggB
    SM <--> PISPI
    SM --> SMSGW
    SM --> Maps
    SM --> Social
```

Money never rests inside SunuMarket (DC-10): all pay-in/pay-out flows through licensed
aggregators / e-money issuers / PI-SPI participants. SunuMarket is a technical intermediary.

## C2 — Containers

```mermaid
flowchart TB
    subgraph Clients
        Web[apps/web — buyer+seller PWA<br/>Vite React, FR/EN, data-saver, offline queue]
        RiderApp[apps/rider — rider PWA<br/>high contrast, offline status queue]
        AdminApp[apps/admin — console]
        Mobile[apps/mobile — Expo<br/>seller + rider tabs, FCM]
    end

    subgraph Backend
        API[apps/api — Fastify + Zod<br/>REST, OpenAPI from shared contracts]
        Workers[Workers — BullMQ<br/>dispatch broadcast, payment attempt queue,<br/>reconciliation ingest/match, retention truncation,<br/>SMS outbox, health probes]
        Redis[(Redis<br/>queues, circuit-breaker state, rate limits)]
        PG[(Postgres 16 + PostGIS<br/>append-only ledgers, zones, orders)]
        MinIO[(MinIO/S3<br/>product images, delivery proofs, KYC docs)]
    end

    subgraph PaymentLayer[Payment routing layer — FR-14]
        Matrix[Method Matrix<br/>from Country Config Pack]
        Router[Provider router<br/>primary/fallback + circuit breaker]
        PA[AggregatorA adapter]
        PB[AggregatorB adapter]
        PP[PiSpiProvider]
        WH[Webhook receivers<br/>per-provider signature isolation]
    end

    Web --> API
    RiderApp --> API
    AdminApp --> API
    Mobile --> API
    API --> PG
    API --> Redis
    API --> MinIO
    API --> Matrix --> Router
    Router --> PA & PB & PP
    PA & PB & PP -.webhooks.-> WH --> API
    Workers --> PG
    Workers --> Redis
```

`packages/shared` carries the pure domain core (Money, order/dispatch state machines,
routing + circuit breaker, ledger engine, reconciliation matcher, geo fee engine, Zod
contracts); `packages/config` carries versioned Country Config Packs (FR-49). Adapters are
thin and config-selected; mocks ship first (Playbook rule 0.5).

## Payment routing (FR-13/14, DC-14)

```mermaid
flowchart LR
    CO[Checkout] --> MM[Method Matrix<br/>pack ∩ seller-enabled,<br/>dominant methods first]
    MM --> RT{Router}
    RT -->|route healthy| P1[Primary provider]
    RT -->|breaker open| P2[Fallback provider]
    P1 & P2 --> INIT[attempt init]
    INIT -->|redirect / push| WALLET[Buyer wallet app / USSD approve]
    WALLET -.->|signed webhook| VER[verify signature + idempotency]
    VER -->|valid| PAID[order → paid]
    INIT -->|ussd_pending| UX[DC-14 screen: dial-code hint,<br/>countdown, resend, switch-method]
```

Circuit breaker per (provider, method): opens after N consecutive failures/timeouts
(≤60 s detection, NFR-2), half-open probe, closes on success. Every attempt records the
provider that served it (settlement reconciliation needs this).

## Reconciliation worker (FR-19b)

```mermaid
flowchart LR
    FILES[Provider settlement reports<br/>CSV / API, daily] --> ING[Ingest → settlement_batches/lines]
    ING --> MATCH[Matcher: exact provider_ref →<br/>fuzzy ref+amount+date ADR-0011]
    MATCH -->|matched| OK[line linked to ledger txn]
    MATCH -->|unmatched / mismatch| FLAG[reconciliation_flags<br/>admin queue with aging]
    FLAG --> CLOSE[month-end close report]
```

## Cross-cutting

- **Idempotency:** client-supplied idempotency keys on order/attempt creation; webhook
  events deduplicated by (provider, event_id); replays are no-ops (ADR-0012).
- **Fraud (DC-8):** `paid` only via verified webhook/PI-SPI confirm; device binding +
  new-device re-verify; velocity rules feed `fraud_events` → admin anomaly queue.
- **Privacy:** GPS points consent-gated, encrypted at rest, coordinates truncated after
  retention window (FR-25); phone-first identity; export/delete endpoints.
- **Offline:** PWA queues (order+pin capture, rider status) sync idempotently; SMS fallback
  for no-data users (DC-15).
