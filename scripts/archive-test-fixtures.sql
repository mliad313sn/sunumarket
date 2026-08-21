-- Dev/test data hygiene: archive synthetic test-fixture products so the public
-- marketplace only shows real catalog items. Fixture titles carry a machine suffix
-- ("<prefix>-<epoch-ms>[rand]-<seq>", e.g. "gp-p-1787279688466-56",
-- "race-test-1787279642653-0.8554" or "fm-p-1787337765612292-26" — the
-- final.money suite appends up to 3 random digits, so 13-16 digits) that no
-- human title uses.
-- Idempotent. products is a mutable table (not append-only). Also run by prisma seed.
UPDATE products SET status = 'archived'
WHERE status = 'active' AND title ~ '-[0-9]{13,16}-[0-9]+(\.[0-9]+)?$';

-- Legacy fixture titles from suites before they switched to machine suffixes.
UPDATE products SET status = 'archived'
WHERE status = 'active' AND title IN ('Sandales cuir GP1', 'Boubou brodé premium');
