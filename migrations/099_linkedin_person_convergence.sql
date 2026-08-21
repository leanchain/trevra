-- Converge LinkedIn lead identities onto the canonical GTM Person spine.
--
-- LinkedIn keeps its channel-specific contact row because campaign state, list
-- membership, enrichment evidence and delivery state belong there. `person_id`
-- points that row at the canonical human. Rows without deterministic identity
-- deliberately remain unresolved; names are never used as an identity key.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS linkedin_url TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_url_normalized TEXT;

UPDATE contacts
SET linkedin_url_normalized=LOWER(BTRIM(linkedin_url))
WHERE linkedin_url IS NOT NULL AND linkedin_url_normalized IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_workspace_linkedin
  ON contacts(workspace_id, linkedin_url_normalized)
  WHERE linkedin_url_normalized IS NOT NULL;

ALTER TABLE linkedin_lead_contacts
  ADD COLUMN IF NOT EXISTS person_id TEXT,
  ADD COLUMN IF NOT EXISTS person_resolution_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (person_resolution_status IN ('unresolved','resolved','insufficient_identity','conflict'));

-- Reuse an existing canonical Person only when every matching deterministic
-- identity points at the same row. Conflicting email/profile/phone identities
-- remain unresolved for review instead of silently picking a winner.
WITH candidates AS (
  SELECT l.id AS lead_id, c.id AS contact_id
  FROM linkedin_lead_contacts l
  JOIN contacts c
    ON c.workspace_id=l.workspace_id
   AND NULLIF(BTRIM(l.email),'') IS NOT NULL
   AND c.email_normalized=LOWER(BTRIM(l.email))
  UNION
  SELECT l.id, c.id
  FROM linkedin_lead_contacts l
  JOIN contacts c
    ON c.workspace_id=l.workspace_id
   AND NULLIF(BTRIM(l.profile_url),'') IS NOT NULL
   AND c.linkedin_url_normalized=LOWER(BTRIM(l.profile_url))
  UNION
  SELECT l.id, c.id
  FROM linkedin_lead_contacts l
  JOIN contacts c
    ON c.workspace_id=l.workspace_id
   AND l.phone ~ E'^\\+[1-9][0-9]{7,14}$'
   AND c.phone_normalized=BTRIM(l.phone)
), resolved AS (
  SELECT lead_id, MIN(contact_id) AS contact_id
  FROM candidates
  GROUP BY lead_id
  HAVING COUNT(DISTINCT contact_id)=1
)
UPDATE linkedin_lead_contacts l
SET person_id=r.contact_id
FROM resolved r
WHERE l.id=r.lead_id AND l.person_id IS NULL;

-- Create a canonical Person for deterministic LinkedIn leads that still have no
-- match. Name/company alone is intentionally insufficient.
INSERT INTO contacts (
  id,workspace_id,name,email,email_normalized,phone,phone_normalized,role,
  linkedin_url,linkedin_url_normalized,created_at,updated_at
)
SELECT
  'con_li_' || md5(l.workspace_id || ':' || l.id),
  l.workspace_id,
  NULLIF(BTRIM(CONCAT_WS(' ', NULLIF(l.first_name,''), NULLIF(l.last_name,''))), ''),
  NULLIF(BTRIM(l.email), ''),
  CASE WHEN NULLIF(BTRIM(l.email),'') IS NULL THEN NULL ELSE LOWER(BTRIM(l.email)) END,
  CASE WHEN l.phone ~ E'^\\+[1-9][0-9]{7,14}$' THEN BTRIM(l.phone) ELSE NULL END,
  CASE WHEN l.phone ~ E'^\\+[1-9][0-9]{7,14}$' THEN BTRIM(l.phone) ELSE NULL END,
  NULL,
  NULLIF(BTRIM(l.profile_url), ''),
  CASE
    WHEN NULLIF(BTRIM(l.profile_url),'') IS NULL THEN NULL
    ELSE LOWER(BTRIM(l.profile_url))
  END,
  l.created_at,
  GREATEST(l.created_at,l.updated_at)
