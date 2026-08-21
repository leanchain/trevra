-- Generic, workspace-scoped GTM lead capture.
--
-- People are independent of Accounts. Capture Sources own routing credentials.
-- Inbound submissions are immutable evidence and never execute outreach directly.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT,
  email_normalized TEXT,
  phone TEXT,
  phone_normalized TEXT,
  role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_workspace_email
  ON contacts(workspace_id, email_normalized)
  WHERE email_normalized IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_workspace_phone
  ON contacts(workspace_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_workspace_recent
  ON contacts(workspace_id, created_at DESC);

-- Composite foreign keys below use workspace + id to make cross-tenant links
-- impossible at the database boundary. Accounts predates that shape, so add a
-- redundant-but-authoritative unique key for those references.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_workspace_id
  ON accounts(workspace_id, id);

CREATE TABLE IF NOT EXISTS capture_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_seen_at TIMESTAMPTZ,
  accepted_count BIGINT NOT NULL DEFAULT 0,
  rejected_count BIGINT NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_capture_sources_workspace
  ON capture_sources(workspace_id, created_at DESC);

-- Same encrypted-envelope posture as Trevra's other secret stores. The slot is
-- part of the AES-GCM AAD, so active/previous ciphertext cannot be swapped.
CREATE TABLE IF NOT EXISTS capture_source_secrets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  capture_source_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('active', 'previous')),
  ciphertext BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version INTEGER NOT NULL,
  key_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (capture_source_id, slot),
  FOREIGN KEY (workspace_id, capture_source_id)
    REFERENCES capture_sources(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contact_external_identities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  capture_source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (capture_source_id, external_id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES contacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, capture_source_id)
    REFERENCES capture_sources(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_external_workspace_contact
  ON contact_external_identities(workspace_id, contact_id);

CREATE TABLE IF NOT EXISTS account_contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'explicit' CHECK (confidence IN ('explicit', 'verified', 'inferred')),
  source_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, account_id, contact_id),
  FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_contacts_contact
  ON account_contacts(workspace_id, contact_id);

CREATE TABLE IF NOT EXISTS inbound_submissions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  capture_source_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  account_id TEXT,
  idempotency_key TEXT NOT NULL,
  source_event_id TEXT,
  kind TEXT NOT NULL,
  person_name TEXT,
  person_email TEXT,
  person_phone TEXT,
  person_role TEXT,
  person_external_id TEXT,
  company_domain TEXT,
  company_name TEXT,
  message TEXT,
  page_url TEXT,
  referrer TEXT,
  attribution_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (capture_source_id, idempotency_key),
  FOREIGN KEY (workspace_id, capture_source_id)
    REFERENCES capture_sources(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES contacts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts(workspace_id, id) ON DELETE SET NULL (account_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_submissions_workspace_recent
  ON inbound_submissions(workspace_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_submissions_contact_recent
  ON inbound_submissions(workspace_id, contact_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_submissions_source_recent
  ON inbound_submissions(capture_source_id, received_at DESC);
