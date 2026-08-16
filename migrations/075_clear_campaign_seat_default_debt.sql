-- Close the stale migration-058 hardening ledger entry for
-- linkedin_campaigns.seat_key.
--
-- Migration 058 deliberately deferred dropping DEFAULT 'owner' because its
-- author believed createCampaign still omitted seat_key. The writer now names
-- seat_key explicitly, and migration 060 already drops the default. 060 did not
-- remove 058's bookkeeping row, so a completely fresh database still reports
-- hardening debt that is no longer real.
--
-- This migration does not merely delete the warning. It first verifies the
-- condition that makes the warning obsolete. If the default is somehow still
-- present, fail the migration instead of making the deployment look hardened.
DO $$
DECLARE
  campaigns regclass := to_regclass('public.linkedin_campaigns');
  still_has_default boolean := false;
BEGIN
  IF campaigns IS NULL THEN
    RETURN;
  END IF;

  SELECT a.atthasdef INTO still_has_default
  FROM pg_attribute a
  WHERE a.attrelid = campaigns
    AND a.attname = 'seat_key'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF COALESCE(still_has_default, false) THEN
    RAISE EXCEPTION 'linkedin_campaigns.seat_key still has a default; migration 060 must drop it before hardening debt can be cleared';
  END IF;

  IF to_regclass('public.schema_hardening_deferred') IS NOT NULL THEN
    DELETE FROM schema_hardening_deferred
    WHERE item = 'seat-key-default' AND table_name = 'linkedin_campaigns';
  END IF;
END $$;
