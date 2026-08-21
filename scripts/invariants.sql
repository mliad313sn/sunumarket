-- Post-load/chaos invariant checks (Playbook Phase 12). All queries must return 0 rows.

-- 1. Ledger: every transaction balances per currency.
SELECT transaction_id, currency, SUM(amount_minor) AS drift
FROM ledger_entries GROUP BY transaction_id, currency HAVING SUM(amount_minor) <> 0;

-- 2. Ledger: global sum is zero.
SELECT 'global_drift' AS what, SUM(amount_minor) AS drift FROM ledger_entries HAVING SUM(amount_minor) <> 0;

-- 3. COD: cached outstanding matches the append-only ledger.
SELECT r.user_id, r.cod_outstanding_minor, COALESCE(SUM(l.amount_minor), 0) AS ledger_outstanding
FROM riders r LEFT JOIN rider_cash_ledger l ON l.rider_id = r.user_id
GROUP BY r.user_id, r.cod_outstanding_minor
HAVING r.cod_outstanding_minor <> COALESCE(SUM(l.amount_minor), 0);

-- 4. Orders: no duplicated idempotency keys (enforced by unique index; belt and braces).
SELECT idempotency_key, COUNT(*) FROM orders GROUP BY idempotency_key HAVING COUNT(*) > 1;

-- 5. Jobs: no order with two delivery jobs; no job accepted by a rider without an accepted offer.
SELECT order_id, COUNT(*) FROM delivery_jobs GROUP BY order_id HAVING COUNT(*) > 1;
SELECT j.id FROM delivery_jobs j
WHERE j.mode = 'RIDER' AND j.rider_id IS NOT NULL AND j.status <> 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM dispatch_offers o WHERE o.job_id = j.id AND o.rider_id = j.rider_id AND o.response = 'accepted');

-- 6. Stock: never negative.
SELECT id, stock FROM products WHERE stock < 0;

-- 7. Paid orders must have exactly one succeeded attempt (COD/manual included).
SELECT o.id, COUNT(a.id) AS succeeded
FROM orders o LEFT JOIN payment_attempts a ON a.order_id = o.id AND a.status IN ('succeeded')
WHERE o.status IN ('paid','preparing','in_delivery','delivered','completed')
GROUP BY o.id HAVING COUNT(a.id) <> 1;

-- 8. Ledger: no seller balance is ever negative (payout double-spend guard).
SELECT a.owner_id, SUM(e.amount_minor) AS balance
FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id
WHERE a.owner_type = 'seller'
GROUP BY a.owner_id HAVING SUM(e.amount_minor) < 0;

-- 9. Every refund-resolved dispute whose order has a ledger sale also has the refund reversal.
SELECT d.id AS dispute_id, s.id AS sale_transaction
FROM disputes d
JOIN ledger_transactions s ON s.kind = 'sale' AND s.source_ref = d.order_id::text
WHERE d.status = 'resolved_refund'
  AND NOT EXISTS (
    SELECT 1 FROM ledger_transactions r
    WHERE r.kind = 'refund' AND r.source_ref LIKE '%:' || s.id::text
  );
