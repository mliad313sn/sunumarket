# Runbook — Panne partenaire → bascule RIDER

1. Refus/timeout adapter → bascule automatique PARTNER→RIDER (testée).
2. Panne prolongée : suspendre le partenaire (adapter OFF), informer les vendeurs.
3. Webhooks partenaires : signés par secret partenaire ; tamper → 401, replay → dédupliqué (testé). En cas d'événements hors ordre, l'état est protégé par la machine à états.
4. Retour : réactiver l'adapter, vérifier le backlog de jobs.
