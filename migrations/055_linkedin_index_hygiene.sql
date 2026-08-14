-- Index hygiene for the multi-tenant LinkedIn read paths.
--
-- Four unserved hot queries, one index that could not serve the ORDER BY it
-- exists for, four unindexed lookup/cascade columns, and four indexes that are
-- genuinely redundant on the write-hottest table in the schema.
--
-- WHY THE REDUNDANT ONES MATTER AS MUCH AS THE MISSING ONES. `linkedin_actions`
-- is 24 columns and eleven indexes; every INSERT maintains all eleven, and the
-- managed-campaign runner writes one row per member per step across every seat
-- on the deployment. An index nothing reads is a tax on the one write path
-- that scales with tenants. So this file is a NET of +1 index on that table --
-- five added, three dropped, one replaced -- and every add names the query it
-- serves while every drop shows its work first.
--
-- THE NON-TRANSACTIONAL LANE, because these builds are on tables that hold
-- every action and every message ever recorded. An ordinary CREATE INDEX takes
-- a lock that blocks writes for the whole build; at millions of rows that is
-- minutes of a tenant base unable to record what its worker just did.
-- CONCURRENTLY trades a second table pass for a lock that lets writes through.
-- Each build is preceded by DROP INDEX IF EXISTS on its own name, per
-- migrations/README.md rule 4: a failed CONCURRENTLY build leaves an INVALID
-- index behind that IF NOT EXISTS would otherwise find and skip.

-- trevra:no-transaction

/* ---------------------------------------------------------------------------
 * 1. The safety gate's campaign ramp had no serving index at all.
 * ------------------------------------------------------------------------ */

-- `guard.ts` counts a CAMPAIGN's non-skipped actions of one kind in the rolling
-- 24h window -- (workspace_id, campaign_id, kind, status <> 'skipped',
-- recorded_at > ?) -- on every gate call that names a campaign, which is every
-- action a managed campaign plans and every one the worker re-gates before
-- sending it.
--
-- Nothing served it. The only index leading with `campaign_id` is 046's
-- `idx_linkedin_actions_variant`, which is (workspace_id, campaign_id,
-- workflow_step_id, variant_id) PARTIAL ON `variant_id IS NOT NULL` -- i.e. it
-- holds only the rows of A/B message steps, so the planner cannot use it for a
-- question about every row of a campaign. The count therefore degraded to a
-- scan of the whole workspace's ledger, per gate call.
--
-- The column order is the query's: two equalities, then the kind, then the
-- range. `campaign_id IS NOT NULL` keeps every one-off export and hand-filed
-- row out of the index, and `campaign_id=?` implies it, so the predicate costs
-- the query nothing.
--
-- It is also what the other campaign-scoped readers get for free as a prefix
-- (workspace_id, campaign_id): the runner's per-tick ramp budget, the campaign
-- stop/pause/resume sweeps in managed-campaigns.ts, and campaigns.ts's
-- "actions that have left 'planned'" count. `linkedin_actions.campaign_id`
-- carries no foreign key (022 declares it as plain TEXT, deliberately: the
-- ledger outlives any pruning of campaign rows), so this is a lookup index and
-- not a cascade one.
DROP INDEX IF EXISTS idx_linkedin_actions_campaign_window;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_campaign_window
  ON linkedin_actions(workspace_id, campaign_id, kind, recorded_at)
  WHERE campaign_id IS NOT NULL AND status <> 'skipped';

/* ---------------------------------------------------------------------------
 * 2. The withdrawal sweep sorts on an expression 032 does not carry.
 * ------------------------------------------------------------------------ */

-- `selectWithdrawalCandidates` orders by COALESCE(pending_since, recorded_at)
-- -- LinkedIn's word about when the recipient got the invite, ours about when
-- we logged it -- and 032's `idx_linkedin_actions_pending_invites` is on
-- (workspace_id, seat_key, recorded_at). Same predicate, wrong third column:
-- the index could find the seat's pending invites but not hand them back in
-- the order the sweep asks for, so `LIMIT 100` was applied AFTER sorting the
-- seat's entire backlog. `countPendingInvites`'s optional `before` filter is
-- on the same expression and had the same problem.
--
-- REPLACED RATHER THAN ADDED ALONGSIDE. The predicate is identical and the
-- expression is a superset of the old third column's usefulness -- a seat's
-- pending invites ordered by the clock every reader of them actually uses --
-- so keeping both would mean maintaining two indexes over the same rows for
-- one access pattern. The old one is dropped in section 7.
DROP INDEX IF EXISTS idx_linkedin_actions_pending_invite_age;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_pending_invite_age
  ON linkedin_actions(workspace_id, seat_key, (COALESCE(pending_since, recorded_at)))
  WHERE kind = 'invite' AND status IN ('sent', 'exported');

