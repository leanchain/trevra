-- Durable inbound lead signals. A signal is evidence that a lead should enter a
-- configured audience; it is never itself an outbound action and therefore
-- never bypasses campaign admission/waves.
CREATE TABLE IF NOT EXISTS linkedin_lead_signals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES linkedin_lead_lists(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES linkedin_lead_contacts(id) ON DELETE CASCADE,
  signal_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_ref TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  ALTER TABLE linkedin_lead_signals
    ADD CONSTRAINT linkedin_lead_signals_kind_check
    CHECK (signal_kind IN ('profile_viewed','post_engaged','event_attended','job_changed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_lead_signals_idempotency
  ON linkedin_lead_signals(workspace_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_linkedin_lead_signals_contact_recent
  ON linkedin_lead_signals(workspace_id,contact_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_linkedin_lead_signals_list_recent
  ON linkedin_lead_signals(workspace_id,list_id,occurred_at DESC);
