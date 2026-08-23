import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { id, type Db } from '../db.js';
import type { BrowserProviderSettings } from '../browser/provider.js';
import {
  notifyCompanionDeviceDisconnected,
  notifyCompanionDeviceReconnected,
  notifyLinkedInSeatNeedsAttention,
  notifyLinkedInSeatRecovered
} from '../notifications.js';
import { recordSeatEvent } from './seat-events.js';
import { stampSeatSessionValid } from './seats.js';
import { markWorkspaceAvailabilityReturn } from './side-tasks.js';

const PAIRING_TTL_MS = 10 * 60_000;
export const COMPANION_DEVICE_ONLINE_MS = 90_000;
// Separate and unrelated to COMPANION_DEVICE_ONLINE_MS above, which drives the
// live "online" badge and companionWorkspaceReady. This one gates the
// disconnect/reconnect EMAIL: a short network blip should never alert anyone,
// but ten minutes plus a five-minute worker cadence made a real outage capable
// of staying silent for almost fifteen minutes. Five minutes is long enough to
// absorb Wi-Fi handoffs/sleep transitions while still being operationally useful.
export const COMPANION_DEVICE_DISCONNECT_GRACE_MS = 5 * 60_000;
const TOKEN_PREFIX = 'trv_cmp_';

// User-facing presence and recovery state are durable database heartbeats. The
// reverse-CDP relay keeps its live WebSocket ownership in its own process-local
// `controls` map and checks it immediately before accepting browser work; do not
// mix that ephemeral transport fact back into the website's online/offline UI.
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalisePairCode(value: string): string {
  return value.toUpperCase().replace(/[^A-F0-9]/g, '');
}

function presentPairCode(value: string): string {
  return value.match(/.{1,4}/g)?.join('-') ?? value;
}

function iso(date: Date): string {
  return date.toISOString();
}

