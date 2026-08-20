-- Stable managed-campaign progress across workflow edits.
--
-- `step_index` is kept as a denormalized display/compatibility cursor, but it is
-- no longer the identity of progress. Reordering or inserting workflow steps can
-- change an index without changing the step a lead is actually on. These two
-- fields make the durable identity the workflow step id instead:
--
--   * current_step_id: the not-yet-completed step this member is on;
--   * completed_step_ids: every step already passed for this member.
--
-- Existing members are backfilled from the campaign snapshot they were already
-- walking, so deployment does not reset anyone to the beginning.

ALTER TABLE linkedin_campaign_members
  ADD COLUMN IF NOT EXISTS current_step_id TEXT,
  ADD COLUMN IF NOT EXISTS completed_step_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE linkedin_campaign_members m
SET current_step_id = (
      SELECT step->>'id'
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(c.sequence_json->'steps') = 'array' THEN c.sequence_json->'steps'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS s(step, ord)
      WHERE ord = m.step_index + 1
      LIMIT 1
    ),
    completed_step_ids = COALESCE((
      SELECT jsonb_agg(step->>'id' ORDER BY ord)
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(c.sequence_json->'steps') = 'array' THEN c.sequence_json->'steps'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS s(step, ord)
      WHERE ord <= m.step_index AND NULLIF(step->>'id', '') IS NOT NULL
    ), '[]'::jsonb)
FROM linkedin_campaigns c
WHERE c.id=m.campaign_id
  AND c.workspace_id=m.workspace_id
  AND m.completed_step_ids='[]'::jsonb;
