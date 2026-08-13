-- Multi-seat LinkedIn foundation.
-- Existing single-seat workspaces remain the `owner` seat; new accounts are
-- isolated by (workspace_id, seat_key) everywhere state or credentials live.

ALTER TABLE linkedin_seats
  ADD COLUMN IF NOT EXISTS seat_key TEXT NOT NULL DEFAULT 'owner';

ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_pkey;
ALTER TABLE linkedin_seats
  ADD CONSTRAINT linkedin_seats_pkey PRIMARY KEY (workspace_id, seat_key);

-- Operator ceilings are ADDITIONAL ceilings. The researched safety bands in
-- limits.ts still apply and always win when they are lower.
ALTER TABLE linkedin_seats
  ADD COLUMN IF NOT EXISTS working_days JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  ADD COLUMN IF NOT EXISTS work_start_minute INTEGER NOT NULL DEFAULT 480,
  ADD COLUMN IF NOT EXISTS work_end_minute INTEGER NOT NULL DEFAULT 1080,
  ADD COLUMN IF NOT EXISTS daily_invite_limit INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS daily_message_limit INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS daily_profile_view_limit INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS daily_follow_limit INTEGER NOT NULL DEFAULT 20;

ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_work_start_check;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_work_start_check CHECK (work_start_minute BETWEEN 0 AND 1439);
ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_work_end_check;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_work_end_check CHECK (work_end_minute BETWEEN 1 AND 1440 AND work_end_minute > work_start_minute);
ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_invite_limit_check;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_invite_limit_check CHECK (daily_invite_limit BETWEEN 0 AND 75);
ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_message_limit_check;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_message_limit_check CHECK (daily_message_limit BETWEEN 0 AND 75);
ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_profile_view_limit_check;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_profile_view_limit_check CHECK (daily_profile_view_limit BETWEEN 0 AND 100);
ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_follow_limit_check;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_follow_limit_check CHECK (daily_follow_limit BETWEEN 0 AND 50);

CREATE INDEX IF NOT EXISTS idx_linkedin_seats_workspace
  ON linkedin_seats(workspace_id, seat_key);

-- Credential custody intentionally remains unchanged here. The existing owner
-- seat may use Trevra's reviewed encrypted credential path; additional seats
-- use isolated persistent browser profiles and interactive sign-in, so adding
-- multi-account support does not widen password custody.

-- LinkedIn conversation URNs are account-local, not workspace-global.
DROP INDEX IF EXISTS idx_linkedin_threads_urn;
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_threads_seat_urn
  ON linkedin_threads(workspace_id, seat_key, thread_urn);
CREATE INDEX IF NOT EXISTS idx_linkedin_threads_seat_recent
  ON linkedin_threads(workspace_id, seat_key, last_message_at DESC NULLS LAST);
