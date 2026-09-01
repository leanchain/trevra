-- Named brand/keyword watches and the mentions they find.
--
-- Deliberately NOT outreach_threads. That table is the denominator of the
-- self-promotion ratio in outreach/safety.ts, so writing brand mentions into
-- it would move the denominator and silently loosen the reply safety gate for
-- every campaign. A `source` discriminator does not fix that -- it would
-- require editing every existing query in store.ts, feed.ts and safety.ts, and
-- one missed query is a loosened gate.

CREATE TABLE IF NOT EXISTS brand_watches (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  keywords text[] NOT NULL,
  platforms text[] NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('daily','weekly')),
  enabled boolean NOT NULL DEFAULT TRUE,
  limit_per_platform integer NOT NULL DEFAULT 25 CHECK (limit_per_platform BETWEEN 1 AND 100),
  next_run_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_until timestamptz,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS brand_watches_due_idx ON brand_watches(next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS brand_watch_mentions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  watch_id text NOT NULL REFERENCES brand_watches(id) ON DELETE CASCADE,
  platform text NOT NULL,
  external_id text NOT NULL,
  url text NOT NULL,
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  author text,
  community text,
  score integer NOT NULL DEFAULT 0,
  num_comments integer NOT NULL DEFAULT 0,
  matched_keywords text[] NOT NULL DEFAULT ARRAY[]::text[],
  sentiment_label text NOT NULL CHECK (sentiment_label IN ('positive','neutral','negative')),
  sentiment_score numeric(4,3) NOT NULL CHECK (sentiment_score BETWEEN -1 AND 1),
  sentiment_span text NOT NULL DEFAULT '',
  sentiment_version integer NOT NULL,
  content_hash text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  mention_created_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  promoted_run_id text REFERENCES playbook_runs(id) ON DELETE SET NULL,
  promoted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS brand_watch_mentions_identity_idx
  ON brand_watch_mentions(watch_id, platform, external_id);
CREATE INDEX IF NOT EXISTS brand_watch_mentions_recent_idx
  ON brand_watch_mentions(workspace_id, watch_id, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS brand_watch_mentions_sentiment_idx
  ON brand_watch_mentions(workspace_id, watch_id, sentiment_label, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS brand_watch_sentiment_daily (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  watch_id text NOT NULL REFERENCES brand_watches(id) ON DELETE CASCADE,
  day date NOT NULL,
  positive integer NOT NULL DEFAULT 0,
  neutral integer NOT NULL DEFAULT 0,
  negative integer NOT NULL DEFAULT 0,
  score_sum numeric(9,3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, watch_id, day)
);
