# Runbook — Écart COD livreur (SOP)

1. Source de vérité : rider_cash_ledger (append-only). Invariant : Σcollecté − Σremis = en-cours (cache riders.cod_outstanding).
2. Écart déclaré : geler l'activité du livreur (riders.active=false), comparer ledger vs remises PI-SPI/agent.
3. Billets contrefaits : carte éducation déjà servie ; perte au vendeur sauf assurance — tracer en ajustement.
4. Dépassement de plafond : bloqué à l'acceptation (testé) ; si contournement constaté → fraude, désactivation.
