-- Lead sourcing: where a list of people came from, and who was on it.
--
-- THIS IS THE ONE PART OF THE LINKEDIN SUBSYSTEM THAT IS NOT THE OPERATOR
-- ACTING ON THEIR OWN ACCOUNT. Every other table here records something the
-- operator did to their own network: an invite they sent, a message they
-- wrote, a seat they own. These two record PEOPLE HARVESTED OUT OF LINKEDIN'S
-- SEARCH RESULTS AND POST ENGAGEMENT, which is scraping -- the thing User
-- Agreement 8.2 names in so many words, including browser extensions by
-- category (plan 1.2). hiQ settled that scraping public data is not a CFAA
-- violation and settled nothing about the contract: the breach-of-contract and
-- trespass claims survived, and the exposure lands on the operator's own
-- account.
--
-- So this schema exists to make the harvest ACCOUNTABLE rather than invisible:
--
--   * every lead names the source row it came from, so "where did this person
--     come from" has an answer a year later;
--   * every source keeps the URL that was walked, when it was asked for, when
--     it finished, how many people it produced, and why it stopped if it did;
--   * a source is CLAIMED before it acts, so a double-clicked button cannot
--     walk the same search twice.
--
-- Nothing here can make the harvest happen. `leads.ts` refuses to run unless
-- `leadSourcingEnabled()` says so -- a separate opt-in from the automation
-- switch, off by default, and unconditionally off on a hosted deployment.

CREATE TABLE IF NOT EXISTS linkedin_lead_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- 'search' -- a /search/results/people/ URL, walked page by page
  -- 'post'   -- a post permalink; its reactors and its commenters
  --
  -- Two kinds and not a generic 'url', because they are two different walks
  -- with two different selector tables and two different failure shapes. A
  -- column that said only "a URL" would push that distinction into a regex at
  -- every read site.
  kind TEXT NOT NULL,
  -- Exactly what the operator supplied, after `searchResultsUrlFor` /
  -- `postUrlFor` validated the host and the shape. Stored verbatim rather than
  -- rebuilt from parsed parts: the query string IS the search -- keywords,
  -- filters, facets -- and re-encoding it is how a filtered search quietly
  -- becomes an unfiltered one on the next run.
  url TEXT NOT NULL,
  -- 'pending'   -- asked for, nothing has touched LinkedIn yet
  -- 'running'   -- claimed; a browser is walking it right now
  -- 'completed' -- the walk ended normally, `result_count` says with how many
  -- 'failed'    -- it stopped early; `failure_reason` says why, in words an
  --                operator can act on (a challenge, a limit wall, the gate
  --                being off, a paused seat)
  status TEXT NOT NULL DEFAULT 'pending',
  -- When a human asked for this. Distinct from `created_at` on purpose, and
  -- for the same reason `linkedin_actions` separates `planned_for` from
  -- `created_at`: the row is written when the request arrives, and the claim
  -- ordering has to be the human's queue order, not the writer's clock.
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ,
  -- People STORED by this source, not people SEEN. A harvest of 100 that hits
  -- 60 already-contacted and excluded profiles produced 40, and 40 is the
  -- honest number to show next to the row.
  result_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Replay guard, same shape and same reasoning as idx_linkedin_campaigns_name.
--
-- A double-clicked "Source these leads" must not queue the same search twice:
-- two claims on one URL is two full page walks against one account inside a
-- minute, which is exactly the burst shape plan 1.3 says precedes a
-- disconnection. The URL is the claim, and it is taken BEFORE anything is
-- walked.
--
-- PARTIAL ON THE LIVE STATES, so the same search CAN be run again later --
-- which is the normal case: a saved search re-walked next month is how new
-- people are found, and the (workspace, profile_url) index on the leads table
-- below is what stops that producing duplicate people. The guard here is about
-- concurrency, not about history.
--
-- LOWER() because the URL is pasted by a human twice, and LinkedIn's own share
-- links differ in case. Same case-folding as idx_linkedin_exclusions_target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_lead_sources_live
  ON linkedin_lead_sources(workspace_id, kind, LOWER(url))
  WHERE status IN ('pending', 'running');

-- The claim query: oldest pending source for one workspace. Partial on the
-- same predicate the claim selects with, exactly like
-- idx_linkedin_actions_claimable -- pending is the small hot minority of this
-- table forever, because every other row is terminal.
CREATE INDEX IF NOT EXISTS idx_linkedin_lead_sources_claimable
  ON linkedin_lead_sources(workspace_id, requested_at)
  WHERE status = 'pending';

-- The source list, newest first.
CREATE INDEX IF NOT EXISTS idx_linkedin_lead_sources_recent
  ON linkedin_lead_sources(workspace_id, created_at DESC);

-- The harvested people.
--
-- A LEAD IS NOT AN ACTION AND MUST NOT LOOK LIKE ONE. Nothing in this table
-- has been contacted, planned, paced or approved; it is a list of people a
-- search returned. `linkedin_actions` stays the only ledger, and a lead
-- becomes an action only when a human puts it in a campaign -- which is why
-- there is no status column here to drift into a second, quieter queue.
CREATE TABLE IF NOT EXISTS linkedin_leads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Which walk found them. Not a foreign key, same reasoning as
  -- linkedin_exports.campaign_id: the source rows are prunable history and the
  -- people found are not.
  source_id TEXT NOT NULL,
  -- Canonical: https://www.linkedin.com/in/<handle>/, with the query and hash
  -- dropped by `canonicalProfileUrl`. NOT the raw href -- a harvested link
  -- carries ?miniProfileUrn=... every single time, and a lead stored with it
  -- would be a different string from the same person's exclusion row, which is
  -- the one comparison this whole feature has to get right.
  profile_url TEXT NOT NULL,
  -- What the card showed. All three are nullable and all three stay NULL when
  -- the page did not show them -- never '', never inferred. Same rule as
  -- LinkedInSeatRead: a field nobody could read comes back empty, because a
  -- guess stored in a column an operator reads as a fact is worse than a gap.
  name TEXT,
  headline TEXT,
  -- The secondary line on a search card. Post engagers have no company field
  -- at all, so theirs is always NULL rather than parsed out of the headline.
  company TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ONE PERSON, ONE ROW, PER WORKSPACE -- not per source.
--
-- TOTAL rather than partial, and deliberately unlike the source guard above.
-- A partial index excludes the state that means "this never happened"; a lead
-- has no such state. Re-walking a saved search next month, or finding the same
-- person in a search AND in a post's reactions, must not put them in the list
-- twice -- because a list an operator scans and approves is where a duplicate
-- turns into two invites to one human.
--
-- The FIRST source to find them keeps them. That is the useful attribution:
-- "where did this person first come from" is answerable, and re-running a
-- source is then genuinely idempotent rather than merely tolerable.
--
-- LOWER() for the same reason as idx_linkedin_exclusions_target: these strings
-- meet handles that arrived by hand and by CSV.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_leads_profile
  ON linkedin_leads(workspace_id, LOWER(profile_url));

-- "Who did this source find", newest first.
CREATE INDEX IF NOT EXISTS idx_linkedin_leads_source
  ON linkedin_leads(workspace_id, source_id, created_at DESC);
