-- The unified inbox: the conversations a LinkedIn seat is actually in.
--
-- WHY THIS EXISTS. Everything in this schema up to 030 describes what Trevra
-- SENT. `linkedin_actions` is a ledger of outbound facts and the funnel it
-- feeds effectively stops at 'sent': an operator can read the action queue but
-- cannot read a single word anybody wrote back, and cannot answer one. Dripify
-- and Waalaxy both ship a conversation view, and that is not decoration -- a
-- reply is the only outcome in the whole funnel a human has to respond to, and
-- it is the signal `acceptanceRate` and the day-over-day throttle are starved
-- of without it. Reply detection is what turns the ledger from a send log into
-- a funnel.
--
-- NEITHER TABLE IS A SECOND LEDGER, and that is the rule that keeps this
-- feature from punching a hole through the safety design:
--
--   * An OUTBOUND REPLY is not stored here as an intent. It is filed in
--     `linkedin_actions` as an ordinary `dm` -- paced, gated by
--     `evaluateLinkedInSafety`, claimed and executed by the local worker like
--     every other action. There is no outbox in this schema on purpose: an
--     outbox is exactly the shape a "just send this one quickly" path grows
--     out of, and a message that reaches LinkedIn without passing the gate is
--     the one thing the whole subsystem exists to prevent.
--   * An INBOUND REPLY does not write `linkedin_actions.status` from here.
--     `inbox.ts` reports it through `ingestOutcome` (`via: 'outcome-ingest'`),
--     which is the single sanctioned writer of a worker-only status --
--     `writeActionStatus` refuses that status from any other caller by
--     construction (campaigns.ts). This schema stores the conversation; the
--     ledger keeps owning what happened.
--
-- WHAT IS STORED IS A SNAPSHOT OF A PAGE WE READ, NEVER A FACT WE COMPUTED.
-- Everything below arrives from `driver-inbox.ts` reading the operator's own
-- signed-in browser, so every column that could not be read is NULL rather
-- than zero, empty or guessed -- the same rule `LinkedInSeatRead.degraded`
-- follows in driver.ts, for the same reason: a number nobody measured must
-- never be paced against.

CREATE TABLE IF NOT EXISTS linkedin_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Always 'owner' today. Carried for the same reason `linkedin_actions` has
  -- carried it since 022: the agency case is deferred, not refused, and this
  -- is the table that would be expensive to reshape once it holds history.
  seat_key TEXT NOT NULL DEFAULT 'owner',
  -- LinkedIn's own conversation id, as it appears in the messaging URL
  -- (/messaging/thread/2-.../). THE STABLE IDENTITY OF A CONVERSATION: names
  -- change, snippets change, unread flips on every read, and the URN does not.
  -- Unique per workspace -- see the index below.
  thread_urn TEXT NOT NULL,
  -- The other participant's canonical profile URL, in the exact form
  -- `profileUrlFor` produces, so it stays comparable with
  -- `linkedin_actions.target_ref`. THIS COLUMN IS THE CAMPAIGN LINKAGE: it is
  -- what makes "they replied" attachable to "we invited them".
  --
  -- NULLABLE, and null is a real value. The messaging rail does not publish a
  -- profile URL as text, so it is resolved by opening the participant's
  -- profile from the open thread -- one extra navigation, which can fail, be
  -- walled, or land somewhere that is not a profile. A thread with no profile
  -- URL is still a readable conversation; it simply cannot be linked to a
  -- campaign and cannot be replied to (the driver sends a DM by navigating to
  -- a profile), and both refusals say so.
  profile_url TEXT,
  -- The participant's display name as the thread header rendered it.
  name TEXT,
  -- When the last message in this conversation was rendered as having been
  -- sent. PARSED FROM DISPLAY TEXT ("10:42 AM", "Aug 3"), so it is accurate to
  -- the day at best and NULL whenever the text did not resolve.
  --
  -- NOTHING SAFETY-CRITICAL MAY EVER READ THIS COLUMN. Every rolling window,
  -- every ceiling and the day-over-day clamp read `linkedin_actions.recorded_at`
  -- and nothing else (actions.ts rule 1). This is an ordering key for a screen.
  last_message_at TIMESTAMPTZ,
  -- Whether LinkedIn was still showing an unread badge at the last sync.
  -- Overwritten on every sync rather than merged: it is a fact about the page
  -- we just read, and a stale one is worse than no badge at all.
  unread BOOLEAN NOT NULL DEFAULT FALSE,
  -- The one-line preview from the conversation rail. Kept so a list view can
  -- render without joining every message body.
  snippet TEXT NOT NULL DEFAULT '',
  -- The campaign this conversation belongs to, resolved by matching
  -- `profile_url` against `linkedin_actions.target_ref`.
  --
  -- A CACHED POINTER, NOT A SOURCE OF TRUTH, and deliberately not a foreign
  -- key -- same reasoning as `linkedin_exports.campaign_id` in 025: a campaign
  -- row may be pruned and a conversation must outlive it. Refreshed on every
  -- sync from the ledger, which is the thing that actually knows.
  campaign_id TEXT,
  -- When this row last reflected a real read of a real page. An operator
  -- deciding whether to trust `unread` needs to know how old it is.
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The identity of a conversation, and the whole of the sync's idempotency.
--
-- TOTAL rather than partial, unlike the guards in 022 and 025. Those exclude
-- the status that means "this never happened", so the claim can be retried. A
-- conversation has no such state: it either exists on LinkedIn or it does not,
-- and a second row for the same URN would not be a retry, it would be the same
-- conversation twice on one screen.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_threads_urn
  ON linkedin_threads(workspace_id, thread_urn);

