-- CRM write-back log.
--
-- Trevra reads contacts, companies and deals from HubSpot/Attio so the revenue
-- ledger sits OVER the CRM instead of becoming a second one. This table is the
-- other direction, and it is deliberately narrow: Trevra writes ACTIVITY
-- ("this happened, here is the evidence"), never records. It does not create
-- contacts, does not edit deal stages, and does not own any CRM object.
--
-- Every row corresponds to an action a human approved. The team's SDRs keep
-- living in their CRM and see the work Trevra did, which is the whole point --
-- outreach that never reaches the CRM is invisible to everyone but the founder
-- who approved it.

CREATE TABLE IF NOT EXISTS crm_activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  -- The local client this was matched to, when one was resolved.
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  -- The CRM's own id for the contact the note was attached to.
  contact_external_id TEXT,
  activity_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  -- What in Trevra caused this, e.g. ('outreach_post', <outreach_posts.id>).
  source_type TEXT,
  source_id TEXT,
  -- Same three-state discipline as outreach_posts, for the same reason: a CRM
  -- has no idempotency key on note creation, so the claim is ours to hold.
  --   'pending' -- claimed, write in flight or outcome unknown
  --   'written' -- the CRM returned an id
  --   'skipped' -- no contact could be resolved; nothing was sent
  --   'failed'  -- the CRM answered and refused; claim released for retry
  status TEXT NOT NULL,
  external_ref TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Replay guard. Derived from the approved action's payload hash, so retrying an
-- action cannot leave two identical notes on someone's CRM record. 'failed' is
-- excluded so a genuine retry after a CRM rejection can still succeed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_activities_idempotency
  ON crm_activities(workspace_id, provider, source_type, source_id)
  WHERE status <> 'failed';

CREATE INDEX IF NOT EXISTS idx_crm_activities_client
  ON crm_activities(workspace_id, client_id, created_at DESC);

-- Identity lookups drive contact resolution: a GitHub login or Mastodon acct on
-- a discovered thread is matched to a known client through contact_identities.
-- Until now only 'email' identities were ever written, so nothing indexed the
-- (provider, identity_value) pair this needs.
CREATE INDEX IF NOT EXISTS idx_contact_identities_lookup
  ON contact_identities(workspace_id, provider, identity_value);