/* ---------------------------------------------------------------------------
 * 3. Workspace-wide target lookups, which 031's index cannot serve.
 * ------------------------------------------------------------------------ */

-- 031's `idx_linkedin_actions_target_ci` is (workspace_id, seat_key,
-- LOWER(target_ref)), and `seat_key` in the middle is what two callers cannot
-- supply:
--
--   * `runner.ts` `repliedProfiles` asks "has any of this workspace's accounts
--     already been answered by these 500 people" -- the first arm of its UNION
--     names no seat, deliberately: a reply to ANY seat means the campaign's
--     objective is met and the next scripted follow-up must not go out. With
--     no index it seq-scanned the ledger once per campaign tick.
--   * `leads.ts` `suppressionSets` asks the same shape of question for the
--     people a harvest just found. It used to answer it by reading the whole
--     workspace ledger into a JS Set; it now asks the database about the
--     harvested people only, which needs exactly this index to be cheap.
--
-- THE EXPRESSION IS NORMALISED, NOT MERELY LOWER-CASED, and that is what lets
-- a SQL lookup replace a JS-side canonicalisation without narrowing the match.
-- `target_ref` is opaque -- whatever a human typed or a CSV supplied, never
-- resolved (022) -- and a harvested LinkedIn href carries
-- `?miniProfileUrn=...` every single time, so the ledger genuinely holds
-- `.../in/jonas/?trk=x` for the person a walk reports as `.../in/jonas/`.
-- Stripping the query and fragment is the one part of `canonicalProfileUrl`
-- that a list of candidate spellings cannot enumerate, so it is done here.
-- SPLIT_PART twice rather than a regex: both are IMMUTABLE and so indexable,
-- and this one has no regex-dialect questions to answer about what a bracket
-- expression may contain. `chr(63)` is the question mark, spelled that way
-- because `Db.prepare` rewrites a literal '?' -- including one inside a string
-- constant -- into a positional placeholder, so `runner.ts` and `leads.ts`
-- cannot write it directly and the three expressions have to match TEXTUALLY
-- for the planner to use this index.
--
-- Partial on the two things both callers always say. `status <> 'skipped'` is
-- the standing rule of this table (a skipped row released its target), and
-- `target_ref IS NOT NULL` drops the rows that could never match anyway.
DROP INDEX IF EXISTS idx_linkedin_actions_workspace_target_ci;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_workspace_target_ci
  ON linkedin_actions(workspace_id, LOWER(SPLIT_PART(SPLIT_PART(target_ref, chr(63), 1), '#', 1)))
  WHERE target_ref IS NOT NULL AND status <> 'skipped';

-- The other half of `repliedProfiles`: threads matched to a profile URL,
-- case-folded, with no seat key. 031/045 index threads by (workspace_id,
-- seat_key, thread_urn) and by recency, and 031's campaign index by campaign;
-- none of them can answer "which of these 500 profile URLs has a thread in
-- this workspace", so that arm scanned every thread the workspace has ever
-- synced, per campaign tick.
DROP INDEX IF EXISTS idx_linkedin_threads_profile_ci;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_threads_profile_ci
  ON linkedin_threads(workspace_id, LOWER(profile_url))
  WHERE profile_url IS NOT NULL;

/* ---------------------------------------------------------------------------
 * 4. The runner's slot floor: MAX(planned_for) over a `<>` predicate.
 * ------------------------------------------------------------------------ */

-- `ledgerFloorFor` reads the latest slot a seat already holds, so a new tick
-- never schedules on top of one: MAX(planned_for) WHERE workspace_id=? AND
-- seat_key=? AND status <> 'skipped' AND planned_for IS NOT NULL.
--
-- No index supported it. 022's `idx_linkedin_actions_planned` is partial on
-- `status = 'planned'`, which is a STRICTER set than `status <> 'skipped'` --
-- it omits every exported, sent, accepted, replied, declined, held and
-- withdrawn row, all of which hold slots this floor must clear -- so the
-- planner cannot use it and read a correct maximum. Every tick, for every
-- seat, therefore scanned the seat's whole history to find one timestamp.
--
-- DESC so the maximum is the first entry of the scan rather than the last.
-- The predicate is the query's, verbatim, which is what lets Postgres match it
-- (index predicates are compared by expression, and an identical one always
-- proves).
DROP INDEX IF EXISTS idx_linkedin_actions_seat_slot;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_seat_slot
  ON linkedin_actions(workspace_id, seat_key, planned_for DESC)
  WHERE planned_for IS NOT NULL AND status <> 'skipped';

