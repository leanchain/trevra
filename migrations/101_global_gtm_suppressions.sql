-- Workspace-wide GTM suppression authority.
--
-- Channel-local do-not-contact flags remain useful evidence/UI state, but no
-- outbound path may treat them as the only authority. Suppressions can target a
-- canonical Person, email, email domain, LinkedIn profile, or any combination.

CREATE TABLE IF NOT EXISTS suppressions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id TEXT,
  email_normalized TEXT,
  domain_normalized TEXT,
  linkedin_url TEXT,
  channel TEXT NOT NULL DEFAULT 'all'
    CHECK (channel IN ('all','email','linkedin','community')),
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  created_by_type TEXT NOT NULL DEFAULT 'system'
    CHECK (created_by_type IN ('human','agent','system')),
  created_by_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lifted_at TIMESTAMPTZ,
  lifted_by_type TEXT,
  lifted_by_id TEXT,
  CHECK (
    person_id IS NOT NULL OR email_normalized IS NOT NULL OR
    domain_normalized IS NOT NULL OR linkedin_url IS NOT NULL
  ),
  FOREIGN KEY (workspace_id,person_id)
    REFERENCES contacts(workspace_id,id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressions_active_scope
  ON suppressions(
    workspace_id,
    channel,
    COALESCE(person_id,''),
    COALESCE(email_normalized,''),
    COALESCE(domain_normalized,''),
    COALESCE(LOWER(linkedin_url),'')
  )
  WHERE lifted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_suppressions_person
  ON suppressions(workspace_id,person_id)
  WHERE lifted_at IS NULL AND person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppressions_email
  ON suppressions(workspace_id,email_normalized)
  WHERE lifted_at IS NULL AND email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppressions_domain
  ON suppressions(workspace_id,domain_normalized)
  WHERE lifted_at IS NULL AND domain_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppressions_linkedin
  ON suppressions(workspace_id,LOWER(linkedin_url))
  WHERE lifted_at IS NULL AND linkedin_url IS NOT NULL;

-- Preserve existing LinkedIn DNC intent as a LinkedIn-channel suppression. Do
-- not broaden it to email retroactively: the old control only governed LinkedIn.
INSERT INTO suppressions (
  id,workspace_id,person_id,email_normalized,linkedin_url,channel,
  reason,source,source_ref,created_by_type,created_at
)
SELECT
  'sup_' || SUBSTR(MD5('linkedin-dnc:' || c.workspace_id || ':' || c.id),1,24),
  c.workspace_id,
  c.person_id,
  CASE WHEN NULLIF(TRIM(c.email),'') IS NOT NULL THEN LOWER(TRIM(c.email)) ELSE NULL END,
  NULLIF(TRIM(c.profile_url),''),
  'linkedin',
  'Marked do-not-contact in LinkedIn lead manager',
  'linkedin_lead',
  c.id,
  'system',
  c.updated_at
FROM linkedin_lead_contacts c
WHERE c.do_not_contact=TRUE
  AND (
    c.person_id IS NOT NULL OR NULLIF(TRIM(c.email),'') IS NOT NULL OR
    NULLIF(TRIM(c.profile_url),'') IS NOT NULL
  )
ON CONFLICT DO NOTHING;
