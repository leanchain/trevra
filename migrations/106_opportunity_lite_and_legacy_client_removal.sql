-- Finish the canonical GTM identity cutover.
--
-- `clients` was a compatibility object from Trevra's original post-sale/revenue
-- model. Canonical human identity now lives in `contacts` (Person), company
-- identity in `accounts`, and an opportunity is intentionally minimal GTM state.
-- This migration preserves provider identities, rewires surviving GTM records,
-- then removes the legacy client object entirely.

CREATE TABLE IF NOT EXISTS person_identities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, provider, identity_type, normalized_value),
  FOREIGN KEY (workspace_id, person_id)
    REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_person_identities_person
  ON person_identities(workspace_id, person_id);
CREATE INDEX IF NOT EXISTS idx_person_identities_lookup
  ON person_identities(workspace_id, provider, identity_type, normalized_value);

-- Preserve every deterministic legacy provider identity before dropping the
-- compatibility table. Generated @trevra.invalid placeholders are not people.
INSERT INTO person_identities (
  id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at
)
SELECT
  'pid_' || SUBSTR(MD5(ci.workspace_id || ':' || ci.provider || ':' || ci.identity_type || ':' || LOWER(BTRIM(ci.identity_value))),1,24),
  ci.workspace_id,
  ci.person_id,
  ci.provider,
  ci.identity_type,
  ci.identity_value,
  LOWER(BTRIM(ci.identity_value)),
  ci.created_at
FROM contact_identities ci
WHERE ci.person_id IS NOT NULL
  AND NULLIF(BTRIM(ci.identity_value),'') IS NOT NULL
  AND LOWER(ci.identity_value) NOT LIKE '%@trevra.invalid'
ON CONFLICT DO NOTHING;

-- Canonical identities are useful to channel/CRM resolvers even when no legacy
-- provider row ever existed.
INSERT INTO person_identities (id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at)
SELECT 'pid_' || SUBSTR(MD5(c.workspace_id || ':canonical:email:' || c.email_normalized),1,24),
       c.workspace_id,c.id,'canonical','email',c.email,c.email_normalized,c.created_at
FROM contacts c
WHERE c.email_normalized IS NOT NULL AND c.email IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO person_identities (id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at)
SELECT 'pid_' || SUBSTR(MD5(c.workspace_id || ':canonical:phone:' || c.phone_normalized),1,24),
       c.workspace_id,c.id,'canonical','phone',c.phone,c.phone_normalized,c.created_at
FROM contacts c
WHERE c.phone_normalized IS NOT NULL AND c.phone IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO person_identities (id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at)
SELECT 'pid_' || SUBSTR(MD5(c.workspace_id || ':linkedin:profile_url:' || c.linkedin_url_normalized),1,24),
       c.workspace_id,c.id,'linkedin','profile_url',c.linkedin_url,c.linkedin_url_normalized,c.created_at
FROM contacts c
WHERE c.linkedin_url_normalized IS NOT NULL AND c.linkedin_url IS NOT NULL
ON CONFLICT DO NOTHING;

-- Shared GTM messages can concern a Person and/or Account. They no longer need
-- a fake client parent simply to exist.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS account_id TEXT;
UPDATE messages m
SET person_id=c.person_id
FROM clients c
WHERE m.workspace_id=c.workspace_id AND m.client_id=c.id
  AND m.person_id IS NULL AND c.person_id IS NOT NULL;

WITH one_account AS (
  SELECT workspace_id,contact_id,MIN(account_id) AS account_id
  FROM account_contacts
  GROUP BY workspace_id,contact_id
  HAVING COUNT(DISTINCT account_id)=1
)
UPDATE messages m
SET account_id=a.account_id
FROM one_account a
WHERE m.workspace_id=a.workspace_id AND m.person_id=a.contact_id AND m.account_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_account_workspace_fkey') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_account_workspace_fkey
      FOREIGN KEY (workspace_id,account_id) REFERENCES accounts(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

-- Opportunity-lite: commercial progression only, no amount/revenue model and
-- no CRM-custom-object surface. External CRM-specific stages remain in source
-- evidence; Trevra stores only this bounded GTM stage vocabulary.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS account_id TEXT,
  ADD COLUMN IF NOT EXISTS stage TEXT,
  ADD COLUMN IF NOT EXISTS owner_type TEXT,
  ADD COLUMN IF NOT EXISTS owner_id TEXT,
  ADD COLUMN IF NOT EXISTS next_action TEXT,
  ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE opportunities o
SET person_id=c.person_id
FROM clients c
WHERE o.workspace_id=c.workspace_id AND o.client_id=c.id
  AND o.person_id IS NULL AND c.person_id IS NOT NULL;

WITH one_account AS (
  SELECT workspace_id,contact_id,MIN(account_id) AS account_id
  FROM account_contacts
  GROUP BY workspace_id,contact_id
  HAVING COUNT(DISTINCT account_id)=1
)
UPDATE opportunities o
SET account_id=a.account_id
FROM one_account a
WHERE o.workspace_id=a.workspace_id AND o.person_id=a.contact_id AND o.account_id IS NULL;

UPDATE opportunities
SET stage=CASE LOWER(BTRIM(status))
  WHEN 'qualified' THEN 'qualified'
  WHEN 'meeting' THEN 'meeting'
  WHEN 'meeting_booked' THEN 'meeting'
  WHEN 'proposal' THEN 'proposal'
  WHEN 'proposal_sent' THEN 'proposal'
  WHEN 'won' THEN 'won'
  WHEN 'closed_won' THEN 'won'
  WHEN 'lost' THEN 'lost'
  WHEN 'closed_lost' THEN 'lost'
  ELSE 'new'
END
WHERE stage IS NULL;

UPDATE opportunities SET updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP);
UPDATE opportunities
SET closed_at=COALESCE(closed_at,updated_at)
WHERE stage IN ('won','lost') AND closed_at IS NULL;

