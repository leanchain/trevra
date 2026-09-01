-- Per-platform outcome of a brand watch's last run, so the worker's cadence
-- sweep -- the only path that runs with no session watching -- has something
-- to show when every platform degrades to a warning instead of throwing.
--
-- `runBrandWatch` sets `last_error` only when `watchMentions` itself throws,
-- but the realistic failure mode (a 403, a timeout, a throttle) is degraded
-- to a warning by outreach/scouts/http.ts's `getJson` and never reaches that
-- catch. A run where GitHub 403s, HN times out and Stack Overflow throttles
-- was therefore indistinguishable from a run that genuinely found nothing.

ALTER TABLE brand_watches
  ADD COLUMN IF NOT EXISTS last_run_warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

-- promoted_run_id's ON DELETE SET NULL makes Postgres sequential-scan
-- brand_watch_mentions once per deleted playbook_runs row without this --
-- and workspace deletion cascades thousands of those inside one transaction.
CREATE INDEX IF NOT EXISTS brand_watch_mentions_promoted_run_idx
  ON brand_watch_mentions(promoted_run_id);
