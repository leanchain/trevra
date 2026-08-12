-- Community-outreach state, ported from the SQLite database the Python
-- reference kept at ~/.lemoncrow/outreach.db.
--
-- Three things need to survive a process restart, and all three are here:
-- seen threads (so a re-poll does not re-surface what was already triaged),
-- the post log (so daily caps and the self-promotion ratio have a denominator),
-- and cooldowns. Cooldowns get no table of their own -- "have we posted into
-- r/webdev in the last 48 hours" is a query against the post log, and a second
-- table storing the same fact is a second thing to keep correct.

CREATE TABLE IF NOT EXISTS outreach_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- Hash of title+content, compared against the PREVIOUS value on every
  -- re-poll so an edit is detectable (a thread that gains "this costs me $400
  -- a month" after we first read it is a different thread). This table is not
  -- an exclusion list: a thread drops out of scouting when we have REPLIED to
  -- it, which is a fact about outreach_posts, not about having read it once.
  content_hash TEXT NOT NULL,
  author TEXT,
  -- Subreddit, repo, tag, or instance: whatever this platform rate-limits by.
  -- Captured at discovery rather than re-derived from metadata at check time,
  -- which is what the reference's safety.community_key() did on every call.
  community TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  num_comments INTEGER NOT NULL DEFAULT 0,
  thread_created_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_threads_identity
  ON outreach_threads(workspace_id, platform, external_id);

-- The self-promotion ratio divides posts-in-community by threads-discovered-in-community.
CREATE INDEX IF NOT EXISTS idx_outreach_threads_community
  ON outreach_threads(workspace_id, platform, community);

CREATE TABLE IF NOT EXISTS outreach_posts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  community TEXT,
  -- Platform-native thread id, not a foreign key: the post log is append-only
  -- history and must outlive any pruning of the dedup table.
  thread_external_id TEXT NOT NULL,
  thread_url TEXT NOT NULL,
  -- The canonical hash of the exact payload a human approved. Same value the
  -- playbook engine matches against playbook_approvals.payload_hash before it
  -- will execute the action.
  payload_hash TEXT NOT NULL,
  -- 'pending'        -- the payload hash is CLAIMED and a write is in flight,
  --                     or the write's outcome is unknown (timeout, lost
  --                     response). Held, never auto-retried: if the comment
  --                     did land, retrying posts a second one on a stranger's
  --                     thread, and that cannot be undone.
  -- 'posted'         -- delivered through the platform's own write API
  -- 'manual_handoff' -- prepared for a human because the channel is prepare-only
  -- 'failed'         -- the platform ANSWERED and refused, so nothing was
  --                     published and the claim is released for retry
  status TEXT NOT NULL,
  provider TEXT,
  external_ref TEXT,
  error TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Replay guard. A retried action step carries the same approved payload hash,
-- and must not produce a second comment on the thread. The row is written
-- BEFORE the network call ('pending'), so a process that dies mid-request
-- still leaves the claim standing. Only 'failed' -- an explicit refusal, where
-- nothing was published -- is excluded, so that case alone can be retried.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_posts_payload
  ON outreach_posts(workspace_id, payload_hash)
  WHERE status <> 'failed';

-- Daily cap: count this workspace's posts on this platform since midnight.
CREATE INDEX IF NOT EXISTS idx_outreach_posts_daily
  ON outreach_posts(workspace_id, platform, created_at DESC);

-- Cooldown: newest post into this community.
CREATE INDEX IF NOT EXISTS idx_outreach_posts_cooldown
  ON outreach_posts(workspace_id, platform, community, created_at DESC);
