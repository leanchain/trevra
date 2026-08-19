-- Scheduled LinkedIn feed posts, independent of the outreach campaign tables:
-- a post targets no lead, so it has no place in linkedin_actions/linkedin_campaigns.
-- See docs/superpowers/specs/2026-08-19-linkedin-scheduled-posts-design.md.
--
-- The full shape (media, link_in_comment, sequence_position, mention_warnings)
-- is created now even though Milestone 1 only reads/writes a subset, so later
-- milestones (cadence queue, mentions/media) only ADD reads and writes, never
-- another ALTER TABLE on a table already carrying live rows.
CREATE TABLE linkedin_posts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seat_key TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','publishing','posted','failed','missed','canceled')),
  blocks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  link_in_comment BOOLEAN NOT NULL DEFAULT FALSE,
  scheduled_at TIMESTAMPTZ,
  sequence_position INTEGER,
  published_at TIMESTAMPTZ,
  posted_url TEXT,
  error_json JSONB,
  mention_warnings_json JSONB,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- The worker tick's whole query: due posts for one workspace, oldest first.
CREATE INDEX linkedin_posts_due_idx ON linkedin_posts (workspace_id, status, scheduled_at);
-- The composer's queue/history list: one seat's posts, newest first.
CREATE INDEX linkedin_posts_seat_idx ON linkedin_posts (workspace_id, seat_key, status, created_at DESC);
