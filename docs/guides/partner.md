# Guide partenaire (DiaLog Express)

1. Intégration : votre système reçoit nos demandes d'enlèvement (adapter) et nous renvoie des webhooks signés HMAC avec votre secret.
2. Événements : accepted, picked_up, en_route, delivered, failed — idempotents par event_id (les replays sont sans effet).
3. `delivered` doit inclure votre référence de preuve photo.
4. Refus d'enlèvement : nous re-routons automatiquement vers nos livreurs — signalez vos fenêtres d'indisponibilité.
5. Dashboard : /partner/jobs (jobs qui vous sont affectés uniquement).
