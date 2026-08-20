-- Manual checkpoints are not all messages. A manual comment needs to retain
-- both its task type and the post the operator is meant to comment on.
ALTER TABLE linkedin_manual_tasks
  ADD COLUMN IF NOT EXISTS task_kind TEXT NOT NULL DEFAULT 'message',
  ADD COLUMN IF NOT EXISTS post_url TEXT;
