-- LinkedIn companion devices: a hosted workspace can lend Trevra a browser on
-- the member's own computer without exposing Postgres or a reusable browser
-- credential to that computer.
--
-- Pairing codes are short-lived and stored only as hashes. Device bearer tokens
-- are shown once to the companion and also stored only as hashes. Website
-- presence is a workspace-level lease: the hosted worker serves companion seats
-- only while a signed-in Trevra tab has refreshed it recently.

CREATE TABLE IF NOT EXISTS linkedin_companion_pairings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  created_by text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS linkedin_companion_pairings_workspace_idx
  ON linkedin_companion_pairings(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS linkedin_companion_devices (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS linkedin_companion_devices_workspace_idx
  ON linkedin_companion_devices(workspace_id, revoked_at, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS linkedin_companion_presence (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
