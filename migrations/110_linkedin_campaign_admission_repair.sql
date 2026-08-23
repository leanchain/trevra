-- Repair campaigns that were already in flight when migration 086 introduced
-- capacity-safe admission waves.
--
-- 086 added admitted_at/wave_id but deliberately did not guess how to backfill
-- existing rows. That left legacy members in status='active'/'waiting' with a
-- NULL admitted_at. The modern runner correctly ignores unadmitted rows, so an
-- already-progressed member could become invisible: neither planned nor blocked.
--
-- Preserve only progress we can prove. Members that have already advanced (or
-- have durable action/task evidence) become a synthetic ordinal-0 legacy wave.
-- Untouched legacy 'active' members return to pending so the current admission
-- controller can admit them gradually under today's sender capacity.

CREATE TEMP TABLE linkedin_legacy_admission_repair ON COMMIT DROP AS
SELECT
  m.workspace_id,
  m.campaign_id,
  m.id AS member_id,
  COALESCE(
    (
      SELECT MIN(COALESCE(a.recorded_at,a.planned_for,a.created_at))
      FROM linkedin_actions a
      WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id
    ),
    m.created_at
  ) AS recovered_admitted_at
FROM linkedin_campaign_members m
WHERE m.admitted_at IS NULL
  AND (
    m.status IN ('waiting','manual')
    OR (
      m.status='active' AND (
        m.step_index > 0
        OR m.last_action_id IS NOT NULL
        OR COALESCE(m.completed_step_ids,'[]'::jsonb) <> '[]'::jsonb
        OR EXISTS (
          SELECT 1 FROM linkedin_actions a
          WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id
        )
        OR EXISTS (
          SELECT 1 FROM linkedin_campaign_channel_actions a
          WHERE a.workspace_id=m.workspace_id AND a.member_id=m.id
        )
        OR EXISTS (
          SELECT 1 FROM linkedin_manual_tasks t
          WHERE t.workspace_id=m.workspace_id AND t.member_id=m.id
        )
      )
    )
    OR (
      m.status='paused' AND (
        m.paused_from_status IN ('waiting','manual')
        OR (
          m.paused_from_status='active' AND (
            m.step_index > 0
            OR m.last_action_id IS NOT NULL
            OR COALESCE(m.completed_step_ids,'[]'::jsonb) <> '[]'::jsonb
            OR EXISTS (
              SELECT 1 FROM linkedin_actions a
              WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id
            )
            OR EXISTS (
              SELECT 1 FROM linkedin_campaign_channel_actions a
              WHERE a.workspace_id=m.workspace_id AND a.member_id=m.id
            )
            OR EXISTS (
              SELECT 1 FROM linkedin_manual_tasks t
              WHERE t.workspace_id=m.workspace_id AND t.member_id=m.id
            )
          )
        )
      )
    )
  );

INSERT INTO linkedin_campaign_waves
  (id,workspace_id,campaign_id,ordinal,admitted_at,member_count,admission_reason,capacity_snapshot,created_at)
SELECT
  'liwave_legacy_' || SUBSTRING(MD5(r.workspace_id || ':' || r.campaign_id),1,16),
  r.workspace_id,
  r.campaign_id,
  0,
  MIN(r.recovered_admitted_at),
  COUNT(*)::int,
  'Recovered in-flight members created before capacity-safe campaign waves.',
  '{}'::jsonb,
  CURRENT_TIMESTAMP
FROM linkedin_legacy_admission_repair r
GROUP BY r.workspace_id,r.campaign_id
ON CONFLICT (campaign_id,ordinal) DO NOTHING;

UPDATE linkedin_campaign_members m
SET admitted_at=r.recovered_admitted_at,
    wave_id=COALESCE(m.wave_id,w.id),
    assigned_seat_key=COALESCE(m.assigned_seat_key,c.seat_key),
    workflow_snapshot_json=COALESCE(m.workflow_snapshot_json,c.sequence_json),
    workflow_version=COALESCE(
      m.workflow_version,
      CASE
        WHEN (c.sequence_json->>'workflowVersion') ~ '^[0-9]+$'
          THEN (c.sequence_json->>'workflowVersion')::integer
        ELSE NULL
      END
    )
FROM linkedin_legacy_admission_repair r
JOIN linkedin_campaigns c
  ON c.workspace_id=r.workspace_id AND c.id=r.campaign_id
LEFT JOIN linkedin_campaign_waves w
  ON w.workspace_id=r.workspace_id AND w.campaign_id=r.campaign_id AND w.ordinal=0
WHERE m.workspace_id=r.workspace_id AND m.id=r.member_id AND m.admitted_at IS NULL;

-- A legacy 'active' row with no progress evidence never actually entered a
-- capacity-safe wave. Put it back at the admission boundary instead of silently
-- declaring the whole old audience admitted at once.
UPDATE linkedin_campaign_members m
SET status='pending',
    current_step_id=NULL,
    next_eligible_at=NULL,
    assigned_seat_key=NULL,
    workflow_snapshot_json=NULL,
    workflow_version=NULL,
    wave_id=NULL
WHERE m.admitted_at IS NULL
  AND m.status='active'
  AND m.step_index=0
  AND m.last_action_id IS NULL
  AND COALESCE(m.completed_step_ids,'[]'::jsonb)='[]'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM linkedin_actions a
    WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM linkedin_campaign_channel_actions a
    WHERE a.workspace_id=m.workspace_id AND a.member_id=m.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM linkedin_manual_tasks t
    WHERE t.workspace_id=m.workspace_id AND t.member_id=m.id
  );
