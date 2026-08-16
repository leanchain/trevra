-- Encrypt per-seat outbound proxy credentials.
--
-- `linkedin_seats.proxy_url` (migration 062) stored the full URL, including
-- username/password, in plaintext. The API redacted it on reads, but a database
-- dump, replica, support query or SQL compromise still exposed the credential.
-- Hosted Trevra already has a reviewed AES-256-GCM custody boundary for model,
-- account and browser-session secrets; proxy credentials belong inside it too.
--
-- This migration is SCHEMA ONLY. It cannot read TREVRA_SECRETS_KEY and must not
-- invent a second cryptographic path in SQL. `migrateLegacySeatProxies()` in
-- seats.ts is run by the release migration job immediately afterwards: it seals
-- every non-null legacy `proxy_url`, writes only non-secret display metadata to
-- the seat row, then clears the plaintext column. Hosted API/worker startup also
-- refuses while any legacy plaintext remains, so skipping that data step cannot
-- result in a green deployment with credentials still exposed.

ALTER TABLE linkedin_seats
  ADD COLUMN IF NOT EXISTS proxy_server TEXT,
  ADD COLUMN IF NOT EXISTS proxy_username TEXT,
  ADD COLUMN IF NOT EXISTS proxy_has_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS linkedin_seat_proxy_secrets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  seat_key TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 2,
  key_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_linkedin_seat_proxy_seat
    FOREIGN KEY (workspace_id, seat_key)
    REFERENCES linkedin_seats(workspace_id, seat_key)
    ON DELETE CASCADE,
  CONSTRAINT uq_linkedin_seat_proxy_seat UNIQUE (workspace_id, seat_key)
);

COMMENT ON TABLE linkedin_seat_proxy_secrets IS
  'AES-256-GCM sealed full outbound proxy URLs. Plaintext proxy credentials must never live in linkedin_seats.proxy_url after the release migration job.';
COMMENT ON COLUMN linkedin_seats.proxy_server IS
  'Non-secret display metadata only, e.g. http://proxy.example:3128. Never contains proxy credentials.';
COMMENT ON COLUMN linkedin_seats.proxy_username IS
  'Proxy username displayed back to the workspace. The password is never stored here.';
COMMENT ON COLUMN linkedin_seats.proxy_has_password IS
  'Whether the sealed proxy URL contains a password; the password itself is only in linkedin_seat_proxy_secrets.';