export interface CompanionDeviceView {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface CompanionAttention {
  seatKey: string;
  label: string;
  kind: 'challenge' | 'reconnect_required';
  message: string;
  since: string;
}

export interface CompanionRecoveryView {
  seatKey: string;
  label: string;
  status: 'open' | 'verified';
  startedAt: string;
  verifiedAt: string | null;
  lastSeenAt: string;
}

export interface CompanionStatus {
  /** The one paired computer this workspace may run background LinkedIn work from. */
  devices: CompanionDeviceView[];
  /** Human-required LinkedIn recovery still unresolved by a healthy-session proof. */
  attention: CompanionAttention[];
  /** A visible recovery Chrome window that is still active on the paired computer. */
  recoveries: CompanionRecoveryView[];
}
export async function createCompanionPairing(
  db: Db,
  input: { workspaceId: string; actorUserId: string | null; now?: Date }
): Promise<{ code: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  // Pairing rows are operational handshakes, not durable audit records. Keep a
  // small grace window for debugging, then prune them as new pairings are made.
  await db
    .prepare(
      `
    DELETE FROM linkedin_companion_pairings
    WHERE workspace_id=? AND (
      (used_at IS NOT NULL AND used_at<?) OR expires_at<?
    )
  `
    )
    .run(
      input.workspaceId,
      iso(new Date(now.getTime() - 24 * 60 * 60_000)),
      iso(new Date(now.getTime() - 24 * 60 * 60_000))
    );
  const raw = randomBytes(6).toString('hex').toUpperCase();
  const code = presentPairCode(raw);
  await db
    .prepare(
      `
    INSERT INTO linkedin_companion_pairings (id, workspace_id, code_hash, created_by, expires_at, created_at)
    VALUES (?,?,?,?,?,?)
  `
    )
    .run(
      id('lcpair'),
      input.workspaceId,
      sha256(raw),
      input.actorUserId,
      iso(new Date(now.getTime() + PAIRING_TTL_MS)),
      iso(now)
    );
  return { code, expiresAt: iso(new Date(now.getTime() + PAIRING_TTL_MS)) };
}

export async function exchangeCompanionPairing(
  db: Db,
  input: { code: string; label: string; now?: Date }
): Promise<{ token: string; workspaceId: string; deviceId: string; label: string }> {
  const now = input.now ?? new Date();
  const normalised = normalisePairCode(input.code);
  if (normalised.length !== 12)
    throw new Error('That pairing code is not valid. Create a new one in Trevra and try again.');
  return db.transaction(async (tx) => {
    const pairing = await tx
      .prepare(
        `
      UPDATE linkedin_companion_pairings
      SET used_at=?
      WHERE code_hash=? AND used_at IS NULL AND expires_at>?
      RETURNING workspace_id, created_by
    `
      )
      .get<{ workspace_id: string; created_by: string | null }>(
        iso(now),
        sha256(normalised),
        iso(now)
      );
    if (!pairing)
      throw new Error(
        'That pairing code has expired or was already used. Create a new one in Trevra.'
      );

    // Serialize handovers for this workspace. The partial unique index is the
    // final invariant; this row lock makes concurrent valid exchanges resolve
    // as an orderly last-completing-wins replacement instead of a uniqueness
    // error that leaves the operator unsure which computer won.
    await tx
      .prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE')
      .get<{ id: string }>(pairing.workspace_id);

    const label = input.label.trim().slice(0, 120) || 'This computer';
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const deviceId = id('lcdev');

    // One active companion per workspace. Exchanging a new pairing code is the
    // handover point: the previous device is revoked atomically with creation
    // of its replacement. Merely generating a code never disconnects it.
    await tx
      .prepare(
        `
      UPDATE linkedin_companion_devices
      SET revoked_at=?
      WHERE workspace_id=? AND revoked_at IS NULL
    `
      )
      .run(iso(now), pairing.workspace_id);

    await tx
      .prepare(
        `
      INSERT INTO linkedin_companion_devices (id, workspace_id, label, token_hash, created_by, created_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?)
    `
      )
      .run(
        deviceId,
        pairing.workspace_id,
        label,
        sha256(token),
        pairing.created_by,
        iso(now),
        null
      );
    return { token, workspaceId: pairing.workspace_id, deviceId, label };
  });
}

interface CompanionTokenIdentity {
  deviceId: string;
  workspaceId: string;
  label: string;
  wasDisconnected: boolean;
}

async function companionTokenIdentity(
  db: Db,
  token: string,
  now: Date
): Promise<CompanionTokenIdentity | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 32) return null;
  const row = await db
    .prepare(
      `
    SELECT id, workspace_id, label, disconnect_notified_at IS NOT NULL AS was_disconnected
    FROM linkedin_companion_devices
    WHERE token_hash=? AND revoked_at IS NULL
  `
    )
    .get<{ id: string; workspace_id: string; label: string; was_disconnected: boolean }>(
      sha256(token)
    );
  if (!row) return null;
  await touchCompanionDevice(db, row.id, now);
  return {
    deviceId: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    wasDisconnected: row.was_disconnected
  };
}

export async function authenticateCompanionRecoveryToken(
  db: Db,
  token: string,
  now: Date = new Date()
): Promise<{ deviceId: string; workspaceId: string; label: string } | null> {
  const identity = await companionTokenIdentity(db, token, now);
  if (!identity) return null;
  return {
    deviceId: identity.deviceId,
    workspaceId: identity.workspaceId,
    label: identity.label
  };
}

