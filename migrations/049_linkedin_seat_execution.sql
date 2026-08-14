-- Multi-seat LinkedIn EXECUTION: the half migration 045 deferred.
--
-- 045 gave `linkedin_seats`, `linkedin_actions`, `linkedin_batches` and
-- `linkedin_threads` a `seat_key` and then said, in a comment at the bottom:
--
--     "Credential custody intentionally remains unchanged here. The existing
--      owner seat may use Trevra's reviewed encrypted credential path;
--      additional seats use isolated persistent browser profiles and
--      interactive sign-in [...]"
--
-- THAT SENTENCE IS NOW FALSE, and this migration is what makes it false. The
-- manual/interactive sign-in path was removed: every seat signs itself in with
-- stored credentials (`local-worker.ts` `loginLinkedInSeat`). A second seat
-- with no credential of its own therefore cannot sign in AT ALL, which is the
-- exact reason a second LinkedIn account was unusable end to end.
--
-- WHY A SECOND TABLE INSTEAD OF A `seat_key` ON `workspace_secrets`.
--
-- `workspace_secrets` (migration 015) is the BYOK vault, and its shape is one
-- of its invariants: `idx_workspace_secrets_kind` is UNIQUE on
-- (workspace_id, kind), and `secrets/store.ts` upserts through
-- `ON CONFLICT (workspace_id, kind)` precisely so that replacing a key cannot
-- leave the old ciphertext behind. Adding a seat dimension there would mean
-- dropping that index, which changes the storage contract of EVERY secret in
-- Trevra -- model API keys, CLI OAuth tokens, the Reddit pair -- to satisfy a
-- LinkedIn-only need. Making it partial (`WHERE seat_key='owner'`) does not
-- work either: Postgres cannot infer a partial index as the arbiter of an
-- `ON CONFLICT (workspace_id, kind)` that carries no matching WHERE clause, so
-- store.ts would break on its next write.
--
-- So: THE OWNER SEAT DOES NOT MOVE. Its email and password stay exactly where
-- they are, in `workspace_secrets` under kinds 'linkedin.email' and
-- 'linkedin.password', written and read by the same reviewed code path as
-- before. Nothing is re-encrypted, nothing is copied, and every credential
-- stored before this migration keeps resolving with no migration step at all.
-- ADDITIONAL seats get the table below. `secrets/linkedin.ts` is the one place
-- that knows which is which, and the CHECK constraint at the bottom of the
-- table makes it impossible for an owner row to end up here by mistake.
--
-- CUSTODY IS NOT WIDENED BY ONE INCH. Same AES-256-GCM envelope
-- (`secrets/crypto.ts`), same TREVRA_SECRETS_KEY, same key rotation story via
-- `key_version`, same unconditional hosted refusal in `secrets/linkedin.ts`,
-- same write-only rule (nothing here is ever returned to a route), and the
-- same "no plaintext-derived display value" rule as `workspace_secrets`: there
-- is deliberately NO `last4` column on this table at all, because `last4` of a
-- password is four characters of a password sitting in every backup and every
-- replica. The masked email lives in `label`, computed once on write, so no
-- read path decrypts anything to render a settings screen.

CREATE TABLE IF NOT EXISTS linkedin_seat_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- NOT a foreign key to `linkedin_seats`. A credential is saved BEFORE the
  -- seat row exists -- the seat is detected by signing in, which needs the
  -- credential first -- so a reference here would make the setup order
  -- impossible. Deleting a seat deliberately leaves its stored sign-in alone,
  -- exactly as `seats.ts` `deleteSeat` already documents.
  seat_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  -- 96-bit GCM nonce, random per write and never reused.
  iv BYTEA NOT NULL,
  -- GCM tag: what makes a tampered row fail loudly rather than decrypt to
  -- garbage that then gets typed into a login form.
  auth_tag BYTEA NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  -- The masked email (`p•••@example.com`) for 'linkedin.email', and NULL for
  -- 'linkedin.password'. There is nothing about a password that may be written
  -- down in the clear.
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Only the two halves of a LinkedIn sign-in. This table is not a second
  -- general-purpose vault, and constraining it is how it stays one thing.
  CONSTRAINT linkedin_seat_credentials_kind_check
    CHECK (kind IN ('linkedin.email', 'linkedin.password')),
  -- THE OWNER SEAT LIVES IN `workspace_secrets`, AND THIS IS THE ENFORCEMENT.
  -- Two homes for one kind of secret is a real hazard; a database-level refusal
  -- means a code path that forgets the split cannot silently create a second
  -- copy of the owner's password that a delete would then miss.
  CONSTRAINT linkedin_seat_credentials_not_owner CHECK (seat_key <> 'owner')
);

-- One pair per seat: replacing a sign-in is an upsert, so a rotation cannot
-- leave the old ciphertext behind for somebody to find. Same reasoning, same
-- shape, as `idx_workspace_secrets_kind`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_seat_credentials_seat_kind
  ON linkedin_seat_credentials(workspace_id, seat_key, kind);

-- Draining is per (workspace_id, seat_key) now, not per workspace: the worker
-- asks "which SEATS have claimable work due" and opens one browser, one
-- profile directory and one batch for each. This index is what that discovery
-- query reads.
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_due_by_seat
  ON linkedin_actions(workspace_id, seat_key, planned_for)
  WHERE status = 'planned' AND claimed_at IS NULL;
