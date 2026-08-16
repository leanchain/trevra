import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../db.js';
import {
  HOSTED_EXECUTION_ACK_REQUIRED,
  HOSTED_EXECUTION_REFUSAL,
  HOSTED_EXECUTION_STATEMENT_VERSION,
  describeHostedExecutionAck,
  hostedExecutionGate,
  hostedExecutionMode,
  hostedExecutionWorkspaceIds,
  hostedSeatFilter,
  recordHostedExecutionAck,
  revokeHostedExecutionAck
} from './hosted-execution.js';
import { claimSeatLease, isRemoteSessionHome, remoteSessionHome, seatSessionHome } from './local-worker.js';

/**
 * WHEN TREVRA'S OWN SERVERS MAY ACT ON SOMEBODY'S LINKEDIN ACCOUNT.
 *
 * Two independent things are proven here, and they fail in different
 * directions:
 *
 *   1. THE AUTHORISATION. Cloud execution -- Trevra's OWN servers driving a
 *      browser as the member -- needs a remote browser AND this workspace's
 *      recorded consent. Without a browser there is no cloud execution to
 *      refuse: custody and the client-side worker behave exactly as local.
 *      With a browser but without consent, it refuses with the one action
 *      that would fix it.
 *   2. NO DOUBLE CLAIM. A hosted runner and a local worker must never drive one
 *      LinkedIn account at the same time, and a seat whose session lives on one
 *      operator's laptop must not be picked up by a datacentre that would sign
 *      in from scratch. The mechanism is the existing seat lease and its host
 *      pin; what is new is that a REMOTE session is portable between hosted
 *      pods (its state is in the database, not on a disk) while everything
 *      involving a local disk stays pinned.
 */

const WORKSPACE_ID = 'ws_li_hosted_exec_test';
const OTHER_WORKSPACE_ID = 'ws_li_hosted_exec_other';
const NOW = new Date('2026-08-14T10:00:00.000Z');

/** A hosted deployment with a working remote browser, expressed as an environment. */
const HOSTED_WITH_BROWSER = {
  TREVRA_DEPLOYMENT_MODE: 'hosted',
  TREVRA_BROWSER_PROVIDER: 'remote',
  TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}',
  TREVRA_BROWSER_API_KEY: 'sk-test'
} as NodeJS.ProcessEnv;

/** A hosted deployment as they all were until now: nothing to drive. */
const HOSTED_NO_BROWSER = { TREVRA_DEPLOYMENT_MODE: 'hosted' } as NodeJS.ProcessEnv;

let db: Db;
let profileDir: string;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const id of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(id, 'Hosted execution test', NOW.toISOString());
    await db.prepare('DELETE FROM linkedin_hosted_execution_ack WHERE workspace_id=?').run(id);
    await db.prepare('DELETE FROM linkedin_seat_leases WHERE workspace_id=?').run(id);
  }
  // A profile directory with CONTENT in it: an empty one is not a session, and
  // `seatProfilePresent` is what tells them apart.
  profileDir = mkdtempSync(join(tmpdir(), 'trevra-profile-'));
  writeFileSync(join(profileDir, 'Cookies'), 'not really, but not empty');
});

afterEach(async () => {
  rmSync(profileDir, { recursive: true, force: true });
  await db.close();
});

