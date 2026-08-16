-- A workspace may have exactly one active LinkedIn companion device.
--
-- Earlier builds allowed multiple non-revoked device rows. Before adding the
-- partial unique index, keep the newest active device and revoke every older
-- one so upgrades are deterministic and never fail on existing data.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY workspace_id
           ORDER BY created_at DESC, id DESC
         ) AS position
  FROM linkedin_companion_devices
  WHERE revoked_at IS NULL
)
UPDATE linkedin_companion_devices AS device
SET revoked_at = now()
FROM ranked
WHERE device.id = ranked.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS linkedin_companion_devices_one_active_per_workspace
  ON linkedin_companion_devices(workspace_id)
  WHERE revoked_at IS NULL;
