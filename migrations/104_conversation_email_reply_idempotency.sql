-- Retry-safe preparation for the narrow shared-conversation email reply playbook.
--
-- This is intentionally not a generic "jobs" table. The durable work already
-- lives in playbook_runs/playbook_step_runs; the index only gives one founder
-- intent a stable retry key so a double click or HTTP retry cannot create two
-- approval requests for the same reply.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_email_reply_idempotency
  ON playbook_runs(workspace_id, (input_json->>'idempotencyKey'))
  WHERE playbook_key='gtm.conversation-email-reply'
    AND input_json ? 'idempotencyKey';
