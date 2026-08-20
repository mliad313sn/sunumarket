-- Append-only enforcement (Playbook Phase 2): ledger_entries, rider_cash_ledger,
-- settlement_lines, fraud_events, audit_log must never be UPDATEd or DELETEd.
-- Exception: settlement_lines matching columns are set exactly once by the matcher
-- (unmatched -> exact|fuzzy); fraud_events review_status transitions open -> cleared|actioned.

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (immutability trigger)', TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER rider_cash_ledger_immutable
  BEFORE UPDATE OR DELETE ON "rider_cash_ledger"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- settlement_lines: DELETE forbidden; UPDATE only allowed to set match columns once.
CREATE OR REPLACE FUNCTION settlement_lines_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement_lines is append-only';
  END IF;
  IF OLD.provider_ref IS DISTINCT FROM NEW.provider_ref
     OR OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
     OR OLD.fee_minor IS DISTINCT FROM NEW.fee_minor
     OR OLD.currency IS DISTINCT FROM NEW.currency
     OR OLD.batch_id IS DISTINCT FROM NEW.batch_id THEN
    RAISE EXCEPTION 'settlement_lines financial columns are immutable';
  END IF;
  IF OLD.match_kind <> 'unmatched' AND (
       OLD.match_kind IS DISTINCT FROM NEW.match_kind
       OR OLD.matched_transaction_id IS DISTINCT FROM NEW.matched_transaction_id) THEN
    RAISE EXCEPTION 'settlement_lines match columns are write-once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_lines_guard
  BEFORE UPDATE OR DELETE ON "settlement_lines"
  FOR EACH ROW EXECUTE FUNCTION settlement_lines_guard();

-- fraud_events: DELETE forbidden; UPDATE limited to review_status transitions.
CREATE OR REPLACE FUNCTION fraud_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fraud_events is append-only';
  END IF;
  IF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.device_hash IS DISTINCT FROM NEW.device_hash
     OR OLD.kind IS DISTINCT FROM NEW.kind
     OR OLD.detail IS DISTINCT FROM NEW.detail
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'fraud_events payload is immutable (only review_status may change)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fraud_events_guard
  BEFORE UPDATE OR DELETE ON "fraud_events"
  FOR EACH ROW EXECUTE FUNCTION fraud_events_guard();

-- Ledger entries must never be zero (a zero-amount leg hides bugs).
ALTER TABLE "ledger_entries" ADD CONSTRAINT ledger_entries_nonzero CHECK (amount_minor <> 0);

-- Spatial indexes (Playbook Phase 2: GiST).
CREATE INDEX zones_polygon_gist ON "zones" USING GIST (polygon);
CREATE INDEX delivery_points_point_gist ON "delivery_points" USING GIST (point);
CREATE INDEX job_events_gps_gist ON "job_events" USING GIST (gps);
