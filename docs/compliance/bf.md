# Compliance checklist — Burkina Faso (BF) — FR-41c / DC-12

Release-gate artifact. Status must be all ✅ or formally waived before public launch in Burkina Faso.

| # | Item | Authority | Status | Notes |
|---|------|-----------|--------|-------|
| 1 | Déclaration / enregistrement DPA | CIL (Commission de l'Informatique et des Libertés) | ⬜ todo | Location data = donnée sensible : consentement par capture (FR-25, testé), chiffrement au repos, troncature après rétention (job testé). Dossier à déposer avant beta publique. |
| 2 | CGU localisées (FR) | interne | ⬜ todo | Draft requis avant beta ; FR-first, EN toggle. |
| 3 | Politique de confidentialité localisée (FR) | interne | ⬜ todo | Doit citer : consentement localisation, rétention 180 jours puis troncature ~1,1 km, droits d'export/suppression (endpoints livrés — suppression = anonymisation, cf. BACKLOG). |
| 4 | Liste des articles interdits (BF) | interne | ⬜ todo | Publier + brancher la modération (takedown livré et testé). |
| 5 | Affichage transparent frais/taxes avant paiement | interne | ✅ done | Pack `fees_taxes.pass_through` avec bearer par frais ; affiché au checkout (Pas de taxe MM spécifique à date — config prête si introduite). |
| 6 | Jamais de détention de fonds clients hors rails licenciés (DC-10) | BCEAO | ✅ done (par construction) | Pay-in/pay-out via agrégateurs licenciés + PI-SPI ; le ledger ne modélise que des flux, aucun wallet interne. |
| 7 | KYC par paliers aligné BCEAO (DC-13) | BCEAO | ✅ done | Tier 0/1/2, plafonds par pack, testés. |
| 8 | Méthodes de paiement conformes au marché | — | ✅ done | Orange Money, Moov Money, COD, PI-SPI. MANUAL_TRANSFER désactivé par défaut (DC-8.2). |
| 9 | Numérotation téléphonique validée (+226) | — | ✅ done | Regex pack, testée. |
| 10 | Éducation anti-fraude in-app (DC-8.4) | interne | ✅ done | Cartes vendeur/livreur servies une seule fois, état persisté, testé. |
