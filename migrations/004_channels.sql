CREATE TABLE IF NOT EXISTS channels (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  automation_mode TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  account_ref TEXT,
  last_post_at TIMESTAMPTZ,
  post_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_channels_enabled_mode ON channels(enabled, automation_mode);