export async function authenticateCompanionToken(
  db: Db,
  token: string,
  now: Date = new Date()
): Promise<{ deviceId: string; workspaceId: string; label: string } | null> {
  const identity = await companionTokenIdentity(db, token, now);
  if (!identity) return null;
  const row = {
    id: identity.deviceId,
    workspace_id: identity.workspaceId,
    label: identity.label,
    was_disconnected: identity.wasDisconnected
  };
  await db
    .prepare(
      `UPDATE linkedin_companion_recoveries
       SET status='closed',closed_at=?,last_seen_at=?
       WHERE workspace_id=? AND device_id=? AND status<>'closed'`
    )
    .run(iso(now), iso(now), row.workspace_id, row.id);
  // This runs exactly once per FRESH control connection (companion start, a
  // restart, or either half of `trevra linkedin reconnect`) -- never on a
  // routine keepalive ping, which touches `last_seen_at` directly in
  // companion-relay.ts without going through this function. A new connection
  // is always worth a catch-up, whether or not the gap since the last one
  // crossed the 90s "online" threshold: signing in during `trevra linkedin
  // reconnect` and closing the window typically takes well under 90s, and
  // that quick round trip is exactly the moment a fresh look matters most --
  // waiting on a stale time-gap check here is why the reconnect alert used to
  // sit there until the next already-scheduled visit noticed on its own.
  await markWorkspaceAvailabilityReturn(db, row.workspace_id, now);
  // Only a device that ACTUALLY got a disconnect email earlier gets a matching
  // reconnect email. Claim the send by clearing first (so two simultaneous new
  // control sockets cannot double-send), but restore the marker if delivery is
  // unavailable or fails so a later fresh connection can retry instead of
  // recording a reconnect notification that never existed.
  if (row.was_disconnected) {
    const cleared = await db
      .prepare(
        `
      UPDATE linkedin_companion_devices SET disconnect_notified_at=NULL WHERE id=? AND disconnect_notified_at IS NOT NULL
    `
      )
      .run(row.id);
    if (cleared.changes > 0) {
      try {
        const delivered = await notifyCompanionDeviceReconnected(db, {
          workspaceId: row.workspace_id,
          deviceLabel: row.label
        });
        if (!delivered) {
          await db
            .prepare(
              'UPDATE linkedin_companion_devices SET disconnect_notified_at=? WHERE id=? AND disconnect_notified_at IS NULL'
            )
            .run(iso(now), row.id);
        }
      } catch (notificationError) {
        await db
          .prepare(
            'UPDATE linkedin_companion_devices SET disconnect_notified_at=? WHERE id=? AND disconnect_notified_at IS NULL'
          )
          .run(iso(now), row.id)
          .catch(() => undefined);
        console.error(
          'Failed to deliver Trevra companion reconnect notification',
          notificationError
        );
      }
    }
  }
  return { deviceId: row.id, workspaceId: row.workspace_id, label: row.label };
}
export async function touchCompanionDevice(
  db: Db,
  deviceId: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare(
      `UPDATE linkedin_companion_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL`
    )
    .run(iso(now), deviceId);
}

