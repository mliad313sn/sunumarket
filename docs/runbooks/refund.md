# Runbook — Remboursement (SOP)

1. Litige → /admin/disputes → resolution=refund : rembourse via le rail d'origine (PI-SPI reverse / agrégateur) + reverse ledger, testé.
2. Webhook tardif (ADR-0007) : remboursement auto déjà déclenché — vérifier son aboutissement dans la file refunds.
3. COD : pas de rail — remboursement espèces par le vendeur, tracer via ajustement ledger + note d'audit.
4. Toujours vérifier : commande → refunded, gel de payout levé, SMS buyer parti.
