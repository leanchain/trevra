import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { id, type Db } from '../db.js';
import type { BrowserProviderSettings } from '../browser/provider.js';
import { notifyCompanionDeviceDisconnected, notifyCompanionDeviceReconnected } from '../notifications.js';
import { markWorkspaceAvailabilityReturn } from './side-tasks.js';

const PAIRING_TTL_MS = 10 * 60_000;
export const COMPANION_DEVICE_ONLINE_MS = 90_000;
// Separate and unrelated to COMPANION_DEVICE_ONLINE_MS above, which drives the
// live "online" badge and companionWorkspaceReady. This one gates the
// disconnect/reconnect EMAIL: a short network blip should never alert anyone,
// so we wait far longer than the 90s online threshold before treating a quiet
// device as a real outage worth emailing about.
export const COMPANION_DEVICE_DISCONNECT_GRACE_MS = 10 * 60_000;
const TOKEN_PREFIX = 'trv_cmp_';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalisePairCode(value: string): string {
  return value.toUpperCase().replace(/[^A-F0-9]/g, '');
}

function presentPairCode(value: string): string {
  return value.match(/.{1,4}/g)?.join('-') ?? value;
}

function iso(date: Date): string { return date.toISOString(); }

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

export interface CompanionStatus {
  /** The one paired computer this workspace may run background LinkedIn work from. */
  devices: CompanionDeviceView[];
  /**
   * Human-required LinkedIn recovery, one latest state per seat. A later
   * session_reused/login event clears it implicitly, so no separate mutable
   * alert flag can get stuck after the browser is healthy again.
   */
  attention: CompanionAttention[];
}

export async function createCompanionPairing(
  db: Db,
  input: { workspaceId: string; actorUserId: string | null; now?: Date }
): Promise<{ code: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  // Pairing rows are operational handshakes, not durable audit records. Keep a
  // small grace window for debugging, then prune them as new pairings are made.
  await db.prepare(`
    DELETE FROM linkedin_companion_pairings
    WHERE workspace_id=? AND (
      (used_at IS NOT NULL AND used_at<?) OR expires_at<?
    )
  `).run(
    input.workspaceId,
    iso(new Date(now.getTime() - 24 * 60 * 60_000)),
    iso(new Date(now.getTime() - 24 * 60 * 60_000))
  );
  const raw = randomBytes(6).toString('hex').toUpperCase();
  const code = presentPairCode(raw);
  await db.prepare(`
    INSERT INTO linkedin_companion_pairings (id, workspace_id, code_hash, created_by, expires_at, created_at)
    VALUES (?,?,?,?,?,?)
  `).run(id('lcpair'), input.workspaceId, sha256(raw), input.actorUserId, iso(new Date(now.getTime() + PAIRING_TTL_MS)), iso(now));
  return { code, expiresAt: iso(new Date(now.getTime() + PAIRING_TTL_MS)) };
}