export async function companionDeviceIsActive(db: Db, deviceId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM linkedin_companion_devices WHERE id=? AND revoked_at IS NULL`)
    .get<{ ok: number }>(deviceId);
  return Boolean(row);
}

/**
 * A periodic scan, not a request handler: never let a caller's tick die
 * because one workspace's SMTP hiccuped. Devices are processed independently,
 * each guarded by its own try/catch, and the `disconnect_notified_at IS NULL`
 * clause on the follow-up UPDATE makes a concurrent double-run of this scan a
 * no-op instead of a duplicate email.
 */
export async function notifyDisconnectedCompanionDevices(
  db: Db,
  now: Date = new Date()
): Promise<void> {
  const staleBefore = iso(new Date(now.getTime() - COMPANION_DEVICE_DISCONNECT_GRACE_MS));
  const devices = await db
    .prepare(
      `
    SELECT id, workspace_id, label,
           to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at
    FROM linkedin_companion_devices
    WHERE revoked_at IS NULL
      AND last_seen_at IS NOT NULL
      AND last_seen_at < ?
      AND disconnect_notified_at IS NULL
  `
    )
    .all<{ id: string; workspace_id: string; label: string; last_seen_at: string }>(staleBefore);

  await Promise.all(
    devices.map(async (device) => {
      try {
        const delivered = await notifyCompanionDeviceDisconnected(db, {
          workspaceId: device.workspace_id,
          deviceLabel: device.label,
          lastSeenAt: device.last_seen_at
        });
        // `disconnect_notified_at` means exactly what its name says. Before
        // this guard, SMTP being absent (or no owner recipient being resolved)
        // returned successfully and we permanently marked an email as sent.
        if (!delivered) return;
        await db
          .prepare(
            `
        UPDATE linkedin_companion_devices SET disconnect_notified_at=? WHERE id=? AND disconnect_notified_at IS NULL
      `
          )
          .run(iso(now), device.id);
      } catch (error) {
        console.error(
          'Failed to notify workspace of a disconnected LinkedIn companion device',
          error
        );
      }
    })
  );
}

export async function notifyCompanionSeatAttentionEmails(
  db: Db,
  now: Date = new Date()
): Promise<void> {
  const attention = await db
    .prepare(
      `
    WITH latest AS (
      SELECT DISTINCT ON (workspace_id, seat_key)
        id, workspace_id, seat_key, kind
      FROM linkedin_seat_events
      WHERE kind IN ('challenge','reconnect_required','session_reused','login','recovery_verified')
      ORDER BY workspace_id, seat_key, occurred_at DESC,
               CASE WHEN kind IN ('session_reused','login','recovery_verified') THEN 1 ELSE 0 END DESC
    )
    SELECT id, workspace_id, seat_key, kind
    FROM latest l
    WHERE kind IN ('challenge','reconnect_required')
      AND NOT EXISTS (
        SELECT 1 FROM linkedin_seat_events n
        WHERE n.workspace_id=l.workspace_id AND n.seat_key=l.seat_key
          AND n.kind='attention_email_sent' AND n.detail=l.id
      )
    LIMIT 100
  `
    )
    .all<{
      id: string;
      workspace_id: string;
      seat_key: string;
      kind: 'challenge' | 'reconnect_required';
    }>();

  for (const event of attention) {
    try {
      const delivered = await notifyLinkedInSeatNeedsAttention(db, {
        workspaceId: event.workspace_id,
        seatKey: event.seat_key,
        kind: event.kind
      });
      if (delivered) {
        await recordSeatEvent(
          db,
          {
            workspaceId: event.workspace_id,
            seatKey: event.seat_key,
            kind: 'attention_email_sent',
            detail: event.id
          },
          now
        );
      }
    } catch (error) {
      console.error('Failed to deliver LinkedIn seat attention email', error);
    }
  }

  const recovered = await db
    .prepare(
      `
    WITH ordered AS (
      SELECT e.*,
        lag(id) OVER (
          PARTITION BY workspace_id, seat_key
          ORDER BY occurred_at ASC,
                   CASE WHEN kind IN ('session_reused','login','recovery_verified') THEN 1 ELSE 0 END ASC
        ) AS previous_id,
        lag(kind) OVER (
          PARTITION BY workspace_id, seat_key
          ORDER BY occurred_at ASC,
                   CASE WHEN kind IN ('session_reused','login','recovery_verified') THEN 1 ELSE 0 END ASC
        ) AS previous_kind,
        row_number() OVER (
          PARTITION BY workspace_id, seat_key
          ORDER BY occurred_at DESC,
                   CASE WHEN kind IN ('session_reused','login','recovery_verified') THEN 1 ELSE 0 END DESC
        ) AS rn
      FROM linkedin_seat_events e
      WHERE kind IN ('challenge','reconnect_required','session_reused','login','recovery_verified')
    )
    SELECT id, workspace_id, seat_key, previous_id
    FROM ordered o
    WHERE rn=1 AND kind IN ('session_reused','login','recovery_verified')
      AND previous_kind IN ('challenge','reconnect_required')
      AND EXISTS (
        SELECT 1 FROM linkedin_seat_events n
        WHERE n.workspace_id=o.workspace_id AND n.seat_key=o.seat_key
          AND n.kind='attention_email_sent' AND n.detail=o.previous_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM linkedin_seat_events n
        WHERE n.workspace_id=o.workspace_id AND n.seat_key=o.seat_key
          AND n.kind='attention_recovery_email_sent' AND n.detail=o.id
      )
    LIMIT 100
  `
    )
    .all<{ id: string; workspace_id: string; seat_key: string; previous_id: string }>();

  for (const event of recovered) {
    try {
      const delivered = await notifyLinkedInSeatRecovered(db, {
        workspaceId: event.workspace_id,
        seatKey: event.seat_key
      });
      if (delivered) {
        await recordSeatEvent(
          db,
          {
            workspaceId: event.workspace_id,
            seatKey: event.seat_key,
            kind: 'attention_recovery_email_sent',
            detail: event.id
          },
          now
        );
      }
    } catch (error) {
      console.error('Failed to deliver LinkedIn seat recovery email', error);
    }
  }
}

export async function updateCompanionRecovery(
  db: Db,
  identity: { deviceId: string; workspaceId: string },
  input: { seatKey: string; state: 'open' | 'verified' | 'closed' },
  now: Date = new Date()
): Promise<boolean> {
  const seat = await db
    .prepare('SELECT label FROM linkedin_seats WHERE workspace_id=? AND seat_key=?')
    .get<{ label: string }>(identity.workspaceId, input.seatKey);
  if (!seat) return false;

  if (input.state === 'closed') {
    await db
      .prepare(
        `INSERT INTO linkedin_companion_recoveries
           (workspace_id,seat_key,device_id,status,started_at,last_seen_at,closed_at)
         VALUES (?,?,?,'closed',?,?,?)
         ON CONFLICT (workspace_id,seat_key) DO UPDATE SET
           device_id=EXCLUDED.device_id,status='closed',last_seen_at=EXCLUDED.last_seen_at,
           closed_at=EXCLUDED.closed_at`
      )
      .run(identity.workspaceId, input.seatKey, identity.deviceId, iso(now), iso(now), iso(now));
    return true;
  }

  const status = input.state;
  await db
    .prepare(
      `INSERT INTO linkedin_companion_recoveries
         (workspace_id,seat_key,device_id,status,started_at,verified_at,last_seen_at,closed_at)
       VALUES (?,?,?,?,?,?::timestamptz,?,NULL)
       ON CONFLICT (workspace_id,seat_key) DO UPDATE SET
         device_id=EXCLUDED.device_id,
         status=CASE
           WHEN linkedin_companion_recoveries.status='verified'
             AND EXCLUDED.status='open'
             AND linkedin_companion_recoveries.device_id=EXCLUDED.device_id
             AND linkedin_companion_recoveries.last_seen_at >= EXCLUDED.last_seen_at - INTERVAL '90 seconds'
             THEN 'verified'
           ELSE EXCLUDED.status
         END,
         started_at=CASE
           WHEN linkedin_companion_recoveries.status='closed'
             OR linkedin_companion_recoveries.device_id<>EXCLUDED.device_id
             OR linkedin_companion_recoveries.last_seen_at < EXCLUDED.last_seen_at - INTERVAL '90 seconds'
             THEN EXCLUDED.started_at
           ELSE linkedin_companion_recoveries.started_at
         END,
         verified_at=CASE
           WHEN EXCLUDED.status='open' AND (
             linkedin_companion_recoveries.status='closed'
             OR linkedin_companion_recoveries.device_id<>EXCLUDED.device_id
             OR linkedin_companion_recoveries.last_seen_at < EXCLUDED.last_seen_at - INTERVAL '90 seconds'
           ) THEN NULL
           ELSE COALESCE(EXCLUDED.verified_at,linkedin_companion_recoveries.verified_at)
         END,
         last_seen_at=EXCLUDED.last_seen_at,
         closed_at=NULL`
    )
    .run(
      identity.workspaceId,
      input.seatKey,
      identity.deviceId,
      status,
      iso(now),
      input.state === 'verified' ? iso(now) : null,
      iso(now)
    );

  if (input.state === 'verified') {
    await stampSeatSessionValid(db, identity.workspaceId, now, input.seatKey);
    if (await companionSeatNeedsAttention(db, identity.workspaceId, input.seatKey)) {
      await recordSeatEvent(
        db,
        {
          workspaceId: identity.workspaceId,
          seatKey: input.seatKey,
          kind: 'recovery_verified',
          detail:
            'The paired computer confirmed that the visible LinkedIn recovery window is signed in. Background execution remains paused until that window closes.'
        },
        now
      );
    }
  }
  return true;
}

export async function listCompanionStatus(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<CompanionStatus> {
  const devices = await db
    .prepare(
      `
    SELECT id, label,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at
    FROM linkedin_companion_devices
    WHERE workspace_id=? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `
    )
    .all<{ id: string; label: string; created_at: string; last_seen_at: string | null }>(
      workspaceId
    );
  const latestAuthEvents = await db
    .prepare(
      `
    SELECT DISTINCT ON (e.seat_key)
           e.seat_key,
           e.kind,
           e.detail,
           to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
           COALESCE(s.label, e.seat_key) AS label
    FROM linkedin_seat_events e
    LEFT JOIN linkedin_seats s ON s.workspace_id=e.workspace_id AND s.seat_key=e.seat_key
    WHERE e.workspace_id=?
      AND e.kind IN ('challenge','reconnect_required','session_reused','login','recovery_verified')
    ORDER BY e.seat_key, e.occurred_at DESC,
             CASE WHEN e.kind IN ('session_reused','login','recovery_verified') THEN 1 ELSE 0 END DESC
  `
    )
    .all<{
      seat_key: string;
      kind: string;
      detail: string | null;
      occurred_at: string;
      label: string;
    }>(workspaceId);

  const threshold = now.getTime() - COMPANION_DEVICE_ONLINE_MS;
  const recoveries = await db
    .prepare(
      `SELECT r.seat_key,r.status,
              to_char(r.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
              to_char(r.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS verified_at,
              to_char(r.last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at,
              COALESCE(s.label,r.seat_key) AS label
       FROM linkedin_companion_recoveries r
       LEFT JOIN linkedin_seats s ON s.workspace_id=r.workspace_id AND s.seat_key=r.seat_key
       WHERE r.workspace_id=? AND r.status IN ('open','verified') AND r.last_seen_at>=?::timestamptz
       ORDER BY r.started_at DESC`
    )
    .all<{
      seat_key: string;
      status: 'open' | 'verified';
      started_at: string;
      verified_at: string | null;
      last_seen_at: string;
      label: string;
    }>(workspaceId, iso(new Date(threshold)));

  return {
    devices: devices.map((device) => ({
      id: device.id,
      label: device.label,
      createdAt: device.created_at,
      lastSeenAt: device.last_seen_at,
      // User-facing presence is a durable authenticated heartbeat. The relay
      // itself performs the stricter live-WebSocket check before any browser
      // request, so an API-process restart cannot falsely paint an online
      // computer as offline while still preserving execution safety.
      online: Boolean(device.last_seen_at && new Date(device.last_seen_at).getTime() >= threshold)
    })),
    attention: latestAuthEvents
      .filter(
        (event): event is typeof event & { kind: 'challenge' | 'reconnect_required' } =>
          event.kind === 'challenge' || event.kind === 'reconnect_required'
      )
      .map((event) => ({
        seatKey: event.seat_key,
        label: event.label,
        kind: event.kind,
        message: event.detail ?? 'LinkedIn needs your attention on the paired computer.',
        since: event.occurred_at
      })),
    recoveries: recoveries.map((recovery) => ({
      seatKey: recovery.seat_key,
      label: recovery.label,
      status: recovery.status,
      startedAt: recovery.started_at,
      verifiedAt: recovery.verified_at,
      lastSeenAt: recovery.last_seen_at
    }))
  };
}

/** Whether this seat still has an unresolved human-recovery event. */
export async function companionSeatNeedsAttention(
  db: Db,
  workspaceId: string,
  seatKey: string
): Promise<boolean> {
  const event = await db
    .prepare(
      `
    SELECT kind
    FROM linkedin_seat_events
    WHERE workspace_id=? AND seat_key=?
      AND kind IN ('challenge','reconnect_required','session_reused','login','recovery_verified')
    ORDER BY occurred_at DESC,
             CASE WHEN kind IN ('session_reused','login','recovery_verified') THEN 1 ELSE 0 END DESC
    LIMIT 1
  `
    )
    .get<{ kind: string }>(workspaceId, seatKey);
  return event?.kind === 'challenge' || event?.kind === 'reconnect_required';
}

export async function revokeCompanionDevice(
  db: Db,
  workspaceId: string,
  deviceId: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await db
    .prepare(
      `
    UPDATE linkedin_companion_devices SET revoked_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL
  `
    )
    .run(iso(now), workspaceId, deviceId);
  return result.changes > 0;
}

/**
 * A companion workspace is ready to run background LinkedIn work only while
 * its paired device has a fresh heartbeat. The paired computer runs
 * independently once paired -- there is no separate website-presence lease.
 */
export async function companionWorkspaceReady(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<boolean> {
  const row = await db
    .prepare(
      `
    SELECT
      EXISTS(
        SELECT 1 FROM linkedin_companion_devices
        WHERE workspace_id=? AND revoked_at IS NULL AND last_seen_at>=?::timestamptz
      ) AS device_online,
      EXISTS(
        SELECT 1 FROM linkedin_companion_recoveries
        WHERE workspace_id=? AND status IN ('open','verified') AND last_seen_at>=?::timestamptz
      ) AS recovery_active
  `
    )
    .get<{ device_online: boolean; recovery_active: boolean }>(
      workspaceId,
      iso(new Date(now.getTime() - COMPANION_DEVICE_ONLINE_MS)),
      workspaceId,
      iso(new Date(now.getTime() - COMPANION_DEVICE_ONLINE_MS))
    );
  return Boolean(row?.device_online) && !Boolean(row?.recovery_active);
}

export function companionBrowserConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TREVRA_COMPANION_RELAY_URL?.trim();
  if (!raw || !env.TREVRA_SECRETS_KEY?.trim()) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

export function companionRelaySecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.TREVRA_SECRETS_KEY?.trim();
  if (!key) return null;
  return createHmac('sha256', key).update('trevra-linkedin-companion-relay-v1').digest('base64url');
}

export function companionRelaySecretMatches(
  supplied: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const expected = companionRelaySecret(env);
  if (!expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function companionBrowserSettings(
  env: NodeJS.ProcessEnv = process.env
): BrowserProviderSettings | null {
  const base = env.TREVRA_COMPANION_RELAY_URL?.trim().replace(/\/$/, '');
  const secret = companionRelaySecret(env);
  if (!base || !secret) return null;
  return {
    kind: 'remote',
    remote: {
      endpointTemplate: `${base}/api/linkedin/companion/browser/{workspace}/{seat}`,
      apiKey: null,
      connect: 'cdp',
      headers: { authorization: `Bearer ${secret}` },
      label: 'your connected computer',
      requireProxy: false,
      sessionPersistence: 'browser',
      useExistingContext: true
    },
    problem: null
  };
}
