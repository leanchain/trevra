-- ANSWERING SOMEBODY WHO WROTE TO YOU IS NOT OUTREACH.
--
-- The warm-up ceiling refuses a `reply` outright in a seat's first week (0/day)
-- for a good reason: a new automated account that starts messaging people is
-- the pattern LinkedIn restricts. But it was applied to EVERY reply, including
-- the one case that carries none of that risk -- a person answering a
-- conversation the other side started. That is the most ordinary thing anybody
-- does on LinkedIn, it is the thing a warm-up is supposed to look like, and
-- Trevra refused it with "wait for the ramp" for a week.
--
-- Migration 044 already put an escape hatch on the row (`override_warmup_
-- ceiling`), but it is only ever set by an explicit operator override -- and no
-- control in the product ever set it. So in practice there was no way to answer
-- a message at all in week one.
--
-- This column records the OTHER reason the ceiling may not apply: the thread
-- being answered already holds an inbound message. It lives on the row for the
-- same reason 044's does -- the local worker re-runs the whole gate before it
-- types anything, so a fact known only at queue time would be re-refused at
-- send time and the reply would sit in the queue forever.
--
-- It relaxes EXACTLY ONE CHECK, the same one: posture, the rolling windows, the
-- campaign ramp, business hours and duplicate-target all still run and can all
-- still refuse.
--
-- Idempotent: guarded, so a re-run and a fresh database are both no-ops.
ALTER TABLE linkedin_actions
ADD COLUMN IF NOT EXISTS reply_to_inbound BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN linkedin_actions.reply_to_inbound IS
'True when this reply answers a conversation that already holds a message FROM the other person. Set exclusively by enqueueReply (inbox.ts) from the thread''s own history, never by an operator and never by the worker; read by evaluateLinkedInSafety at queue time and again by the local worker''s pre-send re-evaluation. It relaxes ONLY the warmup-ceiling check, and for one reason: answering somebody who wrote to you is not outreach, so the ramp that exists to slow outreach does not apply to it. Every other gate still runs and can still refuse. Never set for any kind other than reply.';
