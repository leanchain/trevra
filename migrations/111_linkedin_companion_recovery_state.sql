-- Durable state for one visible LinkedIn recovery session.
--
-- Recovery is deliberately separate from ordinary companion presence. While a
-- visible recovery window is open, the paired computer may be online and the
-- LinkedIn session may already be authenticated, but background execution must
-- remain unavailable until that window closes and the normal relay service
-- resumes. A heartbeat lets abandoned/crashed recovery sessions expire instead
-- of leaving a permanent lock.

CREATE TABLE IF NOT EXISTS linkedin_companion_recoveries (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seat_key text NOT NULL,
  device_id text NOT NULL REFERENCES linkedin_companion_devices(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('open','verified','closed')),
  started_at timestamptz NOT NULL,
  verified_at timestamptz,
  last_seen_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (workspace_id, seat_key)
);

CREATE INDEX IF NOT EXISTS linkedin_companion_recoveries_live_idx
  ON linkedin_companion_recoveries(workspace_id, status, last_seen_at DESC);