-- The inbox list, newest conversation first. NULLS LAST because a thread whose
-- timestamp could not be parsed is not a thread from 1970.
CREATE INDEX IF NOT EXISTS idx_linkedin_threads_recent
  ON linkedin_threads(workspace_id, last_message_at DESC NULLS LAST);

-- The campaign filter on the inbox list.
CREATE INDEX IF NOT EXISTS idx_linkedin_threads_campaign
  ON linkedin_threads(workspace_id, campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS linkedin_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- A REAL foreign key, unlike `campaign_id` above, and the difference is the
  -- point: a message without its conversation is not history worth keeping,
  -- it is an orphan nobody can read or attribute. Deleting a thread deletes
  -- what was said in it.
  thread_id TEXT NOT NULL REFERENCES linkedin_threads(id) ON DELETE CASCADE,
  -- 'in'  -- they wrote it. The event that marks an action 'replied'.
  -- 'out' -- we did. Read back from the page after the worker sent it, never
  --          written speculatively at enqueue time: this table records what
  --          LinkedIn shows, and a message that failed to send must not appear
  --          in a transcript as though it had.
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Parsed from display text, exactly like `linkedin_threads.last_message_at`,
  -- and NULL whenever it did not resolve. NOT the ordering key -- see
  -- `position`.
  sent_at TIMESTAMPTZ,
  -- THE ORDERING KEY, and it is insertion order rather than the message's
  -- index in the transcript.
  --
  -- The driver reads the TAIL of a conversation (a bounded run cannot read a
  -- three-year thread), so a message's index shifts every time the thread
  -- grows, and using it would make the same message sort differently on every
  -- sync. Insertion order does not shift: LinkedIn renders a thread
  -- chronologically, so appending in read order preserves the real sequence,
  -- and a message seen for the first time always sorts after everything
  -- already stored. `sent_at` cannot do this job because it is a parse of
  -- rendered text and is frequently NULL.
  position INTEGER NOT NULL DEFAULT 0,
  -- THE DEDUPE KEY. Every sync re-reads the tail of a conversation, so the
  -- same message arrives again and again; without this the transcript would
  -- grow by its own length on every read.
  --
  -- LinkedIn's per-message URN is not readable through the driver's locator
  -- surface (count/first/click/fill/textContent -- no attribute read), so this
  -- is a hash of the message's own content: direction, timestamp text and
  -- body. THE KNOWN COST, stated rather than hidden: two byte-identical
  -- messages sent in the same rendered minute collapse into one row. That is
  -- the right way to be wrong -- the alternative duplicates the entire
  -- conversation on every single sync.
  external_ref TEXT NOT NULL,
  -- The `linkedin_actions.id` that produced an outbound message, when it can
  -- be attributed. Not a foreign key: the ledger is append-only history and a
  -- transcript must not depend on it being present.
  action_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The re-sync guard. Scoped to the thread rather than the workspace: the same
-- sentence sent to two different people is two messages, and hashing content
-- alone would silently drop the second.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_messages_ref
  ON linkedin_messages(workspace_id, thread_id, external_ref);

-- Reading one transcript in order.
CREATE INDEX IF NOT EXISTS idx_linkedin_messages_thread
  ON linkedin_messages(workspace_id, thread_id, position);

-- The "has a reply" filter on the inbox list, which is an EXISTS over inbound
-- messages. Partial, because inbound is the small and interesting half of this
-- table for a workspace that is doing outreach at all.
CREATE INDEX IF NOT EXISTS idx_linkedin_messages_inbound
  ON linkedin_messages(thread_id)
  WHERE direction = 'in';

-- Reply detection reads the ledger by target, case-insensitively and WITHOUT a
-- kind: "is there any action against the person in this thread". 022's
-- idx_linkedin_actions_target cannot serve that -- it leads with `kind` and is
-- not case-folded -- so without this index every inbound message would seq-scan
-- a ledger that keeps every action forever.
--
-- LOWER() for the reason 023 and 025 both settled on: a target_ref is typed by
-- a human or supplied by a CSV, and 'https://linkedin.com/in/Maya' is the same
-- person as 'https://linkedin.com/in/maya'.
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_target_ci
  ON linkedin_actions(workspace_id, seat_key, LOWER(target_ref))
  WHERE target_ref IS NOT NULL;
