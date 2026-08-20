-- Ownership and template scope for team/agency campaign operation.
ALTER TABLE linkedin_campaigns
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE linkedin_seats
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE linkedin_workflows
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE linkedin_workflows
    ADD CONSTRAINT linkedin_workflows_scope_check CHECK (scope IN ('workspace','personal'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_linkedin_campaigns_owner
  ON linkedin_campaigns(workspace_id,owner_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_linkedin_seats_owner
  ON linkedin_seats(workspace_id,owner_user_id,seat_key);
CREATE INDEX IF NOT EXISTS idx_linkedin_workflows_scope_owner
  ON linkedin_workflows(workspace_id,scope,owner_user_id,updated_at DESC);
