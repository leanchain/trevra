-- Shared GTM email delivery state and verified inbound outcome metadata.
--
-- Channel-specific campaign/action rows continue to own their orchestration
-- mechanics. This table owns the one fact every email path must agree on:
-- whether the exact approved payload was sent, definitely failed, or has an
-- ambiguous provider outcome that must never be blindly retried.

CREATE TABLE IF NOT EXISTS gtm_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL DEFAULT 'outreach' CHECK (purpose IN ('outreach','reply','other')),
  recipient TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','uncertain')),
  provider TEXT,
  external_ref TEXT,
  internet_message_id TEXT,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id,idempotency_key),
  UNIQUE (workspace_id,source_type,source_id)
);
CREATE INDEX IF NOT EXISTS idx_gtm_deliveries_workspace_recent
  ON gtm_deliveries(workspace_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_gtm_deliveries_uncertain
  ON gtm_deliveries(workspace_id,updated_at DESC)
  WHERE status='uncertain';

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS outcome_kind TEXT,
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('verified','unverified'));

COMMENT ON TABLE gtm_deliveries IS
'Canonical GTM delivery claim for the exact outbound email payload. uncertain is terminal for automatic resend until reconciled.';
COMMENT ON COLUMN conversation_messages.outcome_kind IS
'Normalized inbound GTM outcome such as reply, unsubscribe, bounce, delivery_failure, out_of_office, auto_reply, or unknown.';
COMMENT ON COLUMN conversation_messages.verification_status IS
'Whether provider thread/message identity was strong enough for state-changing automation.';
