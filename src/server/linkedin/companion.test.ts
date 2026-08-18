import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notificationMock = vi.hoisted(() => ({
  notifyCompanionDeviceDisconnected: vi.fn(async () => undefined),
  notifyCompanionDeviceReconnected: vi.fn(async () => undefined)
}));
vi.mock('../notifications.js', () => notificationMock);

import { openDatabase, type Db } from '../db.js';
import { recordSeatEvent } from './seat-events.js';
import { upsertSeat } from './seats.js';
import { AVAILABILITY_RETURN_MARKER, sideTaskRuns } from './side-tasks.js';
import {
  COMPANION_DEVICE_DISCONNECT_GRACE_MS,
  COMPANION_DEVICE_ONLINE_MS,
  authenticateCompanionToken,
  companionBrowserConfigured,
  companionBrowserSettings,
  companionWorkspaceReady,
  createCompanionPairing,
  exchangeCompanionPairing,
  listCompanionStatus,
  notifyDisconnectedCompanionDevices,
  revokeCompanionDevice
} from './companion.js';

const WORKSPACE_ID = 'ws_linkedin_companion_test';
const NOW = new Date('2026-08-16T12:00:00.000Z');
const ENV = {
  TREVRA_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  TREVRA_COMPANION_RELAY_URL: 'ws://trevra:8080'
} as NodeJS.ProcessEnv;

let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Companion test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_companion_devices WHERE workspace_id=?').run(WORKSPACE_ID);
  await db
    .prepare('DELETE FROM linkedin_companion_pairings WHERE workspace_id=?')
    .run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_side_task_runs WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
  notificationMock.notifyCompanionDeviceDisconnected.mockClear();
  notificationMock.notifyCompanionDeviceReconnected.mockClear();
});

afterEach(async () => {
  await db.close();
});

