# RISKS

| ID | Risk | Impact | Mitigation | Status |
|----|------|--------|------------|--------|
| R-1 | Wave has no full self-service merchant API (Goal §3.2) | Blocks dominant SN method | Reach via aggregator / Wave Business dynamic QR; dual-aggregator routing (FR-14b) | open |
| R-2 | Orange Money merchant onboarding takes weeks | Launch delay | Start onboarding early; mock-first build unblocked | open |
| R-3 | MM transaction-tax changes (SN/ML precedents) | Checkout cost shifts, cash regression | Per-country tax pass-through config (DC-11); COD permanent | open |
| R-4 | Aggregator outage mid-checkout | Lost orders | Circuit breaker + fallback provider (NFR-2); golden path 9 | open |
| R-5 | Fraud: fake payment SMS/screenshots vs sellers | Seller losses, trust collapse | DC-8 pack: webhook-only `paid`, MANUAL_TRANSFER off by default | open |
| R-6 | Build sandbox lacks Docker daemon | Compose verify not runnable in-sandbox | Native PG+PostGIS+Redis locally; CI uses service containers | mitigated |
| R-7 | Provider contract drift vs mocks | Integration surprises | Contract-test files per provider (Playbook Failure Protocol) | open |
