-- LinkedIn campaigns and the workspace exclusion list.
--
-- 022 gave the seat and the per-seat action ledger, 024 gave the local worker
-- its batches. What is still missing is the object a founder actually names
-- and comes back to: "the seed-stage CTO campaign". A campaign is NOT a second
-- ledger -- every action still lives in `linkedin_actions`, keyed by the
-- `campaign_id` that table has carried since 022. This table holds only what
-- the ledger cannot: a human name, a lifecycle, the approved copy, and the
-- link back to the playbook run that produced and approved both.
--
-- Nothing here can make an action happen. `gtm.linkedin-outreach` plans and
-- the operator's own tool (or the self-hosted local worker) sends; a campaign
-- row is the folder those two facts are filed under.

CREATE TABLE IF NOT EXISTS linkedin_campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- What a human calls it. Also the replay key -- see the index below.
  name TEXT NOT NULL,
  -- 'draft'     -- created without a playbook run behind it
  -- 'running'   -- a gtm.linkedin-outreach run is live: queued, running, or
  --                waiting on the founder's approval
  -- 'completed' -- that run finished
  -- 'stopped'   -- an operator stopped it; `stop_requested_at` says when, and
  --                the campaign's unclaimed 'planned' actions were released
  status TEXT NOT NULL DEFAULT 'draft',
  -- The copy exactly as `gtm.linkedin-sequence` produced it and a human
  -- approved it. Stored rather than re-derived for the same reason the
  -- approval payload carries the plan (playbooks/registry.ts): a sequence
  -- regenerated later is a different sequence under an unchanged name.
  sequence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The run that produced the sequence, the plan, the guard verdict and the
  -- approval. Not a foreign key: playbook runs are prunable history and a
  -- campaign must outlive the pruning of the run that made it.
  playbook_run_id TEXT,
  -- Mirrors 021_agent_run_stop.sql and 024's `linkedin_batches`, for the same
  -- reason: the REQUEST to stop and the OUTCOME of stopping are two different
  -- facts. This column is the request, written by the API. Asking twice keeps
  -- the original timestamp, so "when did somebody first ask for this to stop"
  -- survives an impatient second click.
  stop_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Replay guard, same shape and same reasoning as idx_outreach_posts_payload.
--
-- POST /api/linkedin/campaigns starts a playbook run, and a double-clicked
-- Create button must not produce two runs planning the same targets under the
-- same name -- which, once both are approved, is two invites to every person
-- on the list. The name is the claim, and it is taken BEFORE the run exists.
--
-- 'stopped' is the single exclusion, exactly as 'failed' is for outreach_posts
-- and crm_activities: a campaign an operator stopped is over, so its name is
-- released and "CTO campaign, take two" is allowed to reuse it.
--
-- LOWER() because the name is typed by a human twice, and "CTO Campaign" and
-- "cto campaign" are the same claim on the same targets. Same case-folding the
-- handle lookup in 023 settled on, for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_campaigns_name
  ON linkedin_campaigns(workspace_id, LOWER(name))
  WHERE status <> 'stopped';

-- The campaign list, newest first.
CREATE INDEX IF NOT EXISTS idx_linkedin_campaigns_recent
  ON linkedin_campaigns(workspace_id, created_at DESC);

-- The blacklist: people this workspace will not contact on LinkedIn again.
--
-- Consulted before a plan is produced and before a campaign is started, never
-- afterwards. An exclusion that only took effect at send time would still have
-- put the person into an approved payload a founder read and signed.
--
-- `target_ref` is the same opaque handle-or-URL the ledger stores, and it is
-- never resolved against LinkedIn. Trevra does not look people up.
CREATE TABLE IF NOT EXISTS linkedin_exclusions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_ref TEXT NOT NULL,
  -- Why, in the operator's words. "Asked us to stop" and "already a customer"
  -- want very different handling if this list is ever reviewed.
  reason TEXT NOT NULL DEFAULT '',
  -- 'manual' | 'import'. Which route put it here.
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TOTAL, not partial, and deliberately unlike the two guards above.
--
-- A partial index excludes the state that means "this never happened", so the
-- claim can be retried: 'failed' for outreach_posts, 'skipped' for
-- linkedin_actions, 'stopped' for campaigns. An exclusion has no such state --
-- there is no route that removes one, because a person who asked not to be
-- contacted does not stop having asked. So every row counts, and re-adding a
-- target updates its reason instead of writing a second row.
--
-- LOWER() for the same reason as 023's idx_contact_identities_handle_ci: the
-- handle arrives by hand and by CSV, and 'https://linkedin.com/in/Maya' must
-- exclude 'https://linkedin.com/in/maya'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_exclusions_target
  ON linkedin_exclusions(workspace_id, LOWER(target_ref));

-- The rendered campaign files.
--
-- WHY THE BYTES ARE STORED INSTEAD OF RE-RENDERED ON DOWNLOAD, which is the
-- one thing about this table that will look like waste to somebody later:
--
--   `exportCampaign()` is not a pure function. Rendering a campaign WRITES the
--   plan's slots into `linkedin_actions` as 'exported' -- deliberately, because
--   an exported invite is about to be real and the pacing engine's rolling
--   windows have to count it (export.ts, actions.ts `COUNTED`). Re-rendering on
--   every download would therefore re-run that ledger write on every click.
--   The replay guard on (workspace, seat, kind, target) absorbs the duplicates
--   today, but the seat's real day-over-day history is the ONE input the whole
--   safety engine reasons from, and hanging its correctness on an index that
--   happens to dedupe is not a margin. Render once, keep the bytes, serve them
--   forever. A download must be able to cost nothing.
--
-- The rows are small: a 500-target Dripify CSV is tens of kilobytes, and the
-- alternative -- a file on a disk the API server may not have next week -- is
-- how a download 404s in production.
CREATE TABLE IF NOT EXISTS linkedin_exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Not a foreign key, same reasoning as playbook_run_id above: the file an
  -- operator downloaded is history and must outlive the campaign row.
  campaign_id TEXT NOT NULL,
  -- dripify | heyreach | expandi | generic
  format TEXT NOT NULL,
  filename TEXT NOT NULL,
  -- As `export.ts` declared it, not as this table guesses. Two of the four
  -- formats are CSV, one is JSON, and 'generic' is a prose brief.
  content_type TEXT NOT NULL,
  -- The file, verbatim, header block included. TEXT rather than BYTEA: every
  -- format this renders is UTF-8, and a download that has to answer "which
  -- encoding" is a download that arrives corrupted somewhere.
  bytes TEXT NOT NULL,
  -- `canonicalPayloadHash` of the approved payload these bytes were rendered
  -- from. This is what makes "has this already been exported" answerable
  -- without comparing files: same hash, same bytes, no re-render.
  payload_hash TEXT,
  -- 'current'    -- the live render for this (campaign, format)
  -- 'superseded' -- a re-approval produced a different payload, so these bytes
  --                 no longer describe the campaign. Still downloadable under
  --                 their own id, because somebody may already be running them.
  status TEXT NOT NULL DEFAULT 'current',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Replay guard, same shape as idx_outreach_posts_payload and for the same
-- reason: a double-clicked Export must produce one render, not two, because a
-- render writes the ledger. 'superseded' is the single exclusion -- those bytes
-- have been replaced by a later approval and no longer hold the claim.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_exports_render
  ON linkedin_exports(workspace_id, campaign_id, format)
  WHERE status <> 'superseded';

-- "What has this campaign produced", newest first.
CREATE INDEX IF NOT EXISTS idx_linkedin_exports_campaign
  ON linkedin_exports(workspace_id, campaign_id, created_at DESC);
