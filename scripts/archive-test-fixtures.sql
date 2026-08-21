-- Dev/test data hygiene: archive synthetic test-fixture products so the public
-- marketplace only shows real catalog items. Fixture titles carry a machine suffix
-- ("<prefix>-<epoch-ms>-<seq>", e.g. "gp-p-1787279688466-56" or
-- "race-test-1787279642653-0.8554") that no human title uses.
-- Idempotent. products is a mutable table (not append-only). Also run by prisma seed.
UPDATE products SET status = 'archived'
WHERE status = 'active' AND title ~ '-[0-9]{13}-[0-9]+(\.[0-9]+)?$';

-- Legacy fixture titles from suites before they switched to machine suffixes.
UPDATE products SET status = 'archived'
WHERE status = 'active' AND title IN ('Sandales cuir GP1', 'Boubou brodé premium');