describe('LinkedIn companion pairing and presence', () => {
  it('stores neither the one-time pairing code nor the reusable device token in plaintext', async () => {
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const normalized = pairing.code.replaceAll('-', '');
    expect(normalized).toMatch(/^[A-F0-9]{12}$/);

    const pairingRow = await db
      .prepare('SELECT code_hash FROM linkedin_companion_pairings WHERE workspace_id=?')
      .get<{ code_hash: string }>(WORKSPACE_ID);
    expect(pairingRow?.code_hash).toHaveLength(64);
    expect(pairingRow?.code_hash).not.toContain(normalized);

    const paired = await exchangeCompanionPairing(db, {
      code: pairing.code,
      label: 'Pankaj laptop',
      now: new Date(NOW.getTime() + 1000)
    });
    expect(paired.token).toMatch(/^trv_cmp_/);

    const deviceRow = await db
      .prepare('SELECT token_hash FROM linkedin_companion_devices WHERE id=?')
      .get<{ token_hash: string }>(paired.deviceId);
    expect(deviceRow?.token_hash).toHaveLength(64);
    expect(deviceRow?.token_hash).not.toContain(paired.token);
    expect(
      await authenticateCompanionToken(db, paired.token, new Date(NOW.getTime() + 2000))
    ).toMatchObject({
      workspaceId: WORKSPACE_ID,
      deviceId: paired.deviceId,
      label: 'Pankaj laptop'
    });
  });

  it('makes a pairing code one-time and short-lived', async () => {
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    await exchangeCompanionPairing(db, {
      code: pairing.code,
      label: 'Laptop',
      now: new Date(NOW.getTime() + 1000)
    });
    await expect(
      exchangeCompanionPairing(db, {
        code: pairing.code,
        label: 'Replay',
        now: new Date(NOW.getTime() + 2000)
      })
    ).rejects.toThrow(/expired or was already used/i);

    const expired = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    await expect(
      exchangeCompanionPairing(db, {
        code: expired.code,
        label: 'Late',
        now: new Date(NOW.getTime() + 11 * 60_000)
      })
    ).rejects.toThrow(/expired or was already used/i);
  });

  it('allows only one active paired computer and revokes the old token only when the replacement actually pairs', async () => {
    const firstPairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const first = await exchangeCompanionPairing(db, {
      code: firstPairing.code,
      label: 'Laptop A',
      now: new Date(NOW.getTime() + 1000)
    });

    const secondPairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: new Date(NOW.getTime() + 2000)
    });
    // Merely creating a handover code does not interrupt the current computer.
    expect(
      await authenticateCompanionToken(db, first.token, new Date(NOW.getTime() + 3000))
    ).not.toBeNull();

    const second = await exchangeCompanionPairing(db, {
      code: secondPairing.code,
      label: 'Laptop B',
      now: new Date(NOW.getTime() + 4000)
    });
    expect(
      await authenticateCompanionToken(db, first.token, new Date(NOW.getTime() + 5000))
    ).toBeNull();
    expect(
      await authenticateCompanionToken(db, second.token, new Date(NOW.getTime() + 5000))
    ).toMatchObject({
      workspaceId: WORKSPACE_ID,
      deviceId: second.deviceId,
      label: 'Laptop B'
    });

    const active = await db
      .prepare(
        `
      SELECT COUNT(*)::int AS total
      FROM linkedin_companion_devices
      WHERE workspace_id=? AND revoked_at IS NULL
    `
      )
      .get<{ total: number }>(WORKSPACE_ID);
    expect(active?.total).toBe(1);
    expect(
      (await listCompanionStatus(db, WORKSPACE_ID, new Date(NOW.getTime() + 5000))).devices
    ).toEqual([expect.objectContaining({ id: second.deviceId, label: 'Laptop B' })]);
  });

  it('serializes concurrent replacements so exactly one token remains active', async () => {
    const first = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const second = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: new Date(NOW.getTime() + 1)
    });
    const paired = await Promise.all([
      exchangeCompanionPairing(db, {
        code: first.code,
        label: 'Laptop A',
        now: new Date(NOW.getTime() + 1000)
      }),
      exchangeCompanionPairing(db, {
        code: second.code,
        label: 'Laptop B',
        now: new Date(NOW.getTime() + 1000)
      })
    ]);
    const auth = await Promise.all(
      paired.map((device) =>
        authenticateCompanionToken(db, device.token, new Date(NOW.getTime() + 2000))
      )
    );
    expect(auth.filter(Boolean)).toHaveLength(1);
    const active = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM linkedin_companion_devices WHERE workspace_id=? AND revoked_at IS NULL`
      )
      .get<{ total: number }>(WORKSPACE_ID);
    expect(active?.total).toBe(1);
  });

  it('requires the paired computer to be online before work is eligible', async () => {
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const paired = await exchangeCompanionPairing(db, {
      code: pairing.code,
      label: 'Laptop',
      now: NOW
    });

    // Pairing alone is not presence. The device becomes online only when its
    // bearer token actually authenticates a control connection.
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, NOW)).toBe(false);
    await authenticateCompanionToken(db, paired.token, NOW);
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, NOW)).toBe(true);

    // Readiness ages out once the device heartbeat goes stale.
    expect(
      await companionWorkspaceReady(
        db,
        WORKSPACE_ID,
        new Date(NOW.getTime() + COMPANION_DEVICE_ONLINE_MS + 1)
      )
    ).toBe(false);

    const status = await listCompanionStatus(db, WORKSPACE_ID, NOW);
    expect(status.devices).toEqual([
      expect.objectContaining({ id: paired.deviceId, online: true, label: 'Laptop' })
    ]);
  });

  it('marks a fresh catch-up opportunity on every connection, since this only ever runs once per connection', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Owner', timezone: 'UTC' }, NOW);
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const paired = await exchangeCompanionPairing(db, {
      code: pairing.code,
      label: 'Laptop',
      now: NOW
    });

    await authenticateCompanionToken(db, paired.token, NOW);
    let runs = await sideTaskRuns(db, WORKSPACE_ID, 'owner');
    expect(runs.get(AVAILABILITY_RETURN_MARKER)?.getTime()).toBe(NOW.getTime());

    // A second connection moments later -- e.g. the quick restart-into-visible
    // and restart-back-to-headless pair `trevra linkedin reconnect` performs,
    // typically well under the 90s online threshold -- still marks a fresh
    // catch-up. Ordinary keepalive pings never reach this function at all
    // (they touch `last_seen_at` directly in companion-relay.ts), so there is
    // no "just a heartbeat" case left to distinguish here: every call IS a new
    // connection, and a new connection is always worth a fresh look.
    const reconnect = new Date(NOW.getTime() + 30_000);
    await authenticateCompanionToken(db, paired.token, reconnect);
    runs = await sideTaskRuns(db, WORKSPACE_ID, 'owner');
    expect(runs.get(AVAILABILITY_RETURN_MARKER)?.getTime()).toBe(reconnect.getTime());
  });

  it('surfaces a human-required reconnect until a later healthy session clears it', async () => {
    await recordSeatEvent(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'owner',
        kind: 'reconnect_required',
        detail: 'LinkedIn needs a visible sign-in on the paired computer.'
      },
      NOW
    );
    const blocked = await listCompanionStatus(db, WORKSPACE_ID, NOW);
    expect(blocked.attention).toEqual([
      expect.objectContaining({
        seatKey: 'owner',
        kind: 'reconnect_required',
        message: 'LinkedIn needs a visible sign-in on the paired computer.'
      })
    ]);

    await recordSeatEvent(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'owner',
        kind: 'session_reused',
        detail: 'The stored session was still live.'
      },
      new Date(NOW.getTime() + 1000)
    );
    expect(
      (await listCompanionStatus(db, WORKSPACE_ID, new Date(NOW.getTime() + 1000))).attention
    ).toEqual([]);
  });

  it('revocation invalidates the device token and immediately removes readiness', async () => {
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const paired = await exchangeCompanionPairing(db, {
      code: pairing.code,
      label: 'Laptop',
      now: NOW
    });
    await authenticateCompanionToken(db, paired.token, NOW);
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, NOW)).toBe(true);

    expect(await revokeCompanionDevice(db, WORKSPACE_ID, paired.deviceId, NOW)).toBe(true);
    expect(await authenticateCompanionToken(db, paired.token, NOW)).toBeNull();
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, NOW)).toBe(false);
  });
});

describe('LinkedIn companion disconnect/reconnect notifications', () => {
  async function pairedDevice(label = 'Laptop') {
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    return exchangeCompanionPairing(db, { code: pairing.code, label, now: NOW });
  }

  async function setLastSeen(deviceId: string, at: Date): Promise<void> {
    await db
      .prepare('UPDATE linkedin_companion_devices SET last_seen_at=? WHERE id=?')
      .run(at.toISOString(), deviceId);
  }

  async function disconnectNotifiedAt(deviceId: string): Promise<string | null> {
    const row = await db
      .prepare('SELECT disconnect_notified_at FROM linkedin_companion_devices WHERE id=?')
      .get<{ disconnect_notified_at: string | null }>(deviceId);
    return row?.disconnect_notified_at ?? null;
  }

  it('sends no disconnect email before the grace period elapses', async () => {
    const paired = await pairedDevice();
    await setLastSeen(paired.deviceId, NOW);

    await notifyDisconnectedCompanionDevices(
      db,
      new Date(NOW.getTime() + COMPANION_DEVICE_DISCONNECT_GRACE_MS - 1)
    );
    expect(notificationMock.notifyCompanionDeviceDisconnected).not.toHaveBeenCalled();
    expect(await disconnectNotifiedAt(paired.deviceId)).toBeNull();
  });

  it('sends exactly one disconnect email once the device is stale past the grace period', async () => {
    const paired = await pairedDevice('Office desktop');
    await setLastSeen(paired.deviceId, NOW);

    const scanAt = new Date(NOW.getTime() + COMPANION_DEVICE_DISCONNECT_GRACE_MS + 1);
    await notifyDisconnectedCompanionDevices(db, scanAt);
    expect(notificationMock.notifyCompanionDeviceDisconnected).toHaveBeenCalledTimes(1);
    expect(notificationMock.notifyCompanionDeviceDisconnected).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        deviceLabel: 'Office desktop'
      })
    );
    expect(await disconnectNotifiedAt(paired.deviceId)).not.toBeNull();
  });

  it('does not send a duplicate disconnect email on a later scan before the device reconnects', async () => {
    const paired = await pairedDevice();
    await setLastSeen(paired.deviceId, NOW);

    const firstScan = new Date(NOW.getTime() + COMPANION_DEVICE_DISCONNECT_GRACE_MS + 1);
    await notifyDisconnectedCompanionDevices(db, firstScan);
    await notifyDisconnectedCompanionDevices(db, new Date(firstScan.getTime() + 60_000));
    expect(notificationMock.notifyCompanionDeviceDisconnected).toHaveBeenCalledTimes(1);
  });

  it('clears disconnect_notified_at and sends a reconnect email only after a real disconnect email went out', async () => {
    const paired = await pairedDevice();
    await setLastSeen(paired.deviceId, NOW);

    const scanAt = new Date(NOW.getTime() + COMPANION_DEVICE_DISCONNECT_GRACE_MS + 1);
    await notifyDisconnectedCompanionDevices(db, scanAt);
    expect(await disconnectNotifiedAt(paired.deviceId)).not.toBeNull();

    const returned = new Date(scanAt.getTime() + 60_000);
    await authenticateCompanionToken(db, paired.token, returned);
    expect(notificationMock.notifyCompanionDeviceReconnected).toHaveBeenCalledTimes(1);
    expect(notificationMock.notifyCompanionDeviceReconnected).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        deviceLabel: paired.label
      })
    );
    expect(await disconnectNotifiedAt(paired.deviceId)).toBeNull();
  });

  it('a sub-grace blip triggers neither a disconnect nor a reconnect email', async () => {
    const paired = await pairedDevice();
    await setLastSeen(paired.deviceId, NOW);

    // Scan mid-blip, still under the 10-minute grace period.
    await notifyDisconnectedCompanionDevices(db, new Date(NOW.getTime() + 3 * 60_000));
    expect(notificationMock.notifyCompanionDeviceDisconnected).not.toHaveBeenCalled();

    // The device heartbeats again before a disconnect email was ever sent.
    await authenticateCompanionToken(
      db,
      paired.token,
      new Date(NOW.getTime() + 3 * 60_000 + 1_000)
    );
    expect(notificationMock.notifyCompanionDeviceReconnected).not.toHaveBeenCalled();
    expect(await disconnectNotifiedAt(paired.deviceId)).toBeNull();
  });
});

describe('the companion browser provider', () => {
  it('is configured only with a relay URL and a sealing key', () => {
    expect(companionBrowserConfigured(ENV)).toBe(true);
    expect(companionBrowserConfigured({ TREVRA_COMPANION_RELAY_URL: 'ws://trevra:8080' })).toBe(
      false
    );
    expect(companionBrowserConfigured({ ...ENV, TREVRA_COMPANION_RELAY_URL: 'not-a-url' })).toBe(
      false
    );
  });

  it('uses the member computer without a proxy or server-side cookie persistence', () => {
    const settings = companionBrowserSettings(ENV);
    expect(settings?.kind).toBe('remote');
    expect(settings?.remote).toMatchObject({
      connect: 'cdp',
      requireProxy: false,
      sessionPersistence: 'browser',
      useExistingContext: true
    });
    expect(settings?.remote?.endpointTemplate).toContain(
      '/api/linkedin/companion/browser/{workspace}/{seat}'
    );
    expect(JSON.stringify(settings)).not.toContain(ENV.TREVRA_SECRETS_KEY);
  });
});
