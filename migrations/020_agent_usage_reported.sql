-- "Did the provider actually tell us what this call cost?"
--
-- 016 recorded prompt_tokens and completion_tokens as plain NOT NULL integers,
-- which quietly conflated two different claims. A provider that answers with a
-- usage block saying zero has told us the call was free. An OpenAI-compatible
-- shim that answers with no usage block at all has told us nothing -- and the
-- writer stored that as 0 too, priced it at 0, and so the workspace budget
-- never grew, the pre-flight never fired, and the cap never bound. An endpoint
-- that omits usage was free forever, which is exactly the failure the cap
-- exists to prevent (byok-and-hosted-agent.md section 4 predicts these shims by
-- name, section 5 is the promise they broke).
--
-- This column is the distinction. FALSE means the token counts beside it are
-- absent rather than zero, and that cost_cents is a deliberately conservative
-- per-call floor rather than a priced measurement. A founder asking "why did
-- this cost that" can then be told the true answer -- "your endpoint did not
-- report usage, so this was estimated" -- instead of being shown a zero that
-- looks like a bargain.
--
-- NULLABLE, and old rows stay NULL.
--
-- The column has three states on purpose: TRUE measured, FALSE estimated, NULL
-- unknown. Rows written before this migration are genuinely unknown -- the old
-- writer coerced an absent usage block to 0 and stored it identically to a real
-- zero, so nothing distinguishes them now. Back-filling TRUE would assert that
-- those calls reported their usage, which is exactly the claim the data cannot
-- support, and it would be the same mistake migration 019 declines to make one
-- file earlier when it leaves duration_ms NULL rather than guessing a plausible
-- number. New rows always state which of the two happened.
ALTER TABLE agent_model_calls
  ADD COLUMN IF NOT EXISTS usage_reported BOOLEAN;

-- "Which calls were estimated rather than measured" -- the question a spend
-- explanation asks, and the one a reconciliation walk asks first. Partial,
-- because the answer is almost always TRUE and indexing that half buys nothing.
CREATE INDEX IF NOT EXISTS idx_agent_model_calls_unreported
  ON agent_model_calls(workspace_id, created_at DESC)
  WHERE usage_reported IS FALSE;
