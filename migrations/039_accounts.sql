-- Accounts: the noun the whole go-to-market side was missing.
--
-- Every screen before this migration was about a verb -- a search that was
-- walked, a signal that was read, a campaign that was sent -- and none of them
-- shared a subject. So "which companies are worth a message this week" had no
-- table to ask, and the answer was assembled by hand in an operator's head
-- from three screens that did not reference each other.
--
-- THE PREMISE OF THE SCORING IS THAT ONE RIGHT COMPANY BEATS A HUNDRED WRONG
-- ONES. That is not a slogan here, it is why the schema looks like this:
--
--   * an account is CHEAP to hold and expensive to act on, so accounts are
--     kept whether or not they ever score, and nothing is deleted to make room;
--   * a signal is stored with the URL it was read from, because a score no
--     operator can audit is a score no operator should trust, and the evidence
--     is what makes the opener writable;
--   * a score is a ROW WITH ITS REASONS, recomputed and kept, not a number
--     computed on read -- "why is this an 87" must be answerable in a month,
--     against the signals as they stood, not as they later decayed;
--   * saying "not a fit" is recorded as evidence about the SHAPE of the
--     signals, not just about that one company, because the only cheap way to
--     get sharper is to learn from the operator's own rejections.
--
-- Sources converge here. A CSV of 500 accounts, a provider-sourced candidate
-- list, and a LinkedIn walk are three doors into the same table -- `source`
-- says which door, and nothing downstream has to care.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The company as the operator would say it out loud. Falls back to the
  -- domain when an import has nothing better; never null, so no screen has to
  -- render an unnamed row.
  name TEXT NOT NULL,
  -- Registrable host, lowercased, no scheme, no www, no path. THE IDENTITY OF
  -- THE ROW: two imports of the same company under different spellings must
  -- collide here rather than becoming two accounts that each score half.
  domain TEXT NOT NULL,
  -- Optional, and never required to act. A company with no LinkedIn page is
  -- still a company worth a signal sweep.
  linkedin_url TEXT,
  -- 'csv'      -- an operator uploaded or pasted a list
  -- 'sourced'  -- gtm.source-leads produced it from an ICP description
  -- 'linkedin' -- a LinkedIn walk imported it (a source, never the front door)
  -- 'manual'   -- typed in one at a time
  --
  -- Provenance survives merges: the FIRST door wins, because "where did this
  -- come from originally" is the question being asked a year later.
  source TEXT NOT NULL DEFAULT 'manual',
  -- Free-form operator labels (vertical, region, campaign). Text array rather
  -- than a join table: they are read together, written together, and never
  -- queried on their own.
  tags TEXT[] NOT NULL DEFAULT '{}',
  -- 'active'    -- in the sweep
  -- 'not_a_fit' -- the operator rejected it; kept, never swept, never scored
  -- 'archived'  -- out of the sweep without a judgement attached
  --
  -- A rejected account is NOT deleted. Deleting it means the next import
  -- silently resurrects it and the operator rejects it a second time.
  status TEXT NOT NULL DEFAULT 'active',
  -- What the operator said they sell to, at the moment this account was
  -- sourced. Kept per account because an ICP is edited over time and a score
  -- computed under the old one must stay explainable.
  icp_note TEXT,
  -- Sweep bookkeeping. `next_sweep_at` is what the worker claims on, so pacing
  -- is a column rather than a loop that hopes to stay ahead of the clock.
  last_swept_at TIMESTAMPTZ,
  next_sweep_at TIMESTAMPTZ,
  -- Non-null once a sweep failed in a way the operator should see (host does
  -- not resolve, robots disallows, site refused). Cleared on the next success.
  sweep_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One company per workspace, keyed on the domain. The import path relies on
-- this for ON CONFLICT, which is what makes re-uploading the same CSV a no-op
-- rather than a duplicate list.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_domain
  ON accounts(workspace_id, LOWER(domain));

-- The sweep's claim order: due first, never-swept before swept.
CREATE INDEX IF NOT EXISTS idx_accounts_due
  ON accounts(workspace_id, next_sweep_at NULLS FIRST)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_accounts_recent
  ON accounts(workspace_id, created_at DESC);