export async function exchangeCompanionPairing(
  db: Db,
  input: { code: string; label: string; now?: Date }
): Promise<{ token: string; workspaceId: string; deviceId: string; label: string }> {
  const now = input.now ?? new Date();
  const normalised = normalisePairCode(input.code);
  if (normalised.length !== 12) throw new Error('That pairing code is not valid. Create a new one in Trevra and try again.');
  return db.transaction(async (tx) => {
    const pairing = await tx.prepare(`
      UPDATE linkedin_companion_pairings
      SET used_at=?
      WHERE code_hash=? AND used_at IS NULL AND expires_at>?
      RETURNING workspace_id, created_by
    `).get<{ workspace_id: string; created_by: string | null }>(iso(now), sha256(normalised), iso(now));
    if (!pairing) throw new Error('That pairing code has expired or was already used. Create a new one in Trevra.');

    // Serialize handovers for this workspace. The partial unique index is the
    // final invariant; this row lock makes concurrent valid exchanges resolve
    // as an orderly last-completing-wins replacement instead of a uniqueness
    // error that leaves the operator unsure which computer won.
    await tx.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get<{ id: string }>(pairing.workspace_id);

    const label = input.label.trim().slice(0, 120) || 'This computer';
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const deviceId = id('lcdev');

    // One active companion per workspace. Exchanging a new pairing code is the
    // handover point: the previous device is revoked atomically with creation
    // of its replacement. Merely generating a code never disconnects it.
    await tx.prepare(`
      UPDATE linkedin_companion_devices
      SET revoked_at=?
      WHERE workspace_id=? AND revoked_at IS NULL
    `).run(iso(now), pairing.workspace_id);

    await tx.prepare(`
      INSERT INTO linkedin_companion_devices (id, workspace_id, label, token_hash, created_by, created_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(deviceId, pairing.workspace_id, label, sha256(token), pairing.created_by, iso(now), null);
    return { token, workspaceId: pairing.workspace_id, deviceId, label };
  });
}

export async function authenticateCompanionToken(
  db: Db,
  token: string,
  now: Date = new Date()
): Promise<{ deviceId: string; workspaceId: string; label: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 32) return null;
  const row = await db.prepare(`
    SELECT id, workspace_id, label, disconnect_notified_at IS NOT NULL AS was_disconnected,
           to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at
    FROM linkedin_companion_devices
    WHERE token_hash=? AND revoked_at IS NULL
  `).get<{ id: string; workspace_id: string; label: string; last_seen_at: string | null; was_disconnected: boolean }>(sha256(token));
  if (!row) return null;
  const previousSeen = row.last_seen_at ? new Date(row.last_seen_at) : null;
  const returnedAfterOffline = !previousSeen
    || Number.isNaN(previousSeen.getTime())
    || now.getTime() - previousSeen.getTime() >= COMPANION_DEVICE_ONLINE_MS;
  await touchCompanionDevice(db, row.id, now);
  if (returnedAfterOffline) await markWorkspaceAvailabilityReturn(db, row.workspace_id, now);
  // Only a device that actually got a disconnect email earlier (a real,
  // grace-period-cleared outage) gets a reconnect email now. A blip under the
  // 10-minute grace never set disconnect_notified_at, so it stays silent on
  // both ends -- no disconnect email, no reconnect email either. The guard on
  // the UPDATE makes a concurrent heartbeat race resolve as at most one email.
  if (row.was_disconnected) {
    const cleared = await db.prepare(`
      UPDATE linkedin_companion_devices SET disconnect_notified_at=NULL WHERE id=? AND disconnect_notified_at IS NOT NULL
    `).run(row.id);
    if (cleared.changes > 0) {
      try {
        await notifyCompanionDeviceReconnected(db, { workspaceId: row.workspace_id, deviceLabel: row.label });
      } catch (notificationError) {
        console.error('Failed to deliver Trevra companion reconnect notification', notificationError);
      }
    }
  }
  return { deviceId: row.id, workspaceId: row.workspace_id, label: row.label };
}
export async function touchCompanionDevice(db: Db, deviceId: string, now: Date = new Date()): Promise<void> {
  await db.prepare(`UPDATE linkedin_companion_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL`).run(iso(now), deviceId);
}

export async function companionDeviceIsActive(db: Db, deviceId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS ok FROM linkedin_companion_devices WHERE id=? AND revoked_at IS NULL`).get<{ ok: number }>(deviceId);
  return Boolean(row);
}

/**
 * A periodic scan, not a request handler: never let a caller's tick die
 * because one workspace's SMTP hiccuped. Devices are processed independently,
 * each guarded by its own try/catch, and the `disconnect_notified_at IS NULL`
 * clause on the follow-up UPDATE makes a concurrent double-run of this scan a
 * no-op instead of a duplicate email.
 */
export async function notifyDisconnectedCompanionDevices(db: Db, now: Date = new Date()): Promise<void> {
  const staleBefore = iso(new Date(now.getTime() - COMPANION_DEVICE_DISCONNECT_GRACE_MS));
  const devices = await db.prepare(`
    SELECT id, workspace_id, label,
           to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at
    FROM linkedin_companion_devices
    WHERE revoked_at IS NULL
      AND last_seen_at IS NOT NULL
      AND last_seen_at < ?
      AND disconnect_notified_at IS NULL
  `).all<{ id: string; workspace_id: string; label: string; last_seen_at: string }>(staleBefore);

  await Promise.all(devices.map(async (device) => {
    try {
      await notifyCompanionDeviceDisconnected(db, {
        workspaceId: device.workspace_id,
        deviceLabel: device.label,
        lastSeenAt: device.last_seen_at
      });
      await db.prepare(`
        UPDATE linkedin_companion_devices SET disconnect_notified_at=? WHERE id=? AND disconnect_notified_at IS NULL
      `).run(iso(now), device.id);
    } catch (error) {
      console.error('Failed to notify workspace of a disconnected LinkedIn companion device', error);
    }
  }));
}

export async function listCompanionStatus(db: Db, workspaceId: string, now: Date = new Date()): Promise<CompanionStatus> {
  const devices = await db.prepare(`
    SELECT id, label,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at
    FROM linkedin_companion_devices
    WHERE workspace_id=? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).all<{ id: string; label: string; created_at: string; last_seen_at: string | null }>(workspaceId);
  const latestAuthEvents = await db.prepare(`
    SELECT DISTINCT ON (e.seat_key)
           e.seat_key,
           e.kind,
           e.detail,
           to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
           COALESCE(s.label, e.seat_key) AS label
    FROM linkedin_seat_events e
    LEFT JOIN linkedin_seats s ON s.workspace_id=e.workspace_id AND s.seat_key=e.seat_key
    WHERE e.workspace_id=?
      AND e.kind IN ('challenge','reconnect_required','session_reused','login')
    ORDER BY e.seat_key, e.occurred_at DESC
  `).all<{ seat_key: string; kind: string; detail: string | null; occurred_at: string; label: string }>(workspaceId);

  const threshold = now.getTime() - COMPANION_DEVICE_ONLINE_MS;
  return {
    devices: devices.map((device) => ({
      id: device.id,
      label: device.label,
      createdAt: device.created_at,
      lastSeenAt: device.last_seen_at,
      online: Boolean(device.last_seen_at && new Date(device.last_seen_at).getTime() >= threshold)
    })),
    attention: latestAuthEvents
      .filter((event): event is typeof event & { kind: 'challenge' | 'reconnect_required' } => event.kind === 'challenge' || event.kind === 'reconnect_required')
      .map((event) => ({
        seatKey: event.seat_key,
        label: event.label,
        kind: event.kind,
        message: event.detail ?? 'LinkedIn needs your attention on the paired computer.',
        since: event.occurred_at
      }))
  };
}

export async function revokeCompanionDevice(db: Db, workspaceId: string, deviceId: string, now: Date = new Date()): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE linkedin_companion_devices SET revoked_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL
  `).run(iso(now), workspaceId, deviceId);
  return result.changes > 0;
}

/**
 * A companion workspace is ready to run background LinkedIn work only while
 * its paired device has a fresh heartbeat. The paired computer runs
 * independently once paired -- there is no separate website-presence lease.
 */
export async function companionWorkspaceReady(db: Db, workspaceId: string, now: Date = new Date()): Promise<boolean> {
  const row = await db.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM linkedin_companion_devices
      WHERE workspace_id=? AND revoked_at IS NULL AND last_seen_at>=?
    ) AS device_online
  `).get<{ device_online: boolean }>(
    workspaceId,
    iso(new Date(now.getTime() - COMPANION_DEVICE_ONLINE_MS))
  );
  return Boolean(row?.device_online);
}

export function companionBrowserConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TREVRA_COMPANION_RELAY_URL?.trim();
  if (!raw || !env.TREVRA_SECRETS_KEY?.trim()) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch { return false; }
}

export function companionRelaySecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.TREVRA_SECRETS_KEY?.trim();
  if (!key) return null;
  return createHmac('sha256', key).update('trevra-linkedin-companion-relay-v1').digest('base64url');
}

export function companionRelaySecretMatches(supplied: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = companionRelaySecret(env);
  if (!expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function companionBrowserSettings(env: NodeJS.ProcessEnv = process.env): BrowserProviderSettings | null {
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
