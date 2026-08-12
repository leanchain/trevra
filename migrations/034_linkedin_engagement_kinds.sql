-- The three engagement kinds -- follow, like, endorse -- admitted to the
-- action ledger (plan 4A "extra actions: endorse, follow, like", scheduled by
-- 6A).
--
-- WHY THEY ARRIVE NOW. Dripify and Waalaxy ship all three and we did not, so
-- 4A lists them as a parity gap. The larger reason is internal: plan 1.4's
-- warm-up ramp is written in terms of them -- "wk1 passive only (views/likes,
-- 0 invites)" -- so a ledger that could record a view but not a like could
-- only ever describe half of what the research calls a warm-up.
--
-- WHAT WAS ACTUALLY CONSTRAINING `kind`, AND WHAT THIS MIGRATION CHANGES.
-- Nothing in the schema was refusing these values. 022 declares the column as
--
--   -- invite | dm | inmail | profile_view | comment | follow.
--   kind TEXT NOT NULL,
--
-- and that comment IS the constraint: there is no CHECK on `kind`, there never
-- has been, and the enumeration lives in a migration file that nobody re-reads
-- and in `actions.ts` `LinkedInActionKind`. So the widening this migration
-- performs is a widening of the WRITTEN-DOWN enumeration, moved onto the
-- column itself with COMMENT ON COLUMN, where `\d+ linkedin_actions` will show
-- it to whoever is looking at the table rather than at the file that made it.
-- 'like' and 'endorse' are the two new values; 'follow' was already listed in
-- 022 and is repeated here so the comment is a complete list rather than a
-- diff of one.
--
-- AND THIS MIGRATION DELIBERATELY ADDS NO CHECK. 023 made the same call about
-- `contact_identities.provider`, in the same words, and the reasoning holds
-- unchanged: "adding one would be a restriction, not a permission, and it
-- would fail on any workspace that has already imported a kind we did not
-- anticipate." A migration whose stated job is to ADMIT three values must not
-- smuggle in the first rule that could reject a fourth. 028 is the counter-
-- example and shows where a CHECK does belong: `linkedin_seats.auth_mode`
-- decides whether a password is read out of the vault at all, so a typo'd
-- third value there must fail at the write. Nothing branches on `kind` in a
-- way a typo could make dangerous -- an unrecognised kind is paced by nothing,
-- executed by nothing, and shows up as itself in the ledger.
--
-- PASSIVE, AND NOT UNPACED. Both halves belong in the record because the
-- schema is where the next reader starts.
--
--   Passive: `limits.ts` `PASSIVE_KINDS` gains all three. That carve-out
--   exists precisely for this class of action -- multiplying passive activity
--   by the week-1 zero leaves a new seat dormant for seven days and then
--   suddenly active, which is the "Slide and Spike" signature of 1.3 that the
--   pacing engine exists to prevent. Follow-and-like warming is not something
--   the warm-up suppresses; it is what the warm-up consists of.
--
--   Not unpaced: each kind carries its own daily ceiling in `engagement.ts`
--   and each goes through `evaluateLinkedInSafety` like every other kind.
--   Liking 200 posts in an hour is a ban signal however harmless one like is.
--   Every ceiling for these three is tagged UNVERIFIED-VENDOR -- LinkedIn
--   publishes nothing and 1.4's table has no row for them, so they are our
--   judgement anchored below the one passive kind that does have a reported
--   band, and they are labelled as judgement rather than dressed up as
--   evidence.
--
-- WHAT THE REPLAY GUARD NOW MEANS, and it is worth stating because it is a
-- product decision hiding in an index. `idx_linkedin_actions_target` is unique
-- on (workspace_id, seat_key, kind, target_ref), so one seat gets ONE like row
-- per TARGET, ever -- and a target is a person, not a post. Liking a second
-- post by the same person is therefore refused as a duplicate today. That is
-- deliberate and it is the conservative direction: repeatedly reacting to one
-- stranger's posts is a far stronger automation tell than reacting once to
-- thirty people's. Making likes repeatable would mean keying them by post URN,
-- which needs a target the driver cannot currently read (`LinkedInLocator` in
-- driver.ts exposes no getAttribute), so it is a later migration with a real
-- design behind it rather than a widened index bolted on here.
--
-- NO NEW INDEX. The per-kind rolling-window counts these kinds need are served
-- by idx_linkedin_actions_window (workspace_id, seat_key, kind, recorded_at
-- DESC) from 022, which is keyed by `kind` and therefore already covers three
-- more values of it; the claim path is served by idx_linkedin_actions_claimable
-- from 024, which does not mention `kind` at all. A fourth index over the same
-- columns would cost every write and answer no query the first two do not.

COMMENT ON COLUMN linkedin_actions.kind IS
  'invite | dm | inmail | profile_view | comment | follow | like | endorse. '
  'Different limits each. invite/dm/inmail/profile_view carry REPORTED pacing '
  'bands (limits.ts LINKEDIN_LIMITS); follow/like/endorse carry '
  'UNVERIFIED-VENDOR daily ceilings (engagement.ts ENGAGEMENT_LIMITS) and are '
  'PASSIVE_KINDS, so the warm-up multiplier does not zero them -- see '
  'migration 034 and limits.ts. comment is recordable but not paceable: no '
  'number was researched for it and inventing one is worse than refusing. '
  'Not CHECK-constrained, on purpose: see migration 034 and 023.';
