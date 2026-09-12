-- Channel-neutral content/distribution substrate.
-- Stories remain evidence-backed GTM state; LinkedIn is one renderer/publisher,
-- not the content data model.

CREATE TABLE IF NOT EXISTS content_opportunities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('candidate','ready','dismissed','expired')),
  kind TEXT NOT NULL CHECK (kind IN ('company_change','market_pattern','watch_trend','comparison','index_move')),
  title TEXT NOT NULL,
  thesis TEXT NOT NULL,
  audience TEXT,
  freshness_at TIMESTAMPTZ NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rationale_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, fingerprint),
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_content_opportunities_ready
  ON content_opportunities(workspace_id,status,score DESC,freshness_at DESC);

CREATE TABLE IF NOT EXISTS content_assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','approved','archived')),
  format TEXT NOT NULL CHECK (format IN ('text_post','evidence_card','market_pulse','report')),
  angle TEXT NOT NULL CHECK (angle IN ('observation','contrarian','list','teardown','prediction','comparison')),
  hook TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  claim_map_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, opportunity_id)
    REFERENCES content_opportunities(workspace_id,id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_content_assets_opportunity
  ON content_assets(workspace_id,opportunity_id,created_at DESC);

CREATE TABLE IF NOT EXISTS content_publication_metrics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  impressions INTEGER,
  reactions INTEGER,
  comments INTEGER,
  reposts INTEGER,
  clicks INTEGER,
  profile_views INTEGER,
  follows INTEGER,
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id,channel,publication_id,observed_at)
);
CREATE INDEX IF NOT EXISTS idx_content_publication_metrics_series
  ON content_publication_metrics(workspace_id,channel,publication_id,observed_at DESC);

ALTER TABLE linkedin_posts
  ADD COLUMN IF NOT EXISTS content_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS publication_meta_json JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='linkedin_posts_content_asset_workspace_fkey'
      AND conrelid='linkedin_posts'::regclass
  ) THEN
    ALTER TABLE linkedin_posts
      ADD CONSTRAINT linkedin_posts_content_asset_workspace_fkey
      FOREIGN KEY (workspace_id,content_asset_id)
      REFERENCES content_assets(workspace_id,id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_content_asset
  ON linkedin_posts(workspace_id,content_asset_id) WHERE content_asset_id IS NOT NULL;