ALTER TABLE opportunities ALTER COLUMN stage SET NOT NULL;
ALTER TABLE opportunities ALTER COLUMN updated_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='opportunities_stage_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_stage_check
      CHECK (stage IN ('new','qualified','meeting','proposal','won','lost')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='opportunities_owner_type_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_owner_type_check
      CHECK (owner_type IS NULL OR owner_type IN ('user','agent','system')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='opportunities_account_workspace_fkey') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_account_workspace_fkey
      FOREIGN KEY (workspace_id,account_id) REFERENCES accounts(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_opportunities_stage
  ON opportunities(workspace_id,stage,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_account
  ON opportunities(workspace_id,account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_next_action
  ON opportunities(workspace_id,next_action_at) WHERE next_action_at IS NOT NULL;

-- Recommendations are Person/Account GTM attention, not client-management rows.
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS person_id TEXT,
  ADD COLUMN IF NOT EXISTS account_id TEXT;

UPDATE recommendations r
SET person_id=c.person_id
FROM clients c
WHERE r.workspace_id=c.workspace_id AND r.client_id=c.id
  AND r.person_id IS NULL AND c.person_id IS NOT NULL;

WITH one_account AS (
  SELECT workspace_id,contact_id,MIN(account_id) AS account_id
  FROM account_contacts
  GROUP BY workspace_id,contact_id
  HAVING COUNT(DISTINCT account_id)=1
)
UPDATE recommendations r
SET account_id=a.account_id
FROM one_account a
WHERE r.workspace_id=a.workspace_id AND r.person_id=a.contact_id AND r.account_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='recommendations_person_workspace_fkey') THEN
    ALTER TABLE recommendations ADD CONSTRAINT recommendations_person_workspace_fkey
      FOREIGN KEY (workspace_id,person_id) REFERENCES contacts(workspace_id,id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='recommendations_account_workspace_fkey') THEN
    ALTER TABLE recommendations ADD CONSTRAINT recommendations_account_workspace_fkey
      FOREIGN KEY (workspace_id,account_id) REFERENCES accounts(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_recommendations_person
  ON recommendations(workspace_id,person_id,created_at DESC) WHERE person_id IS NOT NULL;

-- CRM activity is already Person-attributed after migration 099.
UPDATE crm_activities a
SET person_id=c.person_id
FROM clients c
WHERE a.workspace_id=c.workspace_id AND a.client_id=c.id
  AND a.person_id IS NULL AND c.person_id IS NOT NULL;

-- Remove compatibility references first, then the compatibility objects.
ALTER TABLE messages DROP COLUMN IF EXISTS client_id;
ALTER TABLE opportunities DROP COLUMN IF EXISTS client_id;
ALTER TABLE opportunities DROP COLUMN IF EXISTS status;
ALTER TABLE recommendations DROP COLUMN IF EXISTS client_id;
ALTER TABLE crm_activities DROP COLUMN IF EXISTS client_id;

DROP TABLE IF EXISTS contact_identities CASCADE;
DROP TABLE IF EXISTS clients CASCADE;

-- Historical client projections are compatibility-state snapshots, not GTM
-- evidence. Keep source/action ledger history, but scrub this deleted object.
DELETE FROM commercial_entity_projections WHERE entity_type='clients';
DELETE FROM commercial_entity_versions WHERE entity_type='clients';
DELETE FROM commercial_entity_events WHERE entity_type='clients';

COMMENT ON TABLE person_identities IS
'Deterministic provider/channel identities for canonical GTM People. Credentials never live here.';
COMMENT ON TABLE opportunities IS
'Minimal Trevra GTM opportunity state. Revenue, quote, territory and CRM-custom-field ownership are intentionally absent.';
