-- HOW FAR THROUGH A SEARCH THIS SOURCE HAS ALREADY READ.
--
-- A lead source was walked in ONE GO: up to ten search pages, back to back, at
-- 30-120s gaps. That is ten to twenty minutes of continuous people-search
-- paging -- and every other part of this subsystem now happens inside a VISIT,
-- which is two to five minutes, two to five times a day (see `pacing.ts`
-- `visitsForDay`). A harvester that ignores the visit is the one remaining
-- burst in the system, on the exact surface LinkedIn restricted the account
-- for: reading other people's profiles at volume.
--
-- With a cursor, a source is walked the way a person reads a search: a page or
-- three, then something else, then back to it later. The rows it produces are
-- identical; only the shape of the reading changes.
--
-- NOT A LEASE. `status` already governs who owns a source (the claim flips
-- 'pending' to 'running'); this only records where to resume from when the
-- source is put back.
--
-- Idempotent: guarded, so a re-run and a fresh database are both no-ops.
DO $$
BEGIN
  IF to_regclass('public.linkedin_lead_sources') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = to_regclass('public.linkedin_lead_sources')
         AND a.attname = 'pages_done' AND a.attnum > 0 AND NOT a.attisdropped
     ) THEN
    ALTER TABLE linkedin_lead_sources ADD COLUMN pages_done INTEGER NOT NULL DEFAULT 0;
    RAISE NOTICE '072: added linkedin_lead_sources.pages_done';
  END IF;
END $$;
