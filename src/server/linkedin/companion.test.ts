import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  authenticateCompanionToken,
  companionBrowserConfigured,
  companionBrowserSettings,
  companionWorkspaceReady,
  createCompanionPairing,
  exchangeCompanionPairing,
  listCompanionStatus,
  markCompanionWebsitePresence,
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
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'Companion test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_companion_presence WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_companion_devices WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_companion_pairings WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db.close();
});

describe('LinkedIn companion pairing and presence', () => {
  it('stores neither the one-time pairing code nor the reusable device token in plaintext', async () => {
    const pairing = await createCompanionPairing(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_owner', now: NOW });
    const normalized = pairing.code.replaceAll('-', '');
    expect(normalized).toMatch(/^[A-F0-9]{12}$/);

    const pairingRow = await db.prepare('SELECT code_hash FROM linkedin_companion_pairings WHERE workspace_id=?').get<{ code_hash: string }>(WORKSPACE_ID);
    expect(pairingRow?.code_hash).toHaveLength(64);
    expect(pairingRow?.code_hash).not.toContain(normalized);

    const paired = await exchangeCompanionPairing(db, { code: pairing.code, label: 'Pankaj laptop', now: new Date(NOW.getTime() + 1000) });
    expect(paired.token).toMatch(/^trv_cmp_/);

    const deviceRow = await db.prepare('SELECT token_hash FROM linkedin_companion_devices WHERE id=?').get<{ token_hash: string }>(paired.deviceId);
    expect(deviceRow?.token_hash).toHaveLength(64);
    expect(deviceRow?.token_hash).not.toContain(paired.token);
    expect(await authenticateCompanionToken(db, paired.token, new Date(NOW.getTime() + 2000))).toMatchObject({
      workspaceId: WORKSPACE_ID,
      deviceId: paired.deviceId,
      label: 'Pankaj laptop'
    });
  });

  it('makes a pairing code one-time and short-lived', async () => {
    const pairing = await createCompanionPairing(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_owner', now: NOW });
    await exchangeCompanionPairing(db, { code: pairing.code, label: 'Laptop', now: new Date(NOW.getTime() + 1000) });
    await expect(exchangeCompanionPairing(db, { code: pairing.code, label: 'Replay', now: new Date(NOW.getTime() + 2000) }))
      .rejects.toThrow(/expired or was already used/i);

    const expired = await createCompanionPairing(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_owner', now: NOW });
    await expect(exchangeCompanionPairing(db, { code: expired.code, label: 'Late', now: new Date(NOW.getTime() + 11 * 60_000) }))
      .rejects.toThrow(/expired or was already used/i);
  });

  it('requires both the computer and an open Trevra website lease before work is eligible', async () => {
    const pairing = await createCompanionPairing(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_owner', now: NOW });
    const paired = await exchangeCompanionPairing(db, { code: pairing.code, label: 'Laptop', now: NOW });

    expect(await companionWorkspaceReady(db, WORKSPACE_ID, NOW)).toBe(false);
    await markCompanionWebsitePresence(db, WORKSPACE_ID, 'usr_owner', NOW);
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, NOW)).toBe(true);

    // Website leases age out even if the laptop is still considered recently online.
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, new Date(NOW.getTime() + 151_000))).toBe(false);

    const status = await listCompanionStatus(db, WORKSPACE_ID, NOW);
    expect(status.websitePresent).toBe(true);
    expect(status.devices).toEqual([expect.objectContaining({ id: paired.deviceId, online: true, label: 'Laptop' })]);
  });

  it('revocation invalidates the device token and immediately removes readiness', async () => {
    const pairing = await createCompanionPairing(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_owner', now: NOW });
    const paired = await exchangeCompanionPairing(db, { code: pairing.code, label: 'Laptop', now: NOW });
    await markCompanionWebsitePresence(db, WORKSPACE_ID, 'usr_owner', NOW);
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, NOW)).toBe(true);

    expect(await revokeCompanionDevice(db, WORKSPACE_ID, paired.deviceId, NOW)).toBe(true);
    expect(await authenticateCompanionToken(db, paired.token, NOW)).toBeNull();
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, NOW)).toBe(false);
  });
});

describe('the companion browser provider', () => {
  it('is configured only with a relay URL and a sealing key', () => {
    expect(companionBrowserConfigured(ENV)).toBe(true);
    expect(companionBrowserConfigured({ TREVRA_COMPANION_RELAY_URL: 'ws://trevra:8080' })).toBe(false);
    expect(companionBrowserConfigured({ ...ENV, TREVRA_COMPANION_RELAY_URL: 'not-a-url' })).toBe(false);
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
    expect(settings?.remote?.endpointTemplate).toContain('/api/linkedin/companion/browser/{workspace}/{seat}');
    expect(JSON.stringify(settings)).not.toContain(ENV.TREVRA_SECRETS_KEY);
  });
});
