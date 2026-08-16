-- Hosted execution: the two facts a server-side LinkedIn runner cannot exist
-- without, and neither of them fits anywhere that already exists.
--
-- WHAT CHANGED ABOVE THIS FILE. Until now, everything that reached LinkedIn
-- reached it from a browser on the OPERATOR'S OWN MACHINE -- `npm run
-- linkedin:worker`, a persistent Chrome profile on local disk, the operator's
-- own residential IP. That is a genuinely better risk posture than every hosted
-- competitor's, and it is also why a hosted Trevra could plan an invite and
-- never send one: a container has no display, no Chrome profile and no home
-- directory belonging to the person whose account it is. The owner has decided
-- to close that gap by driving a CLOUD browser over CDP. These two tables are
-- what that requires from the database.
--
-- 1. `linkedin_seat_sessions` -- THE SESSION, BECAUSE THERE IS NO LONGER A DISK
--    TO KEEP IT ON.
--
--    `chromium.connectOverCDP` attaches to a browser somebody else launched.
--    There is no `user_data_dir`, so there is no persistent profile, so the
--    seat's signed-in state -- its cookies and its per-origin storage -- has
--    nowhere to live between runs unless it lives here. Without it every run
--    would be a fresh sign-in from a brand-new device, which is the single
--    loudest challenge signal LinkedIn has and the exact thing the local
--    worker's profile directory exists to avoid.
--
--    SEALED EXACTLY LIKE A PASSWORD, and that is not an analogy: a LinkedIn
--    session cookie IS the account, with no second factor in front of it.
--    Same AES-256-GCM envelope from `secrets/crypto.ts`, same
--    TREVRA_SECRETS_KEY, same rotation window, and the same row binding --
--    (store, workspace, seat, kind) as GCM additional authenticated data --
--    so one seat's session cannot be opened as another's any more than one
--    tenant's password can be opened as another tenant's. The columns are the
--    same five `linkedin_seat_credentials` uses, for the same reasons, and
--    `secrets/custody.ts` re-seals this table on a key rotation alongside it.
--
--    NO `label`, NO `last4`, NO PLAINTEXT-DERIVED ANYTHING. `cookie_names` is
--    deliberately absent for the same reason: which cookies a session holds is
--    a fact about the session, and this table stores nothing about the session
--    that is not sealed. What a status screen may know is `saved_at` and
--    `expires_at` -- when it was written, and when the browser itself said its
--    authentication cookie stops working. Neither is derived from a secret.
--
--    ONE ROW PER (workspace, seat), UPSERTED. A seat has exactly one signed-in
--    state; keeping history would mean keeping expired session cookies for
--    accounts we no longer act on, which is a liability with no reader.
--
-- 2. `linkedin_hosted_execution_ack` -- THE OPERATOR SAID YES, IN WRITING.
--
--    Hosted execution means Trevra's own servers signing into a human's
--    LinkedIn account and acting as them. Every other gate in this subsystem is
--    a technical precondition; this one is a consent record, and it is a
--    per-WORKSPACE fact rather than a deployment-wide environment variable
--    precisely because the person who has to agree is the person whose account
--    it is -- not whoever configured the server.
--
--    NOT A COLUMN ON `workspaces`. A consent record needs who, when, and what
--    exact wording they agreed to (`statement_version`), and it needs a
--    revocation that keeps the history rather than erasing it -- none of which
--    a boolean column can carry. `revoked_at` rather than a DELETE for the same
--    reason: "they never agreed" and "they agreed and changed their mind" are
--    different facts and only one of them can be re-granted silently.
--
--    THE ACKNOWLEDGEMENT IS NOT A CAPABILITY ON ITS OWN. Hosted execution needs
--    a remote browser provider configured AND this row present AND every
--    pre-existing gate (limits, warm-up, working hours, pacing, cooldown,
--    checkpoint detection) still passing. See docs/hosted-execution.md.
--
-- ------------------------------------------------------------------------
-- WHAT THIS MIGRATION LOCKS: nothing that exists. Two CREATE TABLE IF NOT
-- EXISTS and their indexes, on tables no query can be running against yet.
-- Idempotent: a re-run and a fresh database are both no-ops.
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS linkedin_seat_sessions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- NOT a foreign key to `linkedin_seats`, exactly as `linkedin_seat_credentials`
  -- is not: the seat row is created by DETECTING the account, which needs a
  -- signed-in browser, which is what this row is for.
  seat_key TEXT NOT NULL,
  -- The sealed `storageState` JSON: cookies plus per-origin storage.
  ciphertext BYTEA NOT NULL,
  -- 96-bit GCM nonce, random per write and never reused.
  iv BYTEA NOT NULL,
  -- GCM tag: what makes a tampered or transplanted row fail loudly instead of
  -- decrypting into a browser that then acts as the wrong person.
  auth_tag BYTEA NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 2,
  -- Fingerprint of the server key that sealed it, so a half-finished rotation
  -- is diagnosable rather than an indistinguishable authentication failure.
  key_id TEXT,
  -- WHEN THE BROWSER ITSELF SAID THIS SESSION STOPS WORKING: the earliest
  -- expiry among the cookies that carry the authentication. Null when the
  -- state carried no dated cookie. Stored so a runner can tell "expired, needs
  -- re-login" from "present and usable" WITHOUT decrypting, which is what lets
  -- a status route ask the question at all.
  expires_at TIMESTAMPTZ,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, seat_key)
);

-- The reaper's question: which stored sessions have expired? Answered without
-- reading any tenant's row bodies.
CREATE INDEX IF NOT EXISTS idx_linkedin_seat_sessions_expiry
  ON linkedin_seat_sessions (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS linkedin_hosted_execution_ack (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- WHO agreed. Nullable only because a user row can be erased under the
  -- workspace erasure path (migration 057) while the consent record itself
  -- must survive as an audit fact.
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- WHICH WORDING they agreed to. A consent record that cannot say what was
  -- consented to is not a consent record; when the statement changes, this
  -- number changes and every workspace is asked again.
  statement_version INTEGER NOT NULL DEFAULT 1,
  -- Non-null means withdrawn. The row stays: "never agreed" and "agreed and
  -- withdrew" are different facts, and only the first is silence.
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The hosted runner's discovery question, asked every tick: which workspaces
-- have a live acknowledgement? A partial index because the answer is almost
-- always a small subset and the revoked rows are never wanted.
CREATE INDEX IF NOT EXISTS idx_linkedin_hosted_ack_live
  ON linkedin_hosted_execution_ack (workspace_id)
  WHERE revoked_at IS NULL;
