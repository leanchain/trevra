-- A lead may sit in SEVERAL LISTS and still be ONE PERSON with ONE campaign
-- claim -- and the identity that claim is keyed on now covers the leads that
-- have no LinkedIn profile at all.
--
-- TWO GAPS, AND THEY ARE THE SAME GAP SEEN FROM TWO SIDES. Membership lived in
-- a single `linkedin_lead_contacts.list_id` column, so "which list is this
-- person in" had exactly one answer and the schema had to choose between two
-- things the product needs at once:
--
--   1. ONE PERSON, MANY LISTS. 048 made a contact unique per workspace, which
--      is right, but with membership on the contact row that also made a
--      person unique per LIST. Importing 500 leads into "Q3 founders" when 200
--      of them already sat in an older list produced a THREE HUNDRED ROW LIST:
--      the other 200 were found, reported as duplicates, and left where they
--      were. The campaign built on that list could never reach them, and
--      nothing anywhere said so. The brief constrains one CAMPAIGN per lead.
--      It never said one LIST per lead.
--   2. ONE PERSON, ONE ROW -- EVEN WITHOUT A PROFILE URL. 048's uniqueness is
--      partial, `WHERE profile_url IS NOT NULL`, so a CSV lead carrying only a
--      name and an email deduplicated PER LIST and nothing else. The same
--      human in two lists became two contact ids, and
--      `idx_linkedin_campaign_members_one_active` -- keyed on contact_id --
--      saw two different people and enrolled both. `leadDedupeKey` had been
--      computing an email/name identity for those leads since day one and no
--      index had ever enforced it.
--
-- Splitting membership out of the contact row closes the first and MAKES THE
-- SECOND SAFE TO CLOSE: a workspace-wide unique on `dedupe_key` is only
-- possible once a person no longer needs a second row to be in a second list.
--
-- EVERYTHING HERE IS ADDITIVE OR A MERGE. `list_id` keeps its NOT NULL and its
-- meaning narrows to "the list this person first arrived in", so every
-- existing reader keeps working; the only rows removed are duplicates the new
-- index would otherwise refuse to be created over, and their list memberships
-- and campaign membership are moved to the survivor first.

/* ---------------------------------------------------------------------------
 * 1. Membership becomes its own table.
 * ------------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS linkedin_lead_list_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES linkedin_lead_lists(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES linkedin_lead_contacts(id) ON DELETE CASCADE,
  -- When this person joined THIS list, which is not when the contact row was
  -- created: a lead uploaded in January and added to a March list belongs at
  -- the end of the March list, not the top of it.
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (list_id, contact_id)
);

-- "Which lists is this person in" -- the direction the primary key cannot
-- answer, and the one a merge and a lead detail view both need.
CREATE INDEX IF NOT EXISTS idx_linkedin_lead_list_members_contact
  ON linkedin_lead_list_members(workspace_id, contact_id);

-- Backfill from the column that used to hold this. Idempotent by the primary
-- key, so a re-run adds nothing.
INSERT INTO linkedin_lead_list_members (workspace_id, list_id, contact_id, created_at)
SELECT workspace_id, list_id, id, created_at FROM linkedin_lead_contacts
ON CONFLICT DO NOTHING;

-- NOTE FOR WHOEVER ADDS "DELETE A LEAD LIST": there is no such path today, and
-- when there is, `linkedin_lead_contacts.list_id` still cascades. A person
-- whose ORIGIN list is deleted would be deleted with it even though they sit
-- in other lists. Repoint the origin (or drop the FK to ON DELETE SET NULL and
-- make the column nullable) before shipping that route.

/* ---------------------------------------------------------------------------
 * 2. One person, one contact row -- keyed on the identity, not on the profile.
 * ------------------------------------------------------------------------ */

-- Existing duplicates are merged FIRST, because CREATE UNIQUE INDEX over rows
-- that already violate it fails and takes the whole migration with it.
--
-- THE OLDEST ROW WINS, the same attribution rule 048 and
-- idx_linkedin_leads_profile use: "where did this person first come from"
-- stays answerable.

-- Step one: the survivor inherits every list the duplicates were in. This runs
-- BEFORE the delete for the obvious reason -- the cascade would otherwise take
-- those membership rows with the duplicate that held them.
WITH fam AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY workspace_id, dedupe_key
      ORDER BY created_at, id
    ) AS keep_id
  FROM linkedin_lead_contacts
),
dupes AS (
  SELECT id AS dup_id, keep_id FROM fam WHERE id <> keep_id
)
INSERT INTO linkedin_lead_list_members (workspace_id, list_id, contact_id, created_at)
SELECT m.workspace_id, m.list_id, d.keep_id, m.created_at
FROM linkedin_lead_list_members m
JOIN dupes d ON d.dup_id = m.contact_id
ON CONFLICT DO NOTHING;

-- Step two: keep the campaign membership alive where it can be kept. At most
-- ONE member row per duplicate family is repointed at the survivor, and only
-- when the survivor has no membership of its own -- repointing two would
-- collide on (campaign_id, contact_id) or on the one-active claim, which is
-- the very rule this migration exists to extend. Live states beat terminal
-- ones, then the oldest. Identical to 048's step, over the wider key.
WITH fam AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY workspace_id, dedupe_key
      ORDER BY created_at, id
    ) AS keep_id
  FROM linkedin_lead_contacts
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

-- Step three: the duplicate contacts go. Whatever still points at them --
-- surplus memberships, manual tasks -- goes with them by cascade, which is the
-- honest outcome: those rows were a second copy of one person, and a queue
-- holding two tasks for one human is the bug, not the data.
WITH fam AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY workspace_id, dedupe_key
      ORDER BY created_at, id
    ) AS keep_id
  FROM linkedin_lead_contacts
)
DELETE FROM linkedin_lead_contacts c
USING fam f
WHERE c.id = f.id AND f.id <> f.keep_id;

-- The rule itself, over the identity `leadDedupeKey` has always computed:
-- the canonical profile URL when there is one, else the email, else the
-- name-at-company. NOT PARTIAL, unlike 048's -- every contact has a
-- `dedupe_key`, which is the whole point of having one.
--
-- WHAT THIS COSTS, SAID OUT LOUD: two different people who share a name AND an
-- employer AND have neither a LinkedIn profile nor an email are now one lead.
-- That is the same trade the campaign claim already makes -- there is no
-- information left to tell them apart with -- and the repair is to give one of
-- them a profile URL or an address, which `updateLeadContact` will then
-- accept. The alternative is two contact rows that both enrol in campaigns
-- while looking identical in every column an operator can see.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_lead_contacts_workspace_dedupe
  ON linkedin_lead_contacts(workspace_id, dedupe_key);

-- 046's per-list dedupe is now strictly weaker than the index above and is the
-- one that made a person unique per LIST rather than per workspace. Dropping
-- it is the second half of "a lead may be in several lists".
DROP INDEX IF EXISTS idx_linkedin_lead_contacts_list_dedupe;
