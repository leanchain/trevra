-- The one Reddit account this workspace signs in as, and when we last saw that
-- session was live.
--
-- WHY A TABLE AND NOT A COLUMN ON linkedin_seats. LinkedIn rate-limits a human
-- and Reddit rate-limits an ACCOUNT, but they are different humans' accounts
-- with different sessions, different browser profiles and different bans.
-- Sharing a row would mean one platform's cooldown reading as the other's.
--
-- WHERE THE SECRET LIVES IS NOT HERE, and there must never be a password
-- column on this table. Both halves go into `workspace_secrets` (migration
-- 015) under kinds 'reddit.username' and 'reddit.password', AES-256-GCM sealed
-- with TREVRA_SECRETS_KEY, through the one crypto path this codebase has --
-- the same arrangement migration 028 made for LinkedIn, for the same reason:
-- a headless Chromium can type a password but cannot show a human a window.
--
-- THE HOSTED GATE IS UNCHANGED AND UNCONDITIONAL. TREVRA_DEPLOYMENT_MODE=hosted
-- refuses credential storage outright, in `secrets/reddit.ts` and again at the
-- route. One operator holding their own password is a small, informed,
-- self-inflicted risk; a multi-tenant service holding many humans' is a
-- different product with a different threat model.

CREATE TABLE IF NOT EXISTS reddit_accounts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,

  -- The public handle, WITHOUT the `u/` prefix, exactly as the signed-in
  -- session reports it. Stored in the clear on purpose and unlike LinkedIn's
  -- email: a Reddit username is printed under every comment the worker posts,
  -- so hiding it here would conceal which account is about to speak while
  -- protecting nothing that is not already public. The sealed copy in
  -- `workspace_secrets` is the one the browser types; this one is for reading.
  --
  -- Nullable because a row can exist before a session has ever been confirmed.
  username TEXT,

  -- 'credentials' -- Trevra holds this operator's own username and password
  --                  and signs in headlessly when the stored session expired.
  -- 'manual'      -- a human logged this browser profile in by hand and Trevra
  --                  holds no credential at all. The default, and the zero-
  --                  custody path.
  --
  -- Constrained rather than commented: this value decides whether a password
  -- is read out of the vault at all, and a typo'd third value must fail at the
  -- write rather than silently take neither branch.
  auth_mode TEXT NOT NULL DEFAULT 'manual',

  -- The last time we CONFIRMED the stored browser session was live -- by
  -- landing on a signed-in page, not by signing in.
  --
  -- It exists so the session gets REUSED. Re-authenticating on every run is
  -- both slower and a far stronger automation signal than a stable session,
  -- and a login burst is exactly the shape Reddit's anti-abuse looks for.
  -- Logging in is the fallback; a session that still works is the normal case.
  --
  -- Nullable, and null means UNKNOWN rather than "expired": an account nobody
  -- has checked is not an account we know is signed out.
  session_valid_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reddit_accounts_auth_mode_check') THEN
    ALTER TABLE reddit_accounts
      ADD CONSTRAINT reddit_accounts_auth_mode_check CHECK (auth_mode IN ('manual','credentials'));
  END IF;
END $$;
