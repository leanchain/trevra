-- Converge the remaining legacy connected-ingestion identity onto canonical People.
-- `clients` remains temporarily because recommendations and older message/opportunity
-- code still reference it, but it is no longer allowed to be the only human identity.

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_workspace_id
  ON clients(workspace_id, id);

ALTER TABLE clients ADD COLUMN IF NOT EXISTS person_id TEXT;
ALTER TABLE contact_identities ADD COLUMN IF NOT EXISTS person_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS person_id TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS person_id TEXT;
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS person_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='clients_person_workspace_fkey') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_person_workspace_fkey
      FOREIGN KEY (workspace_id,person_id) REFERENCES contacts(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contact_identities_person_workspace_fkey') THEN
    ALTER TABLE contact_identities ADD CONSTRAINT contact_identities_person_workspace_fkey
      FOREIGN KEY (workspace_id,person_id) REFERENCES contacts(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_person_workspace_fkey') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_person_workspace_fkey
      FOREIGN KEY (workspace_id,person_id) REFERENCES contacts(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='opportunities_person_workspace_fkey') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_person_workspace_fkey
      FOREIGN KEY (workspace_id,person_id) REFERENCES contacts(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='crm_activities_person_workspace_fkey') THEN
    ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_person_workspace_fkey
      FOREIGN KEY (workspace_id,person_id) REFERENCES contacts(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clients_person ON clients(workspace_id,person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_identities_person ON contact_identities(workspace_id,person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_person_time ON messages(workspace_id,person_id,occurred_at DESC) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_person ON opportunities(workspace_id,person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_activities_person ON crm_activities(workspace_id,person_id,created_at DESC) WHERE person_id IS NOT NULL;

-- Generated @trevra.invalid addresses are legacy placeholders, not identities.
UPDATE clients c
SET person_id=p.id
FROM contacts p
WHERE c.person_id IS NULL
  AND c.email NOT LIKE '%@trevra.invalid'
  AND p.workspace_id=c.workspace_id
  AND p.email_normalized=LOWER(TRIM(c.email));

INSERT INTO contacts (
  id,workspace_id,name,email,email_normalized,created_at,updated_at
)
SELECT
  'con_' || SUBSTR(MD5('legacy-client:' || c.workspace_id || ':' || c.id),1,24),
  c.workspace_id,
  NULLIF(TRIM(c.contact_name),''),
  TRIM(c.email),
  LOWER(TRIM(c.email)),
  c.created_at,
  GREATEST(c.created_at,c.last_interaction_at)
FROM clients c
WHERE c.person_id IS NULL
  AND NULLIF(TRIM(c.email),'') IS NOT NULL
  AND c.email NOT LIKE '%@trevra.invalid'
  AND NOT EXISTS (
    SELECT 1 FROM contacts p
    WHERE p.workspace_id=c.workspace_id AND p.email_normalized=LOWER(TRIM(c.email))
  )
ON CONFLICT DO NOTHING;

UPDATE clients c
SET person_id=p.id
FROM contacts p
WHERE c.person_id IS NULL
  AND c.email NOT LIKE '%@trevra.invalid'
  AND p.workspace_id=c.workspace_id
  AND p.email_normalized=LOWER(TRIM(c.email));

UPDATE contact_identities ci
SET person_id=c.person_id
FROM clients c
WHERE ci.workspace_id=c.workspace_id
  AND ci.client_id=c.id
  AND ci.person_id IS NULL
  AND c.person_id IS NOT NULL;

UPDATE messages m
SET person_id=c.person_id
FROM clients c
WHERE m.workspace_id=c.workspace_id
  AND m.client_id=c.id
  AND m.person_id IS NULL
  AND c.person_id IS NOT NULL;

UPDATE opportunities o
SET person_id=c.person_id
FROM clients c
WHERE o.workspace_id=c.workspace_id
  AND o.client_id=c.id
  AND o.person_id IS NULL
  AND c.person_id IS NOT NULL;

UPDATE crm_activities a
SET person_id=c.person_id
FROM clients c
WHERE a.workspace_id=c.workspace_id
  AND a.client_id=c.id
  AND a.person_id IS NULL
  AND c.person_id IS NOT NULL;

COMMENT ON COLUMN clients.person_id IS
'Temporary bridge to canonical GTM Person. New human identity belongs in contacts; clients is legacy compatibility state pending removal.';
COMMENT ON COLUMN messages.person_id IS
'Canonical GTM Person concerned by this message when deterministically known.';
COMMENT ON COLUMN opportunities.person_id IS
'Canonical GTM Person associated with this minimal GTM opportunity when deterministically known.';
