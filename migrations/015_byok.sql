-- Bring-your-own-key storage.
--
-- Every other credential Trevra touches is public, hashed, or held by someone
-- else: provider OAuth lives in Nango, agent tokens are hashed and can only be
-- verified, session cookies are signed and short-lived. A model key is the
-- first secret Trevra must decrypt and USE, which is a genuinely new security
-- surface -- hence the split below.
--
-- The ciphertext lives here; the key that opens it lives in TREVRA_SECRETS_KEY,
-- in the environment. Neither half is useful alone, so a database dump (or a
-- backup, or a replica) yields nothing. That two-location split is the entire
-- security argument, which is why nothing in this file, in any seed, and in any
-- future migration may ever carry the encryption key itself.

CREATE TABLE IF NOT EXISTS workspace_secrets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- 'model_api_key' today. Widening this is a new decision with a new threat
  -- model, not a convenience -- see docs/byok-and-hosted-agent.md section 8.
  kind TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  -- 96-bit GCM nonce, random per write and never reused: two writes of the same
  -- key under the same IV would leak the relationship between them.
  iv BYTEA NOT NULL,
  -- GCM tag. It is what makes a tampered row fail loudly instead of decrypting
  -- to garbage that then gets sent to a provider as an Authorization header.
  auth_tag BYTEA NOT NULL,
  -- Which server key sealed this row. Rotation is re-encrypting rows and
  -- bumping this, so the operator never needs a schema change or downtime to
  -- respond to a suspected key compromise.
  key_version INTEGER NOT NULL DEFAULT 1,
  -- Display only. The UI must be able to say "which key is this" without any
  -- code path that decrypts, so there is never a reason to build a reveal.
  last4 TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One secret per kind per workspace: replacing a key is an upsert, so a
-- rotation cannot silently leave the old ciphertext behind for someone to find.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_secrets_kind
  ON workspace_secrets(workspace_id, kind);

-- The non-secret half of {baseUrl, apiKey, model}. It is a separate table on
-- purpose: these three fields are read together but protected differently, and
-- keeping the endpoint and model in the clear means the ordinary read path
-- ("where does this workspace send requests?") never touches decryption.
--
-- No default endpoint ships. The operator states where their key goes; Trevra
-- does not guess and does not route a key somewhere nobody named -- hence
-- base_url NOT NULL with no DEFAULT.
CREATE TABLE IF NOT EXISTS workspace_agent_config (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  label TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
