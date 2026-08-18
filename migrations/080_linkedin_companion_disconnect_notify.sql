-- Disconnect/reconnect alerting for the paired LinkedIn companion device.
-- `disconnect_notified_at` tracks whether the workspace has already been
-- emailed about the device's current outage: NULL means no outstanding
-- alert, set means an email went out and we are waiting to see the device
-- come back so we can send the matching reconnect email and clear it.
ALTER TABLE linkedin_companion_devices
  ADD COLUMN IF NOT EXISTS disconnect_notified_at timestamptz;
