# Runbook — Écart de réconciliation (SOP)

1. File : /admin/reconciliation/flags (buckets <24h / 24-72h / 72h-7d / >7d). KPI : <0,5% du volume, purge <72 h.
2. unmatched_line : chercher la référence chez le provider (portail) ; si paiement réel non enregistré → vérifier webhook_events (signature ? replay ?) puis créditer via écriture d'ajustement équilibrée.
3. amount_mismatch : comparer frais/parts ; si erreur provider → ticket provider, garder le flag ouvert ; si erreur interne → ajustement ledger + correctif.
4. missing_order : commande payée absente du fichier — JAMAIS silencieux. Confirmer chez le provider ; escalader si l'argent n'apparaît pas à J+2.
5. Résoudre le flag seulement après écriture/action ; le rapport de clôture mensuelle doit être vert.
