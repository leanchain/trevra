-- Binary image attachments for scheduled LinkedIn feed posts.
--
-- `linkedin_posts.media_json` was reserved in migration 083 for the lightweight
-- metadata the browser needs to render a post row. The bytes deliberately live
-- here instead: returning nine multi-megabyte base64 blobs every time the Posts
-- screen lists its history would turn a cheap read into a huge response.
CREATE TABLE IF NOT EXISTS linkedin_post_media (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES linkedin_posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 9),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/gif')),
  bytes BYTEA NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (post_id, position)
);

CREATE INDEX IF NOT EXISTS linkedin_post_media_post_idx
  ON linkedin_post_media (workspace_id, post_id, position);
