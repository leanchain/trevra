-- `linkedin_campaigns.seat_key` -- drop the last `DEFAULT 'owner'`.
--
-- 058 section 2 swept the default off every table carrying
-- `seat_key TEXT NOT NULL DEFAULT 'owner'` and DEFERRED exactly one:
-- `linkedin_campaigns`, on the premise that `createCampaign`
-- (src/server/linkedin/campaigns.ts) inserted without naming the column, so
-- dropping the default would turn a silent mis-attribution into a 500 on
-- campaign creation. That premise was already stale when 058 landed in the
-- same branch: `createCampaign` names `seat_key` in its INSERT column list and
-- passes `input.seatKey ?? OWNER_SEAT_KEY`, and `createManagedCampaign` has
-- always named it. No production INSERT relies on the default any more.
--
-- WHY IT MATTERS ON THIS TABLE MOST, in 058's own words: a writer that forgets
-- the column does not fail, it silently files another person's LinkedIn
-- activity against the OWNER's seat -- the seat whose pacing budget, warm-up
-- band and restriction history everything else reads. 058 installed that safety
-- net on seven tables and left it off the one it called the sharpest case.
--
-- CATALOG-ONLY, exactly as 058 describes: `ALTER COLUMN ... DROP DEFAULT`
-- rewrites no rows and reads no rows. It takes ACCESS EXCLUSIVE for the
-- microseconds it takes to update pg_attrdef, so it is safe on a table of any
-- size and needs no size gate.
--
-- Idempotent: guarded on the default still being present, so a re-run and a
-- database that never had it are both no-ops.
DO $$
BEGIN
  IF to_regclass('public.linkedin_campaigns') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = to_regclass('public.linkedin_campaigns')
         AND a.attname = 'seat_key' AND a.attnum > 0 AND NOT a.attisdropped AND a.atthasdef
     ) THEN
    ALTER TABLE linkedin_campaigns ALTER COLUMN seat_key DROP DEFAULT;
    RAISE NOTICE '060: dropped seat_key default on linkedin_campaigns';
  END IF;
END $$;
