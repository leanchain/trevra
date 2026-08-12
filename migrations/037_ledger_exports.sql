-- "Exportable ledger and evidence", earned.
--
-- src/client/MarketingScreen.tsx has sold this as the headline self-hosting
-- benefit while no control existed anywhere in the product. This table is the
-- storage half of the claim (docs/gtm-shell-shape.md §3.4, §3.7, Wave B2).
--
-- RENDERED ONCE, SERVED FOREVER, the same posture `linkedin_exports`
-- (migrations/025) takes and for a stronger reason here: the manifest inside
-- the archive publishes a sha256 per file. A download route that re-rendered
-- would hand out different bytes under the same id, and a hash that does not
-- pin anything is worse than no hash at all -- it is the same promise
-- `SignedNote` makes about an approval, and it has to survive a second click.
--
-- Which is also why the bytes live in Postgres rather than on a disk: the one
-- deployment target this product commits to (docs/app-spec.md, the Oracle
-- Always Free box) has no durable object store, and an export whose bytes
-- vanish on redeploy cannot back a claim about taking your ledger with you.
CREATE TABLE IF NOT EXISTS ledger_exports (
  id TEXT PRIMARY KEY,
  -- The scope of every query that produced these bytes. An export leaking
  -- another workspace's runs is the worst bug this product could have, so the
  -- owner is a column and the FK is ON DELETE CASCADE: a deleted workspace
  -- takes its rendered evidence with it.
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- How far back the render reached, and which sections were asked for. Both
  -- stored, because "this file has 3 runs in it" means nothing without them --
  -- a short window and an empty ledger look identical from the outside.
  window_days INTEGER NOT NULL,
  include_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Rows per source table, and the sha256 of every file in the archive.
  -- Duplicated from manifest.json inside the zip ON PURPOSE: the API answers
  -- "what is in it" without unzipping stored bytes, and a mismatch between
  -- these two copies is itself detectable.
  counts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  sha256_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  -- The archive. BYTEA rather than TEXT: this is a zip, and base64 in a text
  -- column would cost a third more storage to store bytes Postgres already
  -- knows how to hold.
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "What has this workspace exported", newest first. The only listing this
-- table is ever asked for, and the workspace column leads so the scope is an
-- index seek rather than a filter after the fact.
CREATE INDEX IF NOT EXISTS idx_ledger_exports_workspace
  ON ledger_exports(workspace_id, created_at DESC);
