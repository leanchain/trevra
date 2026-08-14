-- Lead ingestion parity: where a lead was found, who they are, how many of
-- them a day, and the one-person-one-row rule that makes a campaign claim
-- mean something.
--
-- FOUR CHANGES, AND EACH ONE CLOSES A GAP BETWEEN WHAT THE PRODUCT PROMISED
-- AND WHAT THE SCHEMA COULD HOLD:
--
--   1. `linkedin_leads` could not say WHICH POST a person was found on or HOW
--      they touched it, so keyword discovery through posts and comments had
--      nowhere to land. Four additive columns.
--   2. Names were one string. A campaign template says "Hi {{firstName}}", so
--      the split had to happen somewhere -- and doing it at send time would
--      have been a second, quieter copy of the CSV import's scrub rules.
--   3. There was no DAILY ceiling anywhere, only per-run ones. "At most 100
--      leads a day" is a promise about a workspace over time, and a per-run
--      cap cannot make it: ten runs of ten is a hundred, and eleven runs is
--      a hundred and ten.
--   4. Contacts deduplicated PER LIST, so the same person imported twice sat
--      in two lists with two ids -- and `idx_linkedin_campaign_members_one_active`,
--      which is keyed on contact_id, then happily let both be enrolled. The
--      one-lead-one-campaign rule was bypassable by uploading a CSV twice.
--
-- EVERYTHING HERE IS ADDITIVE. Every existing writer keeps working: the new
-- columns are nullable, the settings row is optional with a code-side default,
-- and the only rows this migration removes are duplicates that the new index
-- would otherwise have refused to be created over.

/* ---------------------------------------------------------------------------
 * 1 + 2. Where a lead came from, and who they are.
 * ------------------------------------------------------------------------ */

ALTER TABLE linkedin_leads
  -- The post this person was found on, canonical. NULL for a search result:
  -- there is no post behind a search card, and '' would be a lie about one.
  ADD COLUMN IF NOT EXISTS post_url TEXT,
  -- 'post'    -- they WROTE the post the keyword matched
  -- 'comment' -- they commented on it
  -- NULL      -- neither: a search hit, or somebody who only reacted
  --
  -- A reactor is deliberately NOT folded into one of the two. They left no
  -- words; recording them as a commenter would put an opening line in an
  -- operator's mouth that the page never supported.
  ADD COLUMN IF NOT EXISTS interaction_kind TEXT,
  -- The scrubbed halves of `name`. Kept ALONGSIDE it rather than replacing it:
  -- `name` is what the card showed and is the provenance record, while these
  -- two are what a message is built from.
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT;