-- One observed change, with the page it was read from.
--
-- Signals are APPEND-ONLY and never updated. "They went from 3 roles to 7 on
-- 2 Aug" is a fact about a moment; rewriting it when they go to 9 destroys the
-- only thing that made it worth sending -- that it is recent and checkable.
CREATE TABLE IF NOT EXISTS account_signals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The signal vocabulary, kept deliberately small. Site diffs come from
  -- gtm.watch-signal ('hiring-up', 'hiring-down', 'pricing-changed',
  -- 'headline-changed', 'tech-added', 'tech-removed'); public commentary comes
  -- from gtm.scout-threads ('thread-mention'). 'first-capture' is stored and
  -- scored at ZERO -- it is the baseline, not news.
  kind TEXT NOT NULL,
  -- One sentence an operator could paste into an email unedited.
  detail TEXT NOT NULL,
  previous TEXT,
  current TEXT,
  -- The page this was read from. NOT NULL BY INTENT: a signal whose evidence
  -- cannot be linked is a claim, and claims do not go in outbound mail.
  evidence_url TEXT NOT NULL,
  -- When the change was OBSERVED by us. Distinct from created_at because a
  -- backfilled or provider-supplied signal carries its own timestamp, and
  -- recency decay must weigh the event, not the insert.
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Hash of (kind + the changed values). The dedupe key: a sweep that reads
  -- the same unchanged careers page every day must not emit 'hiring-up' every
  -- day. Same fingerprint within the window = the same event, seen again.
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_signals_dedupe
  ON account_signals(workspace_id, account_id, kind, fingerprint);

CREATE INDEX IF NOT EXISTS idx_account_signals_recent
  ON account_signals(workspace_id, account_id, observed_at DESC);

-- The current score for an account, with the reasoning that produced it.
--
-- ONE ROW PER ACCOUNT, REPLACED IN PLACE. History lives in the signals; a
-- score is a view over them at a moment, and keeping every recomputation would
-- be a table nobody reads that grows on every sweep.
CREATE TABLE IF NOT EXISTS account_scores (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 0-100. Comparable only within a workspace: it is a ranking device, not a
  -- measurement of anything in the world.
  score INTEGER NOT NULL DEFAULT 0,
  -- 'hot'    -- act now, the signals are recent and they co-occur
  -- 'warm'   -- worth watching; one good signal, or two stale ones
  -- 'cold'   -- nothing has moved
  tier TEXT NOT NULL DEFAULT 'cold',
  -- How many DISTINCT signal kinds landed inside the scoring window. The
  -- layering number, stored because it is the one an operator argues with.
  distinct_kinds INTEGER NOT NULL DEFAULT 0,
  -- The most recent observation the score was computed over. "Score 87, and
  -- the newest thing in it is six weeks old" is a sentence a screen must be
  -- able to say.
  newest_signal_at TIMESTAMPTZ,
  -- The per-component breakdown, exactly as the scorer produced it: which
  -- signals contributed, what each was worth after decay, which pairs earned a
  -- co-occurrence bonus. Rendered verbatim behind "why this score".
  rationale_json TEXT NOT NULL DEFAULT '{}',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, account_id)
);

-- The ranking read: hot first, then by score, within one workspace.
CREATE INDEX IF NOT EXISTS idx_account_scores_rank
  ON account_scores(workspace_id, score DESC, computed_at DESC);

-- What the operator rejected, and what it looked like when they did.
--
-- The point is the SNAPSHOT: rejecting a company teaches nothing, rejecting
-- "hiring-up alone, no pricing move, 40 days old" teaches the scorer something
-- it can apply to the next hundred. Kept append-only for the same reason the
-- signals are.
CREATE TABLE IF NOT EXISTS account_feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 'not_a_fit' | 'good_fit' -- the two judgements a ranked list can collect
  -- without asking the operator to fill in a form.
  verdict TEXT NOT NULL,
  -- Optional free text. Never parsed, only shown back.
  reason TEXT,
  -- The signal kinds present at the moment of judgement, sorted, joined by ','.
  -- The learnable shape.
  signal_shape TEXT NOT NULL DEFAULT '',
  score_at_verdict INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_feedback_shape
  ON account_feedback(workspace_id, verdict, signal_shape);
