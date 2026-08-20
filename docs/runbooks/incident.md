# Runbook — Incident général

1. Constater : /health, taux d'erreurs API, Sentry (prod).
2. Classifier : paiement / livraison / données / sécurité.
3. Paiement → runbook provider-outage. Données → stopper les écritures suspectes, snapshot DB.
4. Communiquer : bannière statut + SMS si commandes impactées.
5. Post-mortem dans docs/reports/, action items dans BACKLOG.md.