-- The kind is a closed set, enforced here rather than trusted from the writer:
-- a third string arriving from a future surface would be a value every reader
-- has to guess the meaning of.
DO $$
BEGIN
  ALTER TABLE linkedin_leads
    ADD CONSTRAINT linkedin_leads_interaction_kind_check
    CHECK (interaction_kind IS NULL OR interaction_kind IN ('post', 'comment'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Backfill first/last from the names already stored.
--
-- THIS IS `splitAndScrubName` IN SQL, and it is written out rather than left
-- to a later code path for one reason: a row an operator can already see must
-- not answer "first name" differently depending on whether it was harvested
-- before or after this migration. The three rules are the same three:
--
--   * strip anything that is not a letter, a digit, whitespace, an apostrophe
--     or a hyphen -- which takes the emoji and the punctuation and leaves
--     O'Connor and Anne-Marie intact (POSIX [:alnum:] is Unicode-aware here,
--     so non-Latin scripts survive);
--   * drop WHOLE TOKENS that are titles or credentials, never substrings, so
--     `ma` goes and `Maya` stays;
--   * first token is the given name, everything after it is the surname.
WITH scrubbed AS (
  SELECT
    l.id,
    trim(regexp_replace(
      array_to_string(
        ARRAY(
          SELECT token
          FROM unnest(regexp_split_to_array(
            regexp_replace(l.name, '[^[:alnum:][:space:]''-]', ' ', 'g'),
            '\s+'
          )) AS token
          WHERE token <> ''
            AND lower(token) <> ALL (ARRAY[
              'mr','ms','mrs','miss','jr','sr','snr','jnr','prof','professor','dr','drs','doc','doctor',
              'phd','ba','bfa','bs','ma','mba','mfa','jd','md','do','ceo','lion','lme','lmt','mim','msc',
              'sip','rpm'
            ])
        ),
        ' '
      ),
      '\s+', ' ', 'g'
    )) AS clean
  FROM linkedin_leads l
  WHERE l.name IS NOT NULL
    AND l.first_name IS NULL
    AND l.last_name IS NULL
)
UPDATE linkedin_leads l
SET first_name = NULLIF(split_part(s.clean, ' ', 1), ''),
    last_name = NULLIF(trim(substr(s.clean, length(split_part(s.clean, ' ', 1)) + 1)), '')
FROM scrubbed s
WHERE s.id = l.id AND s.clean <> '';

-- The rolling-window count the daily cap is enforced from: "how many leads did
-- this workspace store in the last 24 hours". Partial would be wrong here --
-- the window moves, so yesterday's rows are tomorrow's history and there is no
-- predicate that stays true.
CREATE INDEX IF NOT EXISTS idx_linkedin_leads_recent
  ON linkedin_leads(workspace_id, created_at DESC);

/* ---------------------------------------------------------------------------
 * 3. The daily lead cap.
 * ------------------------------------------------------------------------ */

-- One settings row per workspace, and the row is OPTIONAL: its absence means
-- the default, which lives in `leads.ts` as DEFAULT_DAILY_LEAD_CAP. A workspace
-- that never opened the setting is not different from one that set it to 100,
-- and writing a row on first read would make "has an operator chosen a cap?"
-- unanswerable.
CREATE TABLE IF NOT EXISTS linkedin_lead_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- 0 is a real and useful value: it stops all harvesting without touching the
  -- environment switch, which is the control an operator has at hand when they
  -- want to pause for a week. The ceiling is 1000 because a cap an operator can
  -- set to a million is not a cap.
  daily_lead_cap INTEGER NOT NULL DEFAULT 100
    CHECK (daily_lead_cap >= 0 AND daily_lead_cap <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* ---------------------------------------------------------------------------
 * 4. ONE PERSON, ONE CONTACT ROW, PER WORKSPACE.
 * ------------------------------------------------------------------------ */

-- Existing data is de-duplicated FIRST, because a CREATE UNIQUE INDEX over
-- rows that already violate it fails and takes the whole migration with it.
--
-- THE OLDEST ROW WINS, same attribution rule as idx_linkedin_leads_profile:
-- "where did this person first come from" stays answerable.

-- Step one: keep the campaign membership alive where it can be kept. At most
-- ONE member row per duplicate family is repointed at the survivor, and only
-- when the survivor has no membership of its own -- repointing two rows would
-- collide on (campaign_id, contact_id) or on the one-active claim, which is
-- the very rule this index exists to restore. The live states are preferred
-- over the terminal ones, then the oldest.
WITH fam AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY workspace_id, LOWER(profile_url)
      ORDER BY created_at, id
    ) AS keep_id
  FROM linkedin_lead_contacts
  WHERE profile_url IS NOT NULL
),
dupes AS (
  SELECT id AS dup_id, keep_id FROM fam WHERE id <> keep_id
),
candidate AS (
  SELECT DISTINCT ON (d.keep_id) m.id AS member_id, d.keep_id
  FROM linkedin_campaign_members m
  JOIN dupes d ON d.dup_id = m.contact_id
  WHERE NOT EXISTS (
    SELECT 1 FROM linkedin_campaign_members k WHERE k.contact_id = d.keep_id
  )
  ORDER BY
    d.keep_id,
    (m.status IN ('pending','active','waiting','manual','paused')) DESC,
    m.created_at,
    m.id
)
UPDATE linkedin_campaign_members m
SET contact_id = c.keep_id
FROM candidate c
WHERE m.id = c.member_id;

-- Step two: the duplicate contacts go. Whatever still pointed at them --
-- surplus memberships, manual tasks -- goes with them by cascade, which is the
-- honest outcome: those rows were a second copy of one person, and a queue
-- holding two tasks for one human is the bug, not the data.
WITH fam AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY workspace_id, LOWER(profile_url)
      ORDER BY created_at, id
    ) AS keep_id
  FROM linkedin_lead_contacts
  WHERE profile_url IS NOT NULL
)
DELETE FROM linkedin_lead_contacts c
USING fam f
WHERE c.id = f.id AND f.id <> f.keep_id;

-- The rule itself. WORKSPACE-WIDE rather than per-list, which is the whole
-- change: `idx_linkedin_lead_contacts_list_dedupe` only ever stopped a repeat
-- inside ONE list, so the same person in two lists had two contact ids, and
-- `idx_linkedin_campaign_members_one_active` -- keyed on contact_id -- saw two
-- different people and let both be enrolled.
--
-- PARTIAL on `profile_url IS NOT NULL`: a lead imported from a CSV with only
-- an email has no LinkedIn identity to be unique on, and NULLs would not
-- collide anyway. LOWER() for the same reason every other identity index here
-- folds case -- these strings arrive by hand, by CSV and by harvest.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_lead_contacts_workspace_profile
  ON linkedin_lead_contacts(workspace_id, LOWER(profile_url))
  WHERE profile_url IS NOT NULL;

-- 046's non-unique index on exactly the same expression is now redundant: the
-- unique one above serves every lookup it served. Two indexes on one
-- expression is two write costs for one read.
DROP INDEX IF EXISTS idx_linkedin_lead_contacts_profile;
