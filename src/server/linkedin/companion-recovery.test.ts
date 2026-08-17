import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listCompanionStatus } from './companion.js';
import { loginLinkedInSeat } from './local-worker.js';
import type { LinkedInDriver, LinkedInPage } from './driver.js';

const WORKSPACE_ID = 'ws_companion_recovery_test';
const NOW = new Date('2026-08-17T07:30:00.000Z');
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'Companion recovery test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_seat_events WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db.close();
});

function page(url: string): LinkedInPage {
  return {
    goto: vi.fn(),
    url: () => url,
    locator: vi.fn(() => ({
      count: vi.fn(async () => 0),
      first() { return this; },
      click: vi.fn(),
      fill: vi.fn(),
      textContent: vi.fn(async () => null)
    })),
    waitForTimeout: vi.fn()
  } as unknown as LinkedInPage;
}

function driver(reason: 'challenge' | 'signed_out'): LinkedInDriver {
  return {
    isLoggedIn: vi.fn(async () => false),
    sessionRecoveryReason: vi.fn(async () => reason),
    loginWithCredentials: vi.fn(async () => { throw new Error('credentials must never be used for companion recovery'); })
  } as unknown as LinkedInDriver;
}

describe('hosted companion recovery', () => {
  it('turns a headless LinkedIn checkpoint into a durable reconnect alert without reading credentials', async () => {
    const fakeDriver = driver('challenge');
    const result = await loginLinkedInSeat(db, { enabled: true, hosted: true, companionBrowser: true }, {
      workspaceId: WORKSPACE_ID,
      page: page('https://www.linkedin.com/checkpoint/challenge/'),
      driver: fakeDriver,
      now: NOW
    });

    expect(result.status).toBe('challenge');
    expect(result.message).toContain('trevra linkedin reconnect');
    expect(fakeDriver.loginWithCredentials).not.toHaveBeenCalled();
    expect((await listCompanionStatus(db, WORKSPACE_ID, NOW)).attention).toEqual([
      expect.objectContaining({ seatKey: 'owner', kind: 'challenge' })
    ]);
  });
});