FROM linkedin_lead_contacts l
WHERE l.person_id IS NULL
  AND (
    NULLIF(BTRIM(l.email),'') IS NOT NULL
    OR l.phone ~ E'^\\+[1-9][0-9]{7,14}$'
    OR NULLIF(BTRIM(l.profile_url),'') IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.workspace_id=l.workspace_id AND (
      (NULLIF(BTRIM(l.email),'') IS NOT NULL AND c.email_normalized=LOWER(BTRIM(l.email)))
      OR (
        NULLIF(BTRIM(l.profile_url),'') IS NOT NULL
        AND c.linkedin_url_normalized=LOWER(BTRIM(l.profile_url))
      )
      OR (
        l.phone ~ E'^\\+[1-9][0-9]{7,14}$'
        AND c.phone_normalized=BTRIM(l.phone)
      )
    )
  )
ON CONFLICT DO NOTHING;

-- Resolve again after creation, with the same all-identities-must-agree rule.
WITH candidates AS (
  SELECT l.id AS lead_id, c.id AS contact_id
  FROM linkedin_lead_contacts l
  JOIN contacts c
    ON c.workspace_id=l.workspace_id
   AND NULLIF(BTRIM(l.email),'') IS NOT NULL
   AND c.email_normalized=LOWER(BTRIM(l.email))
  UNION
  SELECT l.id, c.id
  FROM linkedin_lead_contacts l
  JOIN contacts c
    ON c.workspace_id=l.workspace_id
   AND NULLIF(BTRIM(l.profile_url),'') IS NOT NULL
   AND c.linkedin_url_normalized=LOWER(BTRIM(l.profile_url))
  UNION
  SELECT l.id, c.id
  FROM linkedin_lead_contacts l
  JOIN contacts c
    ON c.workspace_id=l.workspace_id
   AND l.phone ~ E'^\\+[1-9][0-9]{7,14}$'
   AND c.phone_normalized=BTRIM(l.phone)
), resolved AS (
  SELECT lead_id, MIN(contact_id) AS contact_id
  FROM candidates
  GROUP BY lead_id
  HAVING COUNT(DISTINCT contact_id)=1
)
UPDATE linkedin_lead_contacts l
SET person_id=r.contact_id
FROM resolved r
WHERE l.id=r.lead_id AND l.person_id IS NULL;

-- Fill an empty canonical LinkedIn identity from linked channel evidence. Never
-- overwrite a non-empty canonical value.
UPDATE contacts c
SET linkedin_url=l.profile_url,
    linkedin_url_normalized=LOWER(BTRIM(l.profile_url)),
    updated_at=GREATEST(c.updated_at,l.updated_at)
FROM linkedin_lead_contacts l
WHERE l.person_id=c.id
  AND l.workspace_id=c.workspace_id
  AND c.linkedin_url_normalized IS NULL
  AND NULLIF(BTRIM(l.profile_url),'') IS NOT NULL;

UPDATE linkedin_lead_contacts
SET person_resolution_status='resolved'
WHERE person_id IS NOT NULL;

UPDATE linkedin_lead_contacts
SET person_resolution_status='insufficient_identity'
WHERE person_id IS NULL
  AND NULLIF(BTRIM(email),'') IS NULL
  AND NOT (phone ~ E'^\\+[1-9][0-9]{7,14}$')
  AND NULLIF(BTRIM(profile_url),'') IS NULL;

UPDATE linkedin_lead_contacts
SET person_resolution_status='conflict'
WHERE person_id IS NULL
  AND person_resolution_status='unresolved';

CREATE INDEX IF NOT EXISTS idx_linkedin_lead_contacts_person
  ON linkedin_lead_contacts(workspace_id, person_id)
  WHERE person_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='linkedin_lead_contacts_person_fkey'
      AND conrelid='linkedin_lead_contacts'::regclass
  ) THEN
    ALTER TABLE linkedin_lead_contacts
      ADD CONSTRAINT linkedin_lead_contacts_person_fkey
      FOREIGN KEY (workspace_id, person_id)
      REFERENCES contacts(workspace_id, id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN linkedin_lead_contacts.person_id IS
'Canonical GTM Person represented by this LinkedIn-specific lead row.';
COMMENT ON COLUMN linkedin_lead_contacts.person_resolution_status IS
'Deterministic Person-link status. conflict means identities disagree and require review; insufficient_identity means no email, LinkedIn profile, or E.164 phone exists.';
