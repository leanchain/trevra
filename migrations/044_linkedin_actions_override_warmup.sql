-- Migration 044: a per-row escape hatch for the warm-up ramp.
--
-- The gate's `warmup-ceiling` check (guard.ts) refuses a `reply` outright in
-- a seat's first week -- 0/day, by design, because messaging strangers is not
-- the warm-up. An operator who wants to answer one conversation anyway, on
-- their own judgement, needs that decision to survive from the moment they
-- queue it to the moment the local worker actually sends it: the worker
-- re-runs the WHOLE gate before typing anything (local-worker.ts), so an
-- override that lived only in the HTTP request would be silently re-refused
-- at send time and the reply would sit in the queue forever. Storing it on
-- the row is what makes the decision travel with it.
ALTER TABLE linkedin_actions
ADD COLUMN IF NOT EXISTS override_warmup_ceiling BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN linkedin_actions.override_warmup_ceiling IS
'True only when the operator explicitly overrode a warmup-ceiling refusal for this one reply, via the "Override the warm-up ceiling" control in the inbox composer. Set exclusively by enqueueReply (inbox.ts); read by evaluateLinkedInSafety''s caller at queue time and again by the local worker''s pre-send re-evaluation (local-worker.ts), so the override sticks to the row instead of needing to be re-supplied. It relaxes ONLY the warmup-ceiling check -- every other gate (posture, rolling windows, business hours, duplicate-target, ...) still runs and can still refuse. Never set for any kind other than reply, and never set by anything the worker decides on its own.';