/* ---------------------------------------------------------------------------
 * 5. Unindexed FK and cascade columns.
 * ------------------------------------------------------------------------ */

-- 043's `queued_by_user_id` is `REFERENCES users(id) ON DELETE SET NULL`, and
-- PostgreSQL does not index the referencing side of a foreign key for you. So
-- deleting one user -- a teammate leaving a workspace, or a GDPR erasure --
-- takes a sequential scan of the whole ledger while holding a row lock on the
-- user. Partial on NOT NULL because the null side is the majority and is never
-- what the cascade looks for: every 'export' row and every replayed queue
-- action stores NULL by design (see the column's own COMMENT).
DROP INDEX IF EXISTS idx_linkedin_actions_queued_by;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_queued_by
  ON linkedin_actions(queued_by_user_id)
  WHERE queued_by_user_id IS NOT NULL;

-- 046's `linkedin_manual_tasks` has three ON DELETE CASCADE parents and an
-- index that can serve none of them. `idx_linkedin_manual_tasks_queue` leads
-- with `workspace_id`, which covers the workspace cascade;
-- `idx_linkedin_manual_tasks_pending_step` leads with `member_id` but is
-- PARTIAL ON `status='pending'`, so a cascade -- which must find COMPLETED
-- tasks too -- cannot use it. Deleting a campaign, a member or a contact
-- therefore scans this table three times over.
DROP INDEX IF EXISTS idx_linkedin_manual_tasks_campaign;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_manual_tasks_campaign
  ON linkedin_manual_tasks(campaign_id);

DROP INDEX IF EXISTS idx_linkedin_manual_tasks_contact;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_manual_tasks_contact
  ON linkedin_manual_tasks(contact_id);

DROP INDEX IF EXISTS idx_linkedin_manual_tasks_member;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_manual_tasks_member
  ON linkedin_manual_tasks(member_id);

-- `linkedin_actions.batch_id` (024) IS DELIBERATELY LEFT UNINDEXED, and that is
-- a finding rather than an omission. It carries no foreign key -- 024 says so
-- in as many words, because the ledger must outlive any pruning of
-- `linkedin_batches` -- so no cascade reads it, and no query in the tree reads
-- it either: `local-worker.ts` WRITES it on claim (line 929) and clears it on
-- release (line 1051), and nothing anywhere SELECTs or filters on it. An index
-- would be maintained on every insert and every claim for a column with no
-- reader. When the "read a halted batch back to the actions it took" query
-- 024's comment anticipates is actually written, it will want
-- (workspace_id, batch_id) and it should be added then.

/* ---------------------------------------------------------------------------
 * 6. Redundant indexes, with the proof before the drop.
 * ------------------------------------------------------------------------ */

-- 049's `idx_linkedin_actions_due_by_seat` is BYTE-IDENTICAL to 024's
-- `idx_linkedin_actions_claimable`:
--
--   024:  ON linkedin_actions(workspace_id, seat_key, planned_for)
--         WHERE status = 'planned' AND claimed_at IS NULL
--   049:  ON linkedin_actions(workspace_id, seat_key, planned_for)
--         WHERE status = 'planned' AND claimed_at IS NULL
--
-- Same columns, same order, same predicate. `CREATE INDEX IF NOT EXISTS`
-- matches on NAME and not on definition, so 049 did not find 024's and both
-- were built: two identical B-trees, both maintained on every insert and every
-- claim, for one query. The 024 name is kept because it is the older one and
-- because `local-worker.ts`'s claim query is commented against it.
DROP INDEX CONCURRENTLY IF EXISTS idx_linkedin_actions_due_by_seat;

-- 047's `idx_linkedin_actions_legacy_target` is a PREFIX of the unique index
-- created four lines above it in the same file:
--
--   047:9   UNIQUE ON (workspace_id, seat_key, kind, target_ref, replay_scope)
--           WHERE status <> 'skipped'
--   047:13         ON (workspace_id, seat_key, kind, target_ref)
--           WHERE status <> 'skipped' AND replay_scope = 'legacy'
--
-- Every query the second can answer, the first answers at least as well. A
-- lookup naming all five columns (which is what `hasTarget` and `recordAction`
-- both do, resolving an absent scope to 'legacy') is a full equality probe of
-- the unique index; a lookup naming only the first four is a prefix scan of
-- it. The extra `replay_scope='legacy'` predicate makes the second index
-- SMALLER, not more capable -- and a smaller index is not a reason to keep a
-- second copy of a key the first one already leads with.
DROP INDEX CONCURRENTLY IF EXISTS idx_linkedin_actions_legacy_target;

-- 022's `idx_linkedin_actions_planned` has the SAME COLUMNS as 024's
-- `idx_linkedin_actions_claimable` and a SUPERSET predicate:
--
--   022:  ON (workspace_id, seat_key, planned_for) WHERE status = 'planned'
--   024:  ON (workspace_id, seat_key, planned_for)
--         WHERE status = 'planned' AND claimed_at IS NULL
--
-- A superset predicate is normally the one to KEEP, because it can serve
-- queries the narrower one cannot -- so this drop needs the enumeration rather
-- than the shape. Every reader of `status = 'planned'` in the tree also says
-- `claimed_at IS NULL`, i.e. every one of them falls inside 024's predicate:
--
--   local-worker.ts:932    the claim query
--   local-worker.ts:1159   the due-seat discovery query
--   campaigns.ts:208       stopping a campaign's unclaimed rows
--   managed-campaigns.ts:345  pausing a campaign (planned -> held)
--   managed-campaigns.ts:360  stopping a campaign (planned/held -> skipped)
--   lead-lists.ts:404      releasing a deleted list's members
--
-- There is no reader of the claimed-but-still-planned rows, which is the only
-- set 022's index holds that 024's does not -- and by design there cannot be a
-- useful one, because 024's own comment records that a claim whose outcome was
-- never learned KEEPS its claim forever rather than being handed out again.
-- Section 4 above adds the index for the one query that genuinely needs a
-- wider status predicate, and it is a different (wider) predicate than this
-- one, so nothing is left unserved.
DROP INDEX CONCURRENTLY IF EXISTS idx_linkedin_actions_planned;

-- 045's `idx_linkedin_seats_workspace` duplicates the primary key declared 26
-- lines above it in the same file:
--
--   045:10  ADD CONSTRAINT linkedin_seats_pkey PRIMARY KEY (workspace_id, seat_key)
--   045:36  CREATE INDEX idx_linkedin_seats_workspace ON linkedin_seats(workspace_id, seat_key)
--
-- Same columns, same order; the PK's own unique index already serves both the
-- exact `getSeat` probe and the `listSeats` prefix scan on `workspace_id`.
DROP INDEX CONCURRENTLY IF EXISTS idx_linkedin_seats_workspace;

-- Superseded by section 2's expression index over the same rows.
DROP INDEX CONCURRENTLY IF EXISTS idx_linkedin_actions_pending_invites;

/* ---------------------------------------------------------------------------
 * 7. What is NOT here, so the next reader does not go looking.
 * ------------------------------------------------------------------------ */

-- The inbox list's per-row `SELECT COUNT(*) FROM linkedin_messages WHERE
-- m.thread_id = t.id` had no serving index either -- 031's only `thread_id`
-- index is partial on `direction='in'` -- so one 500-row page was 500 scans of
-- a table with millions of rows in it. It is fixed in `inbox.ts` rather than
-- here, by naming the workspace in the subquery: a message always belongs to
-- its thread's workspace, and with `m.workspace_id = t.workspace_id` in the
-- predicate 031's existing `idx_linkedin_messages_thread` (workspace_id,
-- thread_id, position) serves it as an index probe. A new index on
-- `linkedin_messages(thread_id)` would have cost every message insert for a
-- lookup an existing index can already answer.

COMMENT ON INDEX idx_linkedin_actions_campaign_window IS
  'Serves guard.ts countCampaignActionsInWindow: one campaign''s non-skipped actions of one kind in a rolling window. Also the prefix index for every other (workspace_id, campaign_id) reader of this table.';
COMMENT ON INDEX idx_linkedin_actions_pending_invite_age IS
  'Serves the withdrawal sweep and countPendingInvites, ordered by COALESCE(pending_since, recorded_at) -- the clock both of them measure staleness on. Replaces 032''s idx_linkedin_actions_pending_invites, which had the same predicate and could not serve the sort.';
COMMENT ON INDEX idx_linkedin_actions_workspace_target_ci IS
  'Normalised (lower-cased, query and fragment stripped) target lookup with NO seat_key, for the two callers that ask a workspace-wide question: runner.ts repliedProfiles and leads.ts suppressionSets. 031''s idx_linkedin_actions_target_ci has seat_key in the middle and is not normalised, so it serves neither. The expression must stay textually identical in all three places.';
COMMENT ON INDEX idx_linkedin_actions_seat_slot IS
  'Serves runner.ts ledgerFloorFor: MAX(planned_for) for one seat over status <> ''skipped''. 022''s planned-only index is a stricter set and cannot answer it.';
COMMENT ON INDEX idx_linkedin_actions_queued_by IS
  'The referencing side of migration 043''s users(id) ON DELETE SET NULL. Without it, deleting one user sequentially scans the whole action ledger.';
