-- Immutability for ledger_transactions parent rows (audit fix 9b).
-- No code path updates ledger_transactions (kind/attempt_id/source_ref are set at
-- creation only), so UPDATE and DELETE are forbidden entirely — mirroring the
-- ledger_entries trigger from 20260820180757_immutability_and_gist.

CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
