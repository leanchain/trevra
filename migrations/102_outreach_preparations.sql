-- Narrow idempotency/correlation state for intent-first outreach preparation.
--
-- This is NOT a universal GTM job table. The durable product objects remain
-- lead lists, workflows and campaigns; this row only makes the composition
-- endpoint retry-safe across process/network failures.

CREATE TABLE IF NOT EXISTS outreach_preparations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing','prepared','failed')),
  sender_key TEXT,
  lead_list_id TEXT,
  workflow_id TEXT,
  campaign_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outreach_preparations_workspace_recent
  ON outreach_preparations(workspace_id,created_at DESC);

-- The campaign carries the preparation correlation as well. If the process
-- commits campaign creation and dies before it can update outreach_preparations,
-- a retry can recover the exact draft instead of creating a second one.
ALTER TABLE linkedin_campaigns ADD COLUMN IF NOT EXISTS preparation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_campaigns_preparation
  ON linkedin_campaigns(workspace_id,preparation_id)
  WHERE preparation_id IS NOT NULL;