describe('the hosted execution gate', () => {
  it('does not apply at all to a self-hosted deployment', async () => {
    // The property that keeps every existing install working on upgrade: no
    // acknowledgement, no provider, no change.
    expect(await hostedExecutionGate(db, WORKSPACE_ID, { TREVRA_DEPLOYMENT_MODE: 'local' })).toEqual({ allowed: true });
    expect(hostedSeatFilter(db, { TREVRA_DEPLOYMENT_MODE: 'local' })).toBeNull();
  });

  it('allows hosted with no remote browser -- there is no cloud browser to refuse on behalf of', async () => {
    // No acknowledgement recorded, and none needed: with no remote provider
    // configured, this is not cloud execution at all -- it is a workspace's own
    // client-side worker, on the same footing as a self-hosted install.
    expect(await hostedExecutionGate(db, WORKSPACE_ID, HOSTED_NO_BROWSER)).toEqual({ allowed: true });
    // The filter is not null (this deployment IS hosted), but it passes every
    // workspace through -- `linkedInWorkerConfig().enabled` is what actually
    // keeps a hosted deployment's own bundled worker from opening a browser it
    // has no display for; this filter answers a different question.
    const filter = hostedSeatFilter(db, HOSTED_NO_BROWSER);
    expect(filter).not.toBeNull();
    expect(await filter!({ workspaceId: WORKSPACE_ID })).toBe(true);
    expect(await filter!({ workspaceId: OTHER_WORKSPACE_ID })).toBe(true);
  });

  it('refuses a hosted workspace that has not acknowledged, and names the next action', async () => {
    const verdict = await hostedExecutionGate(db, WORKSPACE_ID, HOSTED_WITH_BROWSER);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe(HOSTED_EXECUTION_ACK_REQUIRED);
    expect(verdict.reason).toContain('/api/linkedin/hosted-execution');
  });

  it('allows a hosted workspace that has acknowledged, and only that workspace', async () => {
    await recordHostedExecutionAck(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_1', now: NOW });
    expect(await hostedExecutionGate(db, WORKSPACE_ID, HOSTED_WITH_BROWSER)).toEqual({ allowed: true });
    // The neighbour is unaffected. Consent is per tenant, not per deployment.
    expect((await hostedExecutionGate(db, OTHER_WORKSPACE_ID, HOSTED_WITH_BROWSER)).allowed).toBe(false);
  });

  it('stops on withdrawal, and keeps the record of it', async () => {
    await recordHostedExecutionAck(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_1', now: NOW });
    await revokeHostedExecutionAck(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_1', now: NOW });
    expect((await hostedExecutionGate(db, WORKSPACE_ID, HOSTED_WITH_BROWSER)).allowed).toBe(false);

    const ack = await describeHostedExecutionAck(db, WORKSPACE_ID);
    expect(ack.acknowledged).toBe(false);
    // "Never agreed" and "agreed and changed their mind" are different facts,
    // and only the first one is silence.
    expect(ack.revokedAt).not.toBeNull();
    expect(ack.acknowledgedBy).toBe('usr_1');

    // And it can be given again.
    await recordHostedExecutionAck(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_1', now: NOW });
    expect((await hostedExecutionGate(db, WORKSPACE_ID, HOSTED_WITH_BROWSER)).allowed).toBe(true);
  });

  it('lists only the workspaces a runner may serve', async () => {
    await recordHostedExecutionAck(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_1', now: NOW });
    await recordHostedExecutionAck(db, { workspaceId: OTHER_WORKSPACE_ID, actorUserId: 'usr_2', now: NOW });
    await revokeHostedExecutionAck(db, { workspaceId: OTHER_WORKSPACE_ID, actorUserId: 'usr_2', now: NOW });
    const ids = await hostedExecutionWorkspaceIds(db);
    expect(ids).toContain(WORKSPACE_ID);
    expect(ids).not.toContain(OTHER_WORKSPACE_ID);
  });

  it('reports a misconfigured provider as a problem rather than as "off"', () => {
    const mode = hostedExecutionMode({ TREVRA_DEPLOYMENT_MODE: 'hosted', TREVRA_BROWSER_PROVIDER: 'remote' });
    expect(mode.available).toBe(false);
    expect(mode.problem).toBeTruthy();
    expect(hostedExecutionMode(HOSTED_WITH_BROWSER).available).toBe(true);
    expect(hostedExecutionMode(HOSTED_WITH_BROWSER).provider).toBe('connect.example.com');
  });

  it('memoises per pass so a workspace is asked once, not once per seat', async () => {
    await recordHostedExecutionAck(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_1', now: NOW });
    const filter = hostedSeatFilter(db, HOSTED_WITH_BROWSER);
    expect(filter).not.toBeNull();
    expect(await filter!({ workspaceId: WORKSPACE_ID })).toBe(true);
    expect(await filter!({ workspaceId: WORKSPACE_ID })).toBe(true);
    expect(await filter!({ workspaceId: OTHER_WORKSPACE_ID })).toBe(false);
    expect(HOSTED_EXECUTION_STATEMENT_VERSION).toBeGreaterThan(0);
  });
});

describe('no double claim between a local worker and the hosted runner', () => {
  const seat = { workspaceId: WORKSPACE_ID, seatKey: 'sales' };
  const REMOTE_HOME = remoteSessionHome('connect.example.com');

  it('says where this process would keep the session, and can tell the two apart', () => {
    expect(seatSessionHome({ enabled: true }, WORKSPACE_ID, 'sales', HOSTED_WITH_BROWSER)).toBe(REMOTE_HOME);
    expect(isRemoteSessionHome(REMOTE_HOME)).toBe(true);
    const local = seatSessionHome({ enabled: true, profileDir: '/var/lib/trevra/li' }, WORKSPACE_ID, 'sales', { TREVRA_DEPLOYMENT_MODE: 'local' });
    expect(isRemoteSessionHome(local)).toBe(false);
    expect(local).toContain('/var/lib/trevra/li');
  });

  it('refuses the hosted runner a seat a local worker holds the profile for', async () => {
    const local = await claimSeatLease(db, { ...seat, workerId: 'laptop-1', host: 'laptop', profileDir }, NOW);
    expect(local.ok).toBe(true);

    // The hosted pod, on a different host, with no disk at all. It must not
    // take the seat: that account's device trust is on the laptop, and running
    // it from a datacentre would be a brand-new device sign-in.
    const hosted = await claimSeatLease(
      db,
      { ...seat, workerId: 'pod-a', host: 'pod-a', profileDir: REMOTE_HOME },
      // Well past the lease, so the refusal cannot be the ordinary "somebody
      // else is mid-batch" one -- it is the PIN.
      new Date(NOW.getTime() + 6 * 60 * 60_000)
    );
    expect(hosted.ok).toBe(false);
    if (hosted.ok) throw new Error('unreachable');
    expect(hosted.reason).toContain("pinned to host 'laptop'");
    expect(hosted.reason).toContain('brand-new device sign-in');
  });

  it('refuses a second hosted pod while the first pod\'s lease is live', async () => {
    const first = await claimSeatLease(db, { ...seat, workerId: 'pod-a', host: 'pod-a', profileDir: REMOTE_HOME }, NOW);
    expect(first.ok).toBe(true);

    const second = await claimSeatLease(
      db,
      { ...seat, workerId: 'pod-b', host: 'pod-b', profileDir: REMOTE_HOME },
      new Date(NOW.getTime() + 60_000)
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.reason).toContain("already being driven by worker 'pod-a'");
  });

  it('lets another hosted pod take the seat once the lease has expired, because the session travels', async () => {
    await claimSeatLease(db, { ...seat, workerId: 'pod-a', host: 'pod-a', profileDir: REMOTE_HOME }, NOW);
    // THE WHOLE POINT OF THE PORTABLE MARKER. With the profile-directory pin
    // applied to a remote session, this seat would have been stuck on pod-a
    // forever -- pinned to a host that keeps nothing, for a session that lives
    // in Postgres and is readable from every pod.
    const later = await claimSeatLease(
      db,
      { ...seat, workerId: 'pod-b', host: 'pod-b', profileDir: REMOTE_HOME },
      new Date(NOW.getTime() + 6 * 60 * 60_000)
    );
    expect(later.ok).toBe(true);
  });

  it('refuses a local worker with an empty profile a seat the hosted runner holds', async () => {
    await claimSeatLease(db, { ...seat, workerId: 'pod-a', host: 'pod-a', profileDir: REMOTE_HOME }, NOW);
    const empty = mkdtempSync(join(tmpdir(), 'trevra-empty-'));
    try {
      const local = await claimSeatLease(
        db,
        { ...seat, workerId: 'laptop-1', host: 'laptop', profileDir: empty },
        new Date(NOW.getTime() + 6 * 60 * 60_000)
      );
      // Portable is remote-to-remote only: a local worker starting from an
      // empty directory would sign in from scratch, which is exactly the
      // new-device event the pin exists to prevent.
      expect(local.ok).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('lets a local worker that HAS the profile take the seat back', async () => {
    await claimSeatLease(db, { ...seat, workerId: 'pod-a', host: 'pod-a', profileDir: REMOTE_HOME }, NOW);
    const local = await claimSeatLease(
      db,
      { ...seat, workerId: 'laptop-1', host: 'laptop', profileDir },
      new Date(NOW.getTime() + 6 * 60 * 60_000)
    );
    // An operator whose machine holds a real signed-in profile for this account
    // is a home for it, and always was.
    expect(local.ok).toBe(true);
  });
});
