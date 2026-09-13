-- Extend recurring Market Pulse preparation to named brand-watch scopes.
-- Existing rows remain account-watchlist schedules by default.

ALTER TABLE content_pulse_schedules
  ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'accounts',
  ADD COLUMN IF NOT EXISTS watch_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='content_pulse_schedules_scope_type_check'
      AND conrelid='content_pulse_schedules'::regclass
  ) THEN
    ALTER TABLE content_pulse_schedules
      ADD CONSTRAINT content_pulse_schedules_scope_type_check
      CHECK (scope_type IN ('accounts','brand_watch')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='content_pulse_schedules_watch_fkey'
      AND conrelid='content_pulse_schedules'::regclass
  ) THEN
    ALTER TABLE content_pulse_schedules
      ADD CONSTRAINT content_pulse_schedules_watch_fkey
      FOREIGN KEY (watch_id) REFERENCES brand_watches(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='content_pulse_schedules_scope_shape_check'
      AND conrelid='content_pulse_schedules'::regclass
  ) THEN
    ALTER TABLE content_pulse_schedules
      ADD CONSTRAINT content_pulse_schedules_scope_shape_check
      CHECK (
        (scope_type='accounts' AND watch_id IS NULL)
        OR
        (scope_type='brand_watch' AND watch_id IS NOT NULL AND tag IS NULL)
      ) NOT VALID;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_content_pulse_schedule_scope;
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_pulse_schedule_scope_v2
  ON content_pulse_schedules(
    workspace_id,
    scope_type,
    COALESCE(LOWER(tag),''),
    COALESCE(watch_id,'')
  );
