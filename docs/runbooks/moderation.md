# Runbook — Modération (SOP)

1. Signalements : POST /reports (anonyme accepté) → audit_log.
2. Takedown produit : /admin/products/:id/takedown (archivé, 404 public, audité — testé).
3. Vendeur/livreur/partenaire récidiviste : désactivation + note d'audit ; KYC docs conservés (append-only fraud trail).
4. Contenus illicites par pays : liste des articles interdits (compliance pack) fait foi.
