# SunuMarket — Sequence diagrams (Phase 1)

## 1. Webhook confirm (canonical paid path — DC-8.1)

```mermaid
sequenceDiagram
    participant B as Buyer
    participant API
    participant R as Router
    participant P as Provider (primary)
    B->>API: POST /orders/{id}/attempts {method, idempotency_key}
    API->>R: route(country, method)
    R-->>API: provider = primary (breaker closed)
    API->>P: init(attempt)
    P-->>API: {provider_ref, next: redirect|push}
    API-->>B: attempt initiated
    P--)API: POST /webhooks/{provider} (signed)
    API->>API: verify signature (per-provider secret)
    API->>API: dedupe (provider, event_id)
    API->>API: attempt → succeeded; order → paid; ledger txn (gross/fee/tax/net)
    API--)B: push/SMS "PAYÉ"
    Note over API: replayed webhook → outcome=duplicate, no state change
```

## 2. Failover mid-checkout (golden path 9, part 1)

```mermaid
sequenceDiagram
    participant B as Buyer
    participant API
    participant R as Router
    participant PA as AggregatorA
    participant PB as AggregatorB
    B->>API: create attempt (ORANGE_MONEY)
    API->>PA: init → timeout/5xx (xN)
    Note over R: breaker(AGG_A, OM) opens ≤60 s (NFR-2)
    API-->>B: attempt failed — "réessayer"
    B->>API: retry same order
    API->>R: route(SN, ORANGE_MONEY)
    R-->>API: fallback = AggregatorB (breaker open)
    API->>PB: init → ok
    PB--)API: signed webhook → paid
    Note over R: half-open probe → AggregatorA recovers → breaker closes
    Note over API: attempt rows record AGG_A(failed), AGG_B(succeeded) — reconciliation needs both
```

## 3. USSD-pending confirm (DC-14, Tantie Rokia variant of golden path 10)

```mermaid
sequenceDiagram
    participant B as Buyer (Orange Money)
    participant API
    participant P as Provider
    B->>API: create attempt (ORANGE_MONEY)
    API->>P: init
    P-->>API: {status: ussd_pending}
    API-->>B: DC-14 screen: "Confirmez sur votre téléphone"<br/>dial-code #144# (from pack), countdown 120 s,<br/>[Renvoyer] [Changer de méthode]
    alt buyer approves on USSD
        P--)API: webhook confirm → paid
        API--)B: "PAYÉ ✓"
    else timeout
        API-->>B: friendly retry + DC-3: "rechargez chez un agent —<br/>la commande reste réservée 30 min" + switch-method
    end
```

## 4. PI-SPI pay + payout (golden path 10)

```mermaid
sequenceDiagram
    participant B as Buyer (any wallet)
    participant API
    participant PS as PI-SPI
    participant S as Seller
    B->>API: create attempt (PI_SPI)
    API->>PS: create alias/QR request
    PS-->>API: {alias, qr}
    B->>PS: pays from any participating wallet/bank app
    PS--)API: instant confirmation (<10 s)
    API->>API: order → paid; ledger txn
    Note over API,S: later — payout run
    API->>PS: instant transfer to seller alias (rail=PI_SPI)
    PS-->>API: settled
    API->>API: payout ledger txn; fallback = aggregator payout if PI-SPI down
```

## 5. Settlement ingest & match (FR-19b, golden path 9 part 2)

```mermaid
sequenceDiagram
    participant W as Reconciliation worker
    participant P as Provider report (CSV/API)
    participant DB
    participant A as Admin queue
    W->>P: fetch daily settlement report
    W->>DB: insert settlement_batch + lines (append-only)
    loop each line
        W->>DB: match exact provider_ref
        alt exact hit
            W->>DB: link line → ledger txn (match_kind=exact)
        else fuzzy ref+amount+date (ADR-0011)
            W->>DB: link (match_kind=fuzzy)
        else no match
            W->>A: reconciliation_flag(unmatched_line, aging clock starts)
        end
    end
    W->>DB: cross-check: paid orders missing from file → flag(missing_order)
    W->>A: month-end close report
```

## 6. Manual-transfer review (FR-15, DC-8.2 — pack-gated, default OFF)

```mermaid
sequenceDiagram
    participant B as Buyer
    participant API
    participant S as Seller
    B->>API: attempt (MANUAL_TRANSFER) — only if pack enables it
    API-->>B: unique reference + scam-warning interstitial
    B->>API: upload proof (advisory only)
    API-->>S: order → payment_review + warning<br/>"Ne livrez jamais sur SMS/capture — vérifiez votre solde"
    S->>API: confirm actual wallet balance received
    API->>API: order → paid (marked manual, ledger txn)
    Note over API: forged/duplicate reference → rejected, fraud_event
```

## 7. Rider broadcast / first-accept (FR-26)

```mermaid
sequenceDiagram
    participant S as Seller
    participant API
    participant R1 as Rider 1..n
    participant B as Buyer
    S->>API: request delivery (mode=RIDER)
    API->>R1: broadcast dispatch_offers (zone-filtered)
    R1->>API: accept (first wins — race-protected)
    API-->>R1: job assigned; others → expired
    Note over API: no accept in T → re-broadcast wider → escalate PARTNER/SELF
    R1->>API: status flow: picked_up → en_route → arrived (GPS snapshots, offline queue)
    R1->>API: proof: photo or buyer OTP code
    API->>API: job → delivered; order → delivered
    API--)B: tracking updates (token link, SMS fallback)
```

## 8. COD remittance (FR-34b)

```mermaid
sequenceDiagram
    participant R as Rider (Moussa)
    participant API
    participant PS as PI-SPI
    R->>API: deliver COD order — proof gated
    API->>API: rider_cash_ledger += collected(total)
    Note over R: Σcollected − Σremitted = outstanding (cap per KYC tier 2)
    alt PI-SPI remittance
        R->>API: remit outstanding
        API->>PS: instant transfer rider→platform/seller
        PS-->>API: settled
        API->>API: rider_cash_ledger += remitted; seller ledger credited
    else agent cash deposit
        API-->>R: guidance: nearest agent deposit + reference
    end
    Note over API: counterfeit-cash education card shown once at rider onboarding (DC-8.4)
```
