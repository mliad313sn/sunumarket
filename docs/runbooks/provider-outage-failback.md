# Runbook — Panne agrégateur & retour à la normale

1. Détection : circuit breaker ouvre ≤60 s (alertes sur KPI fallback >5%).
2. Vérifier /admin/config : la route bascule automatiquement vers le fallback — aucune action requise pour les NOUVELLES tentatives.
3. Tentatives en vol : elles se terminent chez le provider initiateur (webhooks restent valides).
4. Panne double : les commandes restent réservées 30 min (NFR-2) ; message DC-3 côté buyer. Surveiller la file d'expiration.
5. Failback : half-open sonde automatiquement ; vérifier la fermeture du breaker, puis surveiller la réconciliation du lendemain (les commandes du failover settlent chez le FALLBACK).
6. Si le primaire reste dégradé >24 h : flip de route manuel /admin/config/routes (audité).
