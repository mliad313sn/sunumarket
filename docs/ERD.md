# SunuMarket — ERD (Phase 1)

Money columns are always `amount_minor BIGINT` + `currency CHAR(3)` (DC-5). Tables marked
**append-only** get DB-level immutability triggers (Phase 2): `ledger_entries`,
`rider_cash_ledger`, `settlement_lines`, `fraud_events`, `audit_log`.

```mermaid
erDiagram
    users ||--o{ device_bindings : has
    users ||--o{ kyc_records : has
    users ||--o{ shops : owns
    users ||--o{ delivery_points : saves
    users ||--o{ fraud_events : triggers
    users ||--o| riders : "may be"

    shops ||--o{ products : lists
    products ||--o{ product_images : has
    shops ||--o{ shop_payment_methods : enables

    cities ||--o{ zones : contains
    zones ||--o{ zone_fees : prices

    orders }o--|| shops : "sold by"
    orders ||--o{ order_items : contains
    orders ||--o{ payment_attempts : "paid via"
    orders ||--o| delivery_jobs : "fulfilled by"
    orders ||--o{ ratings : receives
    orders ||--o| disputes : "may raise"
    order_items }o--|| products : references

    payment_providers ||--o{ provider_routes : serves
    provider_routes }o--|| country_packs : "configured per"
    payment_attempts }o--|| payment_providers : "served by"
    payment_attempts ||--o{ webhook_events : confirms

    ledger_transactions ||--|{ ledger_entries : "balances (Σd=Σc)"
    ledger_entries }o--|| ledger_accounts : posts
    payment_attempts ||--o| ledger_transactions : records
    payouts ||--o| ledger_transactions : records

    settlement_batches ||--|{ settlement_lines : contains
    settlement_lines ||--o| reconciliation_flags : "may flag"
    settlement_batches }o--|| payment_providers : "from"

    riders ||--o{ dispatch_offers : receives
    delivery_jobs ||--o{ dispatch_offers : broadcasts
    delivery_jobs ||--o{ job_events : tracks
    riders ||--o{ rider_cash_ledger : "COD entries"
    delivery_jobs }o--o| partners : "or partner"

    users {
        uuid id PK
        text phone UK "E.164, pack-validated"
        text name
        text locale "fr|en"
        char2 country
        int kyc_tier "0|1|2 (DC-13)"
        text payout_pin_hash "nullable (DC-8.3)"
        timestamptz created_at
    }
    device_bindings {
        uuid id PK
        uuid user_id FK
        text device_hash
        bool trusted
        timestamptz first_seen
        timestamptz last_verified
    }
    otp_codes {
        uuid id PK
        text phone
        text code_hash
        int attempts "max 5"
        timestamptz expires_at "TTL 5 min"
    }
    kyc_records {
        uuid id PK
        uuid user_id FK
        int tier
        text status "pending|approved|rejected"
        jsonb documents "S3 refs"
        timestamptz reviewed_at
    }
    shops {
        uuid id PK
        uuid seller_id FK
        text slug UK
        text name
        char2 country
        uuid city_id FK
        bool verified
        int completed_orders
    }
    products {
        uuid id PK
        uuid shop_id FK
        text title
        bigint price_minor
        char3 currency
        int stock "race-protected decrement"
        text status "draft|active|archived"
    }
    delivery_points {
        uuid id PK
        uuid owner_id FK "nullable (guest)"
        geometry point "PostGIS, encrypted-at-rest"
        text landmark "mandatory"
        text label
        bool consent
        timestamptz truncate_after "FR-25 retention"
    }
    zones {
        uuid id PK
        uuid city_id FK
        text name
        geometry polygon "GiST index"
    }
    zone_fees {
        uuid id PK
        uuid zone_id FK
        bigint fee_minor
        char3 currency
        int radius_band_km "fallback when outside polygons"
    }
    orders {
        uuid id PK
        uuid shop_id FK
        uuid buyer_id FK "nullable guest"
        text guest_phone
        text status "state machine FR-36"
        bigint subtotal_minor
        bigint delivery_fee_minor
        bigint total_minor
        char3 currency
        jsonb delivery_point_snapshot
        text idempotency_key UK
        text tracking_token "rotatable"
        timestamptz payment_expires_at "30 min hold"
    }
    payment_attempts {
        uuid id PK
        uuid order_id FK
        text method "WAVE|ORANGE_MONEY|MTN_MOMO|MOOV_MONEY|MIXX_BY_YAS|PI_SPI|CARD|COD|MANUAL_TRANSFER"
        uuid provider_id FK "which aggregator served it"
        text status "initiated|ussd_pending|succeeded|failed|expired"
        text provider_ref UK
        text failure_reason
        timestamptz created_at
    }
    payment_providers {
        uuid id PK
        text code UK "AGG_A|AGG_B|PISPI|MOCK"
        text kind
        jsonb config "non-secret; secrets via env"
        bool active
    }
    provider_routes {
        uuid id PK
        char2 country
        text method
        uuid primary_provider_id FK
        uuid fallback_provider_id FK
        bool active
    }
    webhook_events {
        uuid id PK
        uuid provider_id FK
        text event_id UK "per-provider dedupe"
        jsonb payload
        bool signature_valid
        text outcome "applied|duplicate|rejected|late"
        timestamptz received_at
    }
    ledger_accounts {
        uuid id PK
        text owner_type "platform|seller|rider|provider|buyer_refund"
        uuid owner_id
        char3 currency
    }
    ledger_transactions {
        uuid id PK
        text kind "sale|refund|payout|remittance|fee|adjustment"
        uuid source_id "attempt/payout/job id"
        timestamptz created_at
    }
    ledger_entries {
        uuid id PK "append-only"
        uuid transaction_id FK
        uuid account_id FK
        bigint amount_minor "sign = direction"
        char3 currency
        text leg "gross|provider_fee|tax|net|cod_cash"
    }
    payouts {
        uuid id PK
        uuid seller_id FK
        bigint amount_minor
        char3 currency
        text rail "PI_SPI|AGGREGATOR"
        text status
        bool pin_verified
    }
    settlement_batches {
        uuid id PK
        uuid provider_id FK
        date settlement_date
        text source_file
        text status "ingested|matched|closed"
    }
    settlement_lines {
        uuid id PK "append-only"
        uuid batch_id FK
        text provider_ref
        bigint amount_minor
        bigint fee_minor
        char3 currency
        uuid matched_transaction_id FK "nullable"
        text match_kind "exact|fuzzy|unmatched"
    }
    reconciliation_flags {
        uuid id PK
        uuid settlement_line_id FK "nullable"
        uuid order_id FK "nullable — paid order missing from file"
        text kind "unmatched_line|missing_order|amount_mismatch"
        text status "open|resolved"
        timestamptz opened_at "drives aging"
    }
    fraud_events {
        uuid id PK "append-only"
        uuid user_id FK "nullable"
        text device_hash
        text kind "velocity_failed_payments|mass_signup|new_device|payout_anomaly"
        jsonb detail
        text review_status "open|cleared|actioned"
    }
    riders {
        uuid user_id PK-FK
        text vehicle
        bool active
        bigint cod_outstanding_minor "cached; source of truth = rider_cash_ledger"
    }
    delivery_jobs {
        uuid id PK
        uuid order_id FK
        text mode "SELF|RIDER|PARTNER"
        uuid rider_id FK "nullable"
        uuid partner_id FK "nullable"
        text status "dispatch state machine FR-26"
        bigint fee_minor
        jsonb proof "photo ref | OTP code"
        bool cod
    }
    dispatch_offers {
        uuid id PK
        uuid job_id FK
        uuid rider_id FK
        timestamptz offered_at
        text response "pending|accepted|rejected|expired"
    }
    job_events {
        uuid id PK
        uuid job_id FK
        text status
        geometry gps_snapshot "nullable"
        timestamptz at "offline-sync idempotent"
    }
    rider_cash_ledger {
        uuid id PK "append-only"
        uuid rider_id FK
        uuid order_id FK
        bigint amount_minor "collected(+) remitted(-)"
        char3 currency
        text kind "cod_collected|remitted_pispi|remitted_agent"
    }
    partners {
        uuid id PK
        text name
        text adapter "MOCK|<real>"
        text webhook_secret_ref "env key name"
    }
    ratings {
        uuid id PK
        uuid order_id FK
        text target "seller|rider|partner"
        int stars
        text comment
    }
    disputes {
        uuid id PK
        uuid order_id FK
        text status "open|resolved_refund|resolved_reject"
        bool payout_frozen "scoped freeze"
        jsonb evidence "auto-attached delivery proof"
    }
    country_packs {
        uuid id PK
        char2 country UK
        int version
        jsonb pack "methods, routes, taxes, kyc limits, phone regex, zones refs, compliance"
        bool active
    }
    audit_log {
        uuid id PK "append-only"
        uuid actor_id
        text action
        jsonb detail
        timestamptz at
    }
```

Not shown for brevity: `product_images`, `shop_payment_methods` (seller subset of pack
matrix), `scam_education_state` (cards seen exactly once, DC-8.4), `sms_outbox`
(notification fallback, DC-15), `reports` (moderation takedowns), `cities`.
All 10 golden paths were walked against this ERD (see `SEQUENCES.md`).
