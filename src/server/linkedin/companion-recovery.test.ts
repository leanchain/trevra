import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listCompanionStatus } from './companion.js';
import { loginLinkedInSeat } from './local-worker.js';
import { putLinkedInCredentials } from '../secrets/linkedin.js';
import type { LinkedInDriver, LinkedInPage } from './driver.js';

const WORKSPACE_ID = 'ws_companion_recovery_test';
const NOW = new Date('2026-08-17T07:30:00.000Z');
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
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
      first() {
        return this;
      },
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
    loginWithCredentials: vi.fn(async () => {
      throw new Error('must never be called when this workspace has no stored LinkedIn credential');
    })
  } as unknown as LinkedInDriver;
}

describe('hosted companion recovery', () => {
  it('turns a headless LinkedIn checkpoint into a durable reconnect alert when no credential is stored', async () => {
    const fakeDriver = driver('challenge');
    const result = await loginLinkedInSeat(
      db,
      { enabled: true, hosted: true, companionBrowser: true },
      {
        workspaceId: WORKSPACE_ID,
        page: page('https://www.linkedin.com/checkpoint/challenge/'),
        driver: fakeDriver,
        now: NOW
      }
    );

    expect(result.status).toBe('challenge');
    expect(result.message).toContain('trevra linkedin reconnect');
    expect(fakeDriver.loginWithCredentials).not.toHaveBeenCalled();
    expect((await listCompanionStatus(db, WORKSPACE_ID, NOW)).attention).toEqual([
      expect.objectContaining({ seatKey: 'owner', kind: 'challenge' })
    ]);
  });

  it('signs a companion seat in automatically when this workspace already has a stored credential', async () => {
    // A `now` of its own, well outside CHALLENGE_RETRY_COOLDOWN_MS (10 minutes)
    // from the previous test: `challengedSeats` is a module-level cache with no
    // test-only reset hook, so a shared timestamp would let that test's cached
    // refusal answer for this seat too.
    const at = new Date(NOW.getTime() + 24 * 60 * 60_000);
    await putLinkedInCredentials(db, {
      workspaceId: WORKSPACE_ID,
      email: 'owner@example.com',
      password: 'correct horse battery staple'
    });
    const fakeDriver: LinkedInDriver = {
      isLoggedIn: vi.fn(async () => false),
      sessionRecoveryReason: vi.fn(async () => {
        throw new Error('must never be called once an auto-login attempt was possible');
      }),
      loginWithCredentials: vi.fn(async () => ({ ok: true }))
    } as unknown as LinkedInDriver;

    const result = await loginLinkedInSeat(
      db,
      { enabled: true, hosted: true, companionBrowser: true },
      {
        workspaceId: WORKSPACE_ID,
        page: page('https://www.linkedin.com/login'),
        driver: fakeDriver,
        now: at
      }
    );

    expect(result.status).toBe('ok');
    expect(fakeDriver.loginWithCredentials).toHaveBeenCalledTimes(1);
    expect((await listCompanionStatus(db, WORKSPACE_ID, at)).attention).toEqual([]);
  });

  it('still falls back to a human when the stored credential itself needs an OTP', async () => {
    // Its own `now` too -- see the comment in the previous test.
    const at = new Date(NOW.getTime() + 48 * 60 * 60_000);
    await putLinkedInCredentials(db, {
      workspaceId: WORKSPACE_ID,
      email: 'owner@example.com',
      password: 'correct horse battery staple'
    });
    const fakeDriver: LinkedInDriver = {
      isLoggedIn: vi.fn(async () => false),
      sessionRecoveryReason: vi.fn(async () => 'challenge'),
      loginWithCredentials: vi.fn(async () => ({ needsOtp: true }))
    } as unknown as LinkedInDriver;

    const result = await loginLinkedInSeat(
      db,
      { enabled: true, hosted: true, companionBrowser: true },
      {
        workspaceId: WORKSPACE_ID,
        page: page('https://www.linkedin.com/checkpoint/challenge/'),
        driver: fakeDriver,
        now: at
      }
    );

    expect(result.status).toBe('challenge');
    expect(result.message).toContain('trevra linkedin reconnect');
    expect((await listCompanionStatus(db, WORKSPACE_ID, at)).attention).toEqual([
      expect.objectContaining({ seatKey: 'owner', kind: 'challenge' })
    ]);
  });
});
