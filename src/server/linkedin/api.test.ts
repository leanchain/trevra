import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { recordAction } from './actions.js';
import { upsertSeat } from './seats.js';
import { LinkedInApiError, writeActionStatus } from './campaigns.js';
import { canonicalPayloadHash } from '../control-plane/payload.js';

/**
 * The LinkedIn HTTP surface (docs/linkedin-outreach-plan.md section 5).
 *
 * Two workspaces throughout, with real sessions rather than one workspace and
 * a trusting assertion: `linkedin_actions.id` is a global identifier, so every
 * scoping bug in this layer looks like a working feature until somebody else's
 * target list arrives in the response.
 */

let db: Db;
let app: Express;

const WORKSPACE_A = 'ws_li_api_a';
const WORKSPACE_B = 'ws_li_api_b';
const NOW = new Date('2026-08-06T09:00:00.000Z');

let sessionA = '';
let sessionB = '';

/** A real row in `sessions`, hashed exactly as app.ts hashes the cookie it reads. */
async function seedSession(workspaceId: string, label: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(workspaceId, label, NOW.toISOString());
  await db.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(userId, workspaceId, `${userId}@trevra.test`, label, NOW.toISOString());
  const token = randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(
    createHash('sha256').update(token).digest('hex'),
    userId,
    new Date(Date.now() + 86_400_000).toISOString(),
    new Date().toISOString()
  );
  return token;
}

function as(token: string) {
  return {
    get: (path: string) => request(app).get(path).set('Cookie', `trevra_session=${token}`),
    post: (path: string) => request(app).post(path).set('Cookie', `trevra_session=${token}`),
    put: (path: string) => request(app).put(path).set('Cookie', `trevra_session=${token}`),
    patch: (path: string) => request(app).patch(path).set('Cookie', `trevra_session=${token}`),
    delete: (path: string) => request(app).delete(path).set('Cookie', `trevra_session=${token}`)
  };
}

/**
 * The seat, activated on `activatedOn`.
 *
 * The warm-up ramp is keyed to the seat's FIRST WRITE -- how long Trevra has
 * been automating it -- not to a date the operator declares, so an established
 * seat is expressed by writing it at an earlier instant. Absent means
 * "activated now", which is what a brand-new seat looks like.
 */
async function seat(workspaceId: string, activatedOn?: string): Promise<void> {
  const activatedAt = activatedOn ? new Date(`${activatedOn}T09:00:00.000Z`) : NOW;
  await upsertSeat(db, workspaceId, { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' }, activatedAt);
}

async function actionCount(workspaceId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
    .get<{ total: number }>(workspaceId);
  return row?.total ?? 0;
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    await db.prepare('DELETE FROM linkedin_exports WHERE workspace_id=?').run(workspaceId);
    // Children before parents: messages reference threads and leads reference
    // sources, and withdrawals reference the ledger rows deleted below.
    await db.prepare('DELETE FROM linkedin_messages WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_threads WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_leads WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_lead_sources WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_withdrawals WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_exclusions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_seat_detect_requests WHERE workspace_id=?').run(workspaceId);
    // Step runs and approvals cascade from here (migration 006), so "how many
    // runs did this request start" is answerable per test rather than per file.
    await db.prepare('DELETE FROM playbook_runs WHERE workspace_id=?').run(workspaceId);
  }
  sessionA = await seedSession(WORKSPACE_A, 'Workspace A');
  sessionB = await seedSession(WORKSPACE_B, 'Workspace B');
});

afterEach(async () => {
  await db?.close();
});

describe('workspace scoping', () => {
  it('never shows one workspace the other workspace\'s actions', async () => {
    await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/only-a', status: 'planned', source: 'export', plannedFor: NOW.toISOString() }, NOW);
    const theirs = await recordAction(db, { workspaceId: WORKSPACE_B, kind: 'invite', targetRef: 'in/only-b', status: 'planned', source: 'export', plannedFor: NOW.toISOString() }, NOW);

    const mine = (await as(sessionA).get('/api/linkedin/actions').expect(200)).body as { actions: Array<{ targetRef: string }> };
    expect(mine.actions.map((action) => action.targetRef)).toEqual(['in/only-a']);

    const yours = (await as(sessionB).get('/api/linkedin/actions').expect(200)).body as { actions: Array<{ targetRef: string }> };
    expect(yours.actions.map((action) => action.targetRef)).toEqual(['in/only-b']);

    // The id is real and resolvable -- just not by this session.
    await as(sessionA).post(`/api/linkedin/actions/${theirs.id}/skip`).send({}).expect(404);
    await as(sessionA).post('/api/linkedin/actions/outcome').send({ actionId: theirs.id, outcome: 'sent' }).expect(404);

    const untouched = await db.prepare('SELECT status FROM linkedin_actions WHERE id=?').get<{ status: string }>(theirs.id);
    expect(untouched?.status).toBe('planned');
  });
});

describe('the API never sends', () => {
  it('refuses a status smuggled into the skip route, and leaves the action planned', async () => {
    const action = await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/maya', status: 'planned', source: 'export' }, NOW);

    // `skip` takes no fields at all, so there is nothing here to name a status
    // with. The strict schema is the enforcement, not a convention.
    await as(sessionA).post(`/api/linkedin/actions/${action.id}/skip`).send({ status: 'sent' }).expect(400);
    await as(sessionA).post(`/api/linkedin/actions/${action.id}/skip`).send({ outcome: 'sent', status: 'accepted' }).expect(400);

    const row = await db.prepare('SELECT status, recorded_at FROM linkedin_actions WHERE id=?')
      .get<{ status: string; recorded_at: string | null }>(action.id);
    expect(row?.status).toBe('planned');
    expect(row?.recorded_at).toBeNull();
  });

  it('refuses a worker-only status at the choke point every route writes through', async () => {
    const action = await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/jonas', status: 'planned', source: 'export' }, NOW);

    for (const status of ['sent', 'accepted', 'replied'] as const) {
      const refusal = await writeActionStatus(db, { workspaceId: WORKSPACE_A, actionId: action.id, status, via: 'api' }, NOW)
        .then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(LinkedInApiError);
      expect((refusal as LinkedInApiError).status).toBe(409);
      expect((refusal as LinkedInApiError).message).toMatch(/never sends/);
    }

    const row = await db.prepare('SELECT status FROM linkedin_actions WHERE id=?').get<{ status: string }>(action.id);
    expect(row?.status).toBe('planned');
  });

  it('lets the one sanctioned route report an outcome, dated when it happened', async () => {
    const action = await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/sofia', status: 'exported', source: 'export' }, NOW);
    const occurredAt = '2026-08-04T14:00:00.000Z';

    const body = (await as(sessionA).post('/api/linkedin/actions/outcome')
      .send({ actionId: action.id, outcome: 'accepted', occurredAt })
      .expect(200)).body as { action: { status: string; recordedAt: string } };

    expect(body.action.status).toBe('accepted');
    // Every rolling window reads recorded_at, so an outcome reported today for
    // Tuesday's send must charge Tuesday.
    expect(new Date(body.action.recordedAt).toISOString()).toBe(occurredAt);
  });

  it('refuses an outcome against an action that was skipped and never went out', async () => {
    const action = await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/dropped', status: 'planned', source: 'export' }, NOW);
    await as(sessionA).post(`/api/linkedin/actions/${action.id}/skip`).send({}).expect(200);
    await as(sessionA).post('/api/linkedin/actions/outcome').send({ actionId: action.id, outcome: 'sent' }).expect(409);
  });

  it('refuses to skip work that already left the building', async () => {
    const action = await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/gone', status: 'exported', source: 'export' }, NOW);
    // Skipping releases the replay guard, which would free the target for a
    // second invite to somebody who has already had one.
    await as(sessionA).post(`/api/linkedin/actions/${action.id}/skip`).send({}).expect(409);
  });
});

describe('POST /api/linkedin/plan', () => {
  it('is a dry run: it answers with a schedule and persists nothing', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    expect(await actionCount(WORKSPACE_A)).toBe(0);

    const body = (await as(sessionA).post('/api/linkedin/plan')
      .send({ kind: 'invite', targets: ['in/one', 'in/two', 'in/three'], horizonDays: 14 })
      .expect(200)).body as {
        persisted: boolean;
        plan: { slots: Array<{ plannedFor: string; kind: string; targetRef: string }>; reasons: string[]; ceilingsApplied: string[] };
      };

    expect(body.persisted).toBe(false);
    expect(body.plan.slots.length).toBeGreaterThan(0);
    expect(body.plan.reasons.length).toBeGreaterThan(0);
    expect(Array.isArray(body.plan.ceilingsApplied)).toBe(true);
    expect(await actionCount(WORKSPACE_A)).toBe(0);
  });

  it('drops excluded targets before planning, never at send time', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await as(sessionA).post('/api/linkedin/exclusions')
      .send({ targets: [{ targetRef: 'in/ONE', reason: 'asked us to stop' }] })
      .expect(201);

    const body = (await as(sessionA).post('/api/linkedin/plan')
      .send({ kind: 'invite', targets: ['in/one', 'in/two'] })
      .expect(200)).body as { plan: { slots: Array<{ targetRef: string }> }; excluded: Array<{ targetRef: string; reason: string }> };

    expect(body.excluded).toEqual([{ targetRef: 'in/one', reason: 'asked us to stop' }]);
    expect(body.plan.slots.map((slot) => slot.targetRef)).not.toContain('in/one');

    const listed = (await as(sessionA).get('/api/linkedin/exclusions').expect(200)).body as { exclusions: Array<{ targetRef: string }> };
    expect(listed.exclusions.map((item) => item.targetRef)).toEqual(['in/ONE']);
  });
});

describe('GET /api/linkedin/limits', () => {
  it('reports every ceiling with the rule that bound it and its confidence tag', async () => {
    await seat(WORKSPACE_A);

    const body = (await as(sessionA).get('/api/linkedin/limits').expect(200)).body as {
      seat: { configured: boolean; posture: string; warmupWeek: number; band: string };
      limits: Array<{ kind: string; window: string; ceiling: number; bandCeiling: number; boundBy: string; rule: string; confidence: string; source: string }>;
      signals: { acceptance: { confidence: string; floor: number }; dayOverDay: { maxDelta: number; confidence: string } };
    };

    expect(body.seat.configured).toBe(true);
    expect(body.seat.posture).toBe('warmup');
    expect(body.limits.length).toBeGreaterThan(0);

    // Nothing is flattened to a bare number: every entry carries provenance.
    for (const limit of body.limits) {
      expect(limit.boundBy).toBeTruthy();
      expect(limit.rule.length).toBeGreaterThan(10);
      expect(['HARD FACT', 'REPORTED']).toContain(limit.confidence);
      expect(limit.source).toMatch(/linkedin-outreach-plan\.md/);
    }

    // Exactly one number in the whole table is published by LinkedIn.
    const inmailMonth = body.limits.find((limit) => limit.kind === 'inmail' && limit.window === 'month');
    expect(inmailMonth?.confidence).toBe('HARD FACT');
    expect(inmailMonth?.ceiling).toBe(50);
    expect(inmailMonth?.source).toMatch(/1\.1/);

    const inviteDay = body.limits.find((limit) => limit.kind === 'invite' && limit.window === 'day');
    expect(inviteDay?.confidence).toBe('REPORTED');
    expect(inviteDay?.boundBy).toBe('warmup-multiplier');
    expect(inviteDay?.ceiling).toBeLessThan(inviteDay?.bandCeiling ?? 0);

    expect(body.signals.acceptance.confidence).toBe('REPORTED');
    expect(body.signals.dayOverDay.confidence).toBe('REPORTED');
  });

  it('paces a workspace with no seat as a week-1 account rather than guessing', async () => {
    const body = (await as(sessionA).get('/api/linkedin/limits').expect(200)).body as {
      seat: { configured: boolean };
      limits: Array<{ ceiling: number; boundBy: string }>;
    };
    expect(body.seat.configured).toBe(false);
    const daily = body.limits.filter((limit) => limit.boundBy === 'seat-unconfigured');
    expect(daily.length).toBeGreaterThan(0);
    for (const limit of daily) expect(limit.ceiling).toBe(0);
  });
});

describe('POST /api/linkedin/targets/import', () => {
  it('reads quoted commas without shifting a column, and persists nothing', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const csv = [
      'profileUrl,firstName,lastName,company,role',
      'https://www.linkedin.com/in/maya,Maya,Chen,"Acme, Inc.",Head of Platform',
      'https://www.linkedin.com/in/jonas,Jonas,"Keller, Jr.","The ""Good"" Company",CTO'
    ].join('\n');

    const body = (await as(sessionA).post('/api/linkedin/targets/import')
      .attach('file', Buffer.from(csv, 'utf8'), 'targets.csv')
      .expect(200)).body as {
        persisted: boolean;
        parsed: number;
        contacts: Array<{ targetRef: string; firstName: string; lastName: string; company: string; role: string }>;
      };

    expect(body.persisted).toBe(false);
    expect(body.parsed).toBe(2);
    expect(body.contacts[0].company).toBe('Acme, Inc.');
    expect(body.contacts[0].role).toBe('Head of Platform');
    expect(body.contacts[1].lastName).toBe('Keller, Jr.');
    expect(body.contacts[1].company).toBe('The "Good" Company');
    expect(await actionCount(WORKSPACE_A)).toBe(0);
  });

  it('reports rows it could not use rather than silently dropping them', async () => {
    const csv = ['handle,company', 'in/maya,Acme', ',Orphan Row'].join('\n');
    const body = (await as(sessionA).post('/api/linkedin/targets/import')
      .attach('file', Buffer.from(csv, 'utf8'), 'targets.csv')
      .expect(200)).body as { parsed: number; skippedRows: Array<{ row: number; reason: string }> };
    expect(body.parsed).toBe(1);
    expect(body.skippedRows).toHaveLength(1);
    expect(body.skippedRows[0].row).toBe(3);
  });
});

interface WorkerStatusBody {
  enabled: boolean;
  playwrightInstalled: boolean;
  playwrightPath: string | null;
  loggedIn: boolean;
  browser: { canLaunchHeaded: boolean; canLaunchHeadless: boolean; reasons: string[]; headlessReasons: string[] };
  ready: boolean;
  blockers: string[];
}

function workerStatus(): Promise<WorkerStatusBody> {
  return as(sessionA).get('/api/linkedin/worker/status').expect(200).then((response) => response.body as WorkerStatusBody);
}

describe('GET /api/linkedin/worker/status', () => {
  it('answers without launching anything, and never says "ready" where nothing can launch', async () => {
    const body = await workerStatus();

    // On by default now: the only deployment that can run this is a self-hoster
    // on their own machine, so an opt-in flag protected nobody.
    expect(body.enabled).toBe(true);
    expect(typeof body.playwrightInstalled).toBe('boolean');
    // No session confirmed yet, and never unknown: every seat signs itself in.
    expect(body.loggedIn).toBe(false);
    expect(typeof body.loggedIn).toBe('boolean');

    // The setup file points Playwright's registry at a directory that does not
    // exist, so this is the container case: nothing here can draw a window.
    expect(body.browser.canLaunchHeaded).toBe(false);
    expect(body.browser.reasons.length).toBeGreaterThan(0);
    expect(body.ready).toBe(false);
  });

  it('gives ONE next action per problem, and never names an environment variable', async () => {
    const body = await workerStatus();

    expect(body.blockers.length).toBeGreaterThan(0);
    // The flag defaults correctly now, so naming it is noise an operator has to
    // read past to find the thing they actually have to do.
    expect(body.blockers.join(' ')).not.toMatch(/TREVRA_LINKEDIN_LOCAL/);
    for (const blocker of body.blockers) {
      // One imperative sentence, plus at most the command to run.
      expect(blocker.length).toBeLessThanOrEqual(120);
      expect(blocker.split('. ').length).toBeLessThanOrEqual(1);
    }
  });

  /**
   * Every seat opens its own headless session. The display a headed window
   * would need is not this path's requirement, and reporting it here is what
   * told an operator whose container was working perfectly that something was
   * broken.
   */
  it('judges the seat on headless alone, and never on a display', async () => {
    await seat(WORKSPACE_A);
    await upsertSeat(db, WORKSPACE_A, { sessionValidAt: NOW.toISOString() }, NOW);

    const body = await workerStatus();
    expect(body.browser.canLaunchHeaded).toBe(false);
    // Not unknown: a confirmed session is knowledge already written down.
    expect(body.loggedIn).toBe(true);

    const said = body.blockers.join(' ');
    expect(said).not.toMatch(/linkedin:login/);
    expect(said).not.toMatch(/display/i);
    expect(said).not.toMatch(/container/i);
    expect(said).not.toMatch(/browser window/);

    // Fails closed all the same: nothing launchable here is still not ready,
    // and what is left to say is one line about the browser binary.
    expect(body.browser.canLaunchHeadless).toBe(false);
    expect(body.ready).toBe(false);
    expect(body.blockers).toHaveLength(1);
    expect(body.blockers[0]).toMatch(/chromium/i);
  });

  it('reports the same headless-alone verdict for a seat that has no session yet', async () => {
    await seat(WORKSPACE_A);

    const body = await workerStatus();
    expect(body.loggedIn).toBe(false);
    expect(body.ready).toBe(false);
    expect(body.blockers.join(' ')).not.toMatch(/linkedin:login/);
  });

  it('says hosted is hosted, rather than sending the operator looking for a switch', async () => {
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    try {
      const body = await workerStatus();
      expect(body.enabled).toBe(false);
      expect(body.ready).toBe(false);
      expect(body.blockers).toEqual(['This deployment is hosted, so LinkedIn automation is off and cannot be enabled.']);
      expect(body.browser.canLaunchHeaded).toBe(false);
      expect(body.browser.canLaunchHeadless).toBe(false);
    } finally {
      delete process.env.TREVRA_DEPLOYMENT_MODE;
    }
  });
});

/* ---------------------------------------------------------------------------
 * Campaigns and exports.
 *
 * The approved run is seeded directly rather than driven through
 * `gtm.linkedin-outreach`, because what these tests are about is the export
 * layer -- the bytes, the ledger, and the download -- and routing them through
 * a guard whose verdict depends on the day of the week would make them assert
 * the calendar instead.
 * ------------------------------------------------------------------------ */

const APPROVED_PAYLOAD = {
  format: 'dripify',
  campaignId: null as string | null,
  plan: {
    seatKey: 'owner',
    slots: [
      { plannedFor: '2026-08-10T09:00:00.000Z', kind: 'invite', targetRef: 'https://www.linkedin.com/in/maya' },
      { plannedFor: '2026-08-10T13:30:00.000Z', kind: 'invite', targetRef: 'https://www.linkedin.com/in/jonas' }
    ],
    reasons: ['Seeded for the API test.'],
    ceilingsApplied: ['warmup-multiplier']
  },
  sequence: {
    steps: [
      {
        id: 'invite',
        day: 0,
        kind: 'invite',
        intent: 'Open the conversation.',
        template: 'Hi {{firstName}}, saw {{company}} is hiring platform engineers.',
        variables: ['firstName', 'company'],
        critique: null
      }
    ],
    antiSlopNotes: [],
    antiSlopPassed: true
  },
  contacts: [
    { targetRef: 'https://www.linkedin.com/in/maya', firstName: 'Maya', lastName: 'Chen', company: 'Acme, Inc.', role: 'Head of Platform' }
  ]
};

/**
 * `overrides` exists for the queue tests and nothing else.
 *
 * `APPROVED_PAYLOAD` deliberately carries a contact for only one of its two
 * targets, because an export writes an empty name column for the other and that
 * is a case worth exporting. A QUEUED campaign refuses that list outright --
 * the worker would otherwise type `{{firstName}}` at a stranger -- so the
 * success path needs a payload whose contacts cover every slot.
 */
async function seedApprovedCampaign(
  workspaceId: string,
  name: string,
  overrides: Partial<typeof APPROVED_PAYLOAD> = {}
): Promise<string> {
  await seat(workspaceId, '2026-01-01');
  const campaignId = `lcmp_${workspaceId}`;
  const runId = `pbr_${workspaceId}`;
  const payload = { ...APPROVED_PAYLOAD, ...overrides, campaignId };
  const iso = NOW.toISOString();

  /**
   * APPROVED MEANS DECIDED, not "a payload exists".
   *
   * This fixture used to seed the step at `waiting_approval` with no
   * `playbook_approvals` row -- the exact state a founder has been ASKED about
   * and has not answered -- and then assert that exporting and queueing it
   * succeeded. That was the bug, not the test: `placeStepBehindApproval` writes
   * `input_json` at the moment it stops for a human, so a pending step and a
   * REJECTED step both carry a full payload. `approvedCampaignPayload` now
   * requires what `runActionStep` has always required -- the step COMPLETED,
   * and an `approve` row for this exact payload hash -- so the fixture seeds a
   * campaign somebody actually approved.
   */
  const stepRunId = `pbs_${workspaceId}`;
  const payloadHash = canonicalPayloadHash(payload);

  await db.prepare('DELETE FROM playbook_runs WHERE id=?').run(runId);
  await db.prepare(`
    INSERT INTO playbook_runs (
      id,workspace_id,playbook_key,playbook_version,status,actor_type,actor_id,
      input_json,correlation_id,created_at,started_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?::jsonb,?,?,?,?)
  `).run(runId, workspaceId, 'gtm.linkedin-outreach', '1.0.0', 'running', 'user', `usr_${workspaceId}`,
    JSON.stringify({ targets: payload.plan.slots.map((slot) => slot.targetRef) }), `corr_${workspaceId}`, iso, iso, iso);
  await db.prepare(`
    INSERT INTO playbook_step_runs (
      id,playbook_run_id,step_id,step_type,status,attempt,input_json,approval_payload_hash,available_at,updated_at
    ) VALUES (?,?,?,?,?,?,?::jsonb,?,?,?)
  `).run(stepRunId, runId, 'approve-campaign', 'approval', 'completed', 1, JSON.stringify(payload), payloadHash, iso, iso);
  await db.prepare(`
    INSERT INTO playbook_approvals (
      id,workspace_id,playbook_run_id,step_run_id,user_id,decision,payload_hash,comment,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(`pba_${workspaceId}`, workspaceId, runId, stepRunId, `usr_${workspaceId}`, 'approve', payloadHash, null, iso);

  await db.prepare(`
    INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,playbook_run_id,seat_key,created_at,updated_at)
    VALUES (?,?,?,?,?::jsonb,?,'owner',?,?)
  `).run(campaignId, workspaceId, name, 'running', JSON.stringify(payload.sequence), runId, iso, iso);

  return campaignId;
}

describe('campaign exports', () => {
  it('renders once, stores the bytes, and serves them back byte-identically', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');

    const created = (await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/export`)
      .send({ format: 'dripify' })
      .expect(201)).body as { export: { id: string; filename: string; contentType: string }; rendered: boolean; downloadPath: string };

    expect(created.rendered).toBe(true);
    expect(created.export.contentType).toBe('text/csv');

    const stored = await db.prepare('SELECT bytes FROM linkedin_exports WHERE id=?').get<{ bytes: string }>(created.export.id);
    const download = await as(sessionA).get(created.downloadPath).expect(200);

    expect(download.headers['content-type']).toMatch(/^text\/csv/);
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${created.export.filename}"`);
    expect(download.text).toBe(stored?.bytes);
    // The quoted-comma rule holds on the way out too: Acme, Inc. must not shift
    // every column right of it.
    expect(download.text).toContain('"Acme, Inc."');
  });

  it('does not write another ledger row on a re-export or on any download', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');

    const first = (await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/export`).send({ format: 'dripify' }).expect(201))
      .body as { export: { id: string }; downloadPath: string };
    const afterFirst = await actionCount(WORKSPACE_A);
    expect(afterFirst).toBe(APPROVED_PAYLOAD.plan.slots.length);

    await as(sessionA).get(first.downloadPath).expect(200);
    await as(sessionA).get(first.downloadPath).expect(200);
    expect(await actionCount(WORKSPACE_A)).toBe(afterFirst);

    // The same approved bytes: hand back the same file rather than re-render,
    // because rendering writes the ledger the pacing engine reasons from.
    const again = (await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/export`).send({ format: 'dripify' }).expect(200))
      .body as { export: { id: string }; rendered: boolean };
    expect(again.rendered).toBe(false);
    expect(again.export.id).toBe(first.export.id);
    expect(await actionCount(WORKSPACE_A)).toBe(afterFirst);
  });

  it('serves each format under the content type its renderer declared', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    const expected: Record<string, RegExp> = {
      dripify: /^text\/csv/,
      expandi: /^text\/csv/,
      heyreach: /^application\/json/,
      generic: /^text\/plain/
    };

    for (const [format, contentType] of Object.entries(expected)) {
      const created = (await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/export`).send({ format }).expect(201))
        .body as { downloadPath: string };
      const download = await as(sessionA).get(created.downloadPath).expect(200);
      expect(download.headers['content-type']).toMatch(contentType);
    }
  });

  it('will not serve one workspace\'s export to another', async () => {
    const mine = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    const created = (await as(sessionA).post(`/api/linkedin/campaigns/${mine}/export`).send({ format: 'dripify' }).expect(201))
      .body as { downloadPath: string };

    await as(sessionB).get(created.downloadPath).expect(404);
    await as(sessionB).get(`/api/linkedin/campaigns/${mine}`).expect(404);
    await as(sessionB).get(`/api/linkedin/campaigns/${mine}/exports`).expect(404);
  });

  it('refuses to export a campaign nobody has approved', async () => {
    const iso = NOW.toISOString();
    await db.prepare(`
      INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,created_at,updated_at)
      VALUES (?,?,?,?,?::jsonb,'owner',?,?)
    `).run('lcmp_unapproved', WORKSPACE_A, 'Unapproved', 'draft', '{}', iso, iso);
    await as(sessionA).post('/api/linkedin/campaigns/lcmp_unapproved/export').send({ format: 'dripify' }).expect(409);
  });
});

/* ---------------------------------------------------------------------------
 * Queueing an approved campaign for THIS deployment's local worker
 * (docs/core-product.md section 8, L1).
 *
 * The sibling of the export route above, reached from the same approval and
 * refusing the same things. What it writes is 'planned' rows; it sends nothing,
 * and the safety gate it does NOT run here is run per action by the worker,
 * immediately before it acts.
 * ------------------------------------------------------------------------ */

/** Both slots named, so the approved copy can actually be filled. */
const FULL_CONTACTS = [
  ...APPROVED_PAYLOAD.contacts,
  { targetRef: 'https://www.linkedin.com/in/jonas', firstName: 'Jonas', lastName: 'Weber', company: 'Northwind', role: 'CTO' }
];

describe('campaign queue', () => {
  it('queues the approved copy with real names in it, and sends nothing', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads', { contacts: FULL_CONTACTS });

    const queued = (await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/queue`).send({}).expect(201))
      .body as { campaignId: string; seatKey: string; recorded: { attempted: number; written: number; duplicate: number } };

    expect(queued.recorded).toEqual({ attempted: 2, written: 2, duplicate: 0 });

    const rows = await db.prepare(
      'SELECT status, source, body FROM linkedin_actions WHERE workspace_id=? ORDER BY planned_for'
    ).all<{ status: string; source: string; body: string | null }>(WORKSPACE_A);
    expect(rows.map((row) => row.status)).toEqual(['planned', 'planned']);
    expect(rows.map((row) => row.source)).toEqual(['campaign', 'campaign']);
    expect(rows[0].body).toBe('Hi Maya, saw Acme, Inc. is hiring platform engineers.');
    for (const row of rows) expect(row.body ?? '').not.toContain('{{');
  });

  it('is idempotent, because the replay guard is what makes a retry safe', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads', { contacts: FULL_CONTACTS });
    await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/queue`).send({}).expect(201);
    const again = (await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/queue`).send({}).expect(201))
      .body as { recorded: { written: number; duplicate: number } };

    expect(again.recorded).toEqual({ attempted: 2, written: 0, duplicate: 2 });
    expect(await actionCount(WORKSPACE_A)).toBe(2);
  });

  it('refuses when the approved contact list cannot fill the approved copy', async () => {
    // The default payload names only one of its two targets.
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    const refused = await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/queue`).send({}).expect(400);
    expect(String(refused.body.error)).toContain('https://www.linkedin.com/in/jonas');
    expect(await actionCount(WORKSPACE_A)).toBe(0);
  });

  it('refuses to queue a campaign nobody has approved, and one that belongs to somebody else', async () => {
    const iso = NOW.toISOString();
    await db.prepare(`
      INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,created_at,updated_at)
      VALUES (?,?,?,?,?::jsonb,'owner',?,?)
    `).run('lcmp_unapproved_q', WORKSPACE_A, 'Unapproved', 'draft', '{}', iso, iso);
    await as(sessionA).post('/api/linkedin/campaigns/lcmp_unapproved_q/queue').send({}).expect(409);

    const mine = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads', { contacts: FULL_CONTACTS });
    await as(sessionB).post(`/api/linkedin/campaigns/${mine}/queue`).send({}).expect(404);
  });

  it('refuses on a hosted deployment, where the export path is the one that exists', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads', { contacts: FULL_CONTACTS });
    const previous = process.env.TREVRA_DEPLOYMENT_MODE;
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    try {
      const refused = await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/queue`).send({}).expect(409);
      expect(String(refused.body.error)).toContain('hosted deployment');
      expect(await actionCount(WORKSPACE_A)).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.TREVRA_DEPLOYMENT_MODE;
      else process.env.TREVRA_DEPLOYMENT_MODE = previous;
    }
  });
});

/* ---------------------------------------------------------------------------
 * Sequences as data: the template library, the editor, and the one rule that
 * makes an editable sequence safe -- an edit is a different payload, so it
 * cannot ride the approval the old copy earned.
 * ------------------------------------------------------------------------ */

const EDITED_STEPS = [
  {
    id: 'invite',
    day: 0,
    kind: 'invite',
    intent: 'Rewritten by hand after the plan was approved.',
    template: 'Hi {{firstName}}, rewritten by hand for {{company}}.'
  }
];

/** The full playbook input, so an edit has something to re-plan from (029). */
async function seedCampaignBrief(workspaceId: string, campaignId: string): Promise<void> {
  await db.prepare('UPDATE linkedin_campaigns SET brief_json=?::jsonb WHERE id=? AND workspace_id=?').run(
    JSON.stringify({
      targets: APPROVED_PAYLOAD.plan.slots.map((slot) => slot.targetRef),
      icp: { role: 'Head of Platform', segment: 'Series A B2B SaaS', pain: 'routing breaks on every territory change' },
      offer: {
        name: 'Trevra',
        summary: 'a go-to-market runtime that keeps routing rules in one reviewable file',
        mechanism: 'routing lives in version control, so a territory change is a diff',
        proof: [],
        url: 'https://trevra.dev'
      },
      kind: 'invite',
      horizonDays: 14,
      format: 'dripify'
    }),
    campaignId,
    workspaceId
  );
}

describe('sequence templates', () => {
  it('lists ready sequences with the merge-field vocabulary the editor has to enforce', async () => {
    const body = (await as(sessionA).get('/api/linkedin/sequence-templates').expect(200)).body as {
      templates: Array<{ id: string; name: string; description: string; steps: Array<{ id: string; day: number; kind: string; template: string }> }>;
      defaultTemplateId: string;
      mergeFields: string[];
      inviteNoteMaxChars: number;
      maxSteps: number;
    };

    expect(body.templates.length).toBeGreaterThanOrEqual(3);
    expect(body.templates.map((template) => template.id)).toContain(body.defaultTemplateId);

    // Step ids are unique ON READ, so a client can bind an editor row to one
    // without re-identifying anything. A repeated id would be a library entry
    // `validateSequenceSteps` refuses -- published and unusable.
    for (const template of body.templates) {
      const ids = template.steps.map((step) => step.id);
      expect(ids.filter((value) => value.trim().length === 0)).toEqual([]);
      expect(new Set(ids).size).toBe(ids.length);
    }

    expect(body.mergeFields).toEqual(['firstName', 'lastName', 'company', 'jobTitle']);
    expect(body.inviteNoteMaxChars).toBe(300);
    expect(body.maxSteps).toBeGreaterThan(0);

    // Every template arrives as steps a client can drop straight into an editor.
    for (const template of body.templates) {
      expect(template.steps.length).toBeGreaterThan(0);
      const days = template.steps.map((step) => step.day);
      expect([...days].sort((left, right) => left - right)).toEqual(days);
    }
  });

  it('needs a session, like every other route here', async () => {
    await request(app).get('/api/linkedin/sequence-templates').expect(401);
  });
});

describe('drafting a campaign from a domain', () => {
  it('refuses a template id that does not exist, before it touches the network', async () => {
    const refused = await as(sessionA).post('/api/linkedin/campaigns/draft')
      .send({ domain: 'acme.test', templateId: 'no-such-template' })
      .expect(404);
    expect((refused.body as { error: string }).error).toContain('no-such-template');
  });

  it('answers a domain it cannot read as an operator error, never as a fault', async () => {
    const refused = await as(sessionA).post('/api/linkedin/campaigns/draft')
      .send({ domain: 'not-a-real-host.invalid' })
      .expect(400);
    expect((refused.body as { error: string }).error).toContain('not-a-real-host.invalid');
  });
});

describe('editing a sequence', () => {
  it('names the offending step when the edit breaks a rule, and stores nothing', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    await seedCampaignBrief(WORKSPACE_A, campaignId);

    const refused = await as(sessionA).patch(`/api/linkedin/campaigns/${campaignId}/sequence`)
      .send({ steps: [{ id: 'open', day: 0, kind: 'dm', template: 'Hi {{fistName}}.' }] })
      .expect(400);
    expect((refused.body as { error: string }).error).toContain("'open'");
    expect((refused.body as { error: string }).error).toContain('{{fistName}}');

    const stored = await db.prepare('SELECT sequence_json,playbook_run_id FROM linkedin_campaigns WHERE id=?')
      .get<{ sequence_json: { steps: Array<{ template: string }> }; playbook_run_id: string }>(campaignId);
    expect(stored?.sequence_json.steps[0].template).toContain('hiring platform engineers');
    expect(stored?.playbook_run_id).toBe(`pbr_${WORKSPACE_A}`);
  });

  it('re-plans behind a new run, so the approval the old copy earned is retired', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    await seedCampaignBrief(WORKSPACE_A, campaignId);

    const patched = (await as(sessionA).patch(`/api/linkedin/campaigns/${campaignId}/sequence`)
      .send({ steps: EDITED_STEPS })
      .expect(200)).body as {
      campaign: { playbookRunId: string };
      sequence: { steps: Array<{ id: string; template: string; variables: string[] }> };
      run: { id: string };
      previousRunId: string | null;
      approvalInvalidated: boolean;
    };

    expect(patched.sequence.steps.map((step) => step.id)).toEqual(['invite']);
    expect(patched.sequence.steps[0].template).toContain('rewritten by hand');
    expect(patched.sequence.steps[0].variables).toEqual(['firstName', 'company']);

    // The old approval is unreachable: the campaign points somewhere else now.
    expect(patched.previousRunId).toBe(`pbr_${WORKSPACE_A}`);
    expect(patched.approvalInvalidated).toBe(true);
    expect(patched.run.id).not.toBe(`pbr_${WORKSPACE_A}`);
    expect(patched.campaign.playbookRunId).toBe(patched.run.id);
  });

  /**
   * THE TEST THIS WHOLE FEATURE TURNS ON.
   *
   * An approval binds a payload hash. Editing the copy makes a different
   * payload, so the approved bytes stop describing the campaign -- and an
   * export renders the APPROVED payload, which means without this check an
   * operator could approve mild copy, rewrite it, and export the rewrite under
   * the signature the mild version earned.
   *
   * Written against the stored state rather than by driving a second playbook
   * run, so it asserts the rule and not the day of the week the guard happens
   * to see.
   */
  it('will not export copy that was edited after the plan behind it was approved', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');

    await db.prepare('UPDATE linkedin_campaigns SET sequence_json=?::jsonb WHERE id=?').run(
      JSON.stringify({
        steps: EDITED_STEPS.map((step) => ({ ...step, variables: ['firstName', 'company'], critique: null })),
        antiSlopNotes: [],
        antiSlopPassed: true
      }),
      campaignId
    );

    const refused = await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/export`).send({ format: 'dripify' }).expect(409);
    expect((refused.body as { error: string }).error).toMatch(/edited after/);

    // Refused before the ledger, not after: an export writes `linkedin_actions`.
    expect(await actionCount(WORKSPACE_A)).toBe(0);
    const files = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_exports WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_A);
    expect(files?.total).toBe(0);
  });

  it('still exports a campaign whose stored copy matches what was approved', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/export`).send({ format: 'dripify' }).expect(201);
  });

  it('refuses to rewrite the copy of a campaign that has already gone out', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    await seedCampaignBrief(WORKSPACE_A, campaignId);
    await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/export`).send({ format: 'dripify' }).expect(201);
    expect(await actionCount(WORKSPACE_A)).toBeGreaterThan(0);

    const refused = await as(sessionA).patch(`/api/linkedin/campaigns/${campaignId}/sequence`)
      .send({ steps: EDITED_STEPS })
      .expect(409);
    expect((refused.body as { error: string }).error).toMatch(/already been exported or sent/);

    const stored = await db.prepare('SELECT sequence_json FROM linkedin_campaigns WHERE id=?')
      .get<{ sequence_json: { steps: Array<{ template: string }> } }>(campaignId);
    expect(stored?.sequence_json.steps[0].template).toContain('hiring platform engineers');
  });

  it('will not let one workspace edit another workspace\'s campaign', async () => {
    const mine = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    await seedCampaignBrief(WORKSPACE_A, mine);
    await as(sessionB).patch(`/api/linkedin/campaigns/${mine}/sequence`).send({ steps: EDITED_STEPS }).expect(404);
  });
});

/* ---------------------------------------------------------------------------
 * Starting a campaign from copy that already exists.
 *
 * The template path -- pick a shape, edit the lines, launch -- has no ICP
 * brief behind it and never needed one. What it needs is for ONE request to
 * produce ONE run and ONE approval, because the alternative it replaced (post
 * a brief, let the server draft a sequence, immediately PATCH over it) spent a
 * second playbook run and a second approval retiring a sequence nobody asked
 * for.
 * ------------------------------------------------------------------------ */

const ASSEMBLED_STEPS = [
  {
    id: 'view',
    day: 0,
    kind: 'profile_view',
    intent: 'Show up in their viewer list before the invite lands. No copy.',
    // A profile view carries no message, and '' is how the client says so.
    template: ''
  },
  {
    id: 'invite',
    day: 1,
    kind: 'invite',
    intent: 'Connect, naming the problem rather than the sender.',
    template: '{{firstName}} -- territory changes at {{company}} rewrite the routing rules by hand every quarter.'
  },
  {
    id: 'open',
    day: 4,
    kind: 'dm',
    intent: 'One message, one mechanism.',
    template: 'Thanks for connecting, {{firstName}}. Routing lives in version control, so a territory change is a diff.'
  }
];

describe('creating a campaign from an assembled sequence', () => {
  it('runs the plan once, stops at one approval, and stores exactly the copy that was posted', async () => {
    await seat(WORKSPACE_A, '2026-01-01');

    const created = (await as(sessionA).post('/api/linkedin/campaigns').send({
      name: 'Template only',
      input: {
        targets: ['in/asha', 'in/ben'],
        sequenceSteps: ASSEMBLED_STEPS,
        kind: 'invite',
        horizonDays: 14,
        format: 'dripify'
      }
    }).expect(201)).body as {
      campaign: { id: string; playbookRunId: string };
      run: { id: string; status: string };
    };

    // ONE RUN. Two would mean the create path still drafts something first.
    const runs = await db.prepare('SELECT id FROM playbook_runs WHERE workspace_id=?').all<{ id: string }>(WORKSPACE_A);
    expect(runs.map((row) => row.id)).toEqual([created.run.id]);
    expect(created.campaign.playbookRunId).toBe(created.run.id);

    // ONE PENDING APPROVAL, and it is the campaign approval -- the sequence
    // still went through planPacing and the guard at requireAllowed: true.
    expect(created.run.status).toBe('waiting_approval');
    const waiting = await db.prepare("SELECT step_id FROM playbook_step_runs WHERE status='waiting_approval'")
      .all<{ step_id: string }>();
    expect(waiting.map((row) => row.step_id)).toEqual(['approve-campaign']);

    const paced = await db.prepare("SELECT status FROM playbook_step_runs WHERE playbook_run_id=? AND step_id IN ('pace','guard')")
      .all<{ status: string }>(created.run.id);
    expect(paced.map((row) => row.status)).toEqual(['completed', 'completed']);

    // BYTE-IDENTICAL. `variables` and `critique` are the critic's own columns;
    // everything the operator wrote comes back exactly as it went up.
    const stored = await db.prepare('SELECT sequence_json FROM linkedin_campaigns WHERE id=?').get<{
      sequence_json: { steps: Array<{ id: string; day: number; kind: string; intent: string; template: string }> };
    }>(created.campaign.id);
    expect(stored?.sequence_json.steps.map(({ id, day, kind, intent, template }) => ({ id, day, kind, intent, template })))
      .toEqual(ASSEMBLED_STEPS);
  });

  /**
   * THE DUPLICATE-SCHEMA BUG, HELD DOWN.
   *
   * The step object was declared THREE times -- `sequenceStepInputSchema` in
   * sequence.ts, `linkedinSequenceStepsSchema` in app.ts, and the playbook's
   * own `sequenceSteps` in registry.ts -- and only the first learned about
   * `condition`. So a branch an operator wrote was parsed away twice on the way
   * in, and the campaign came back looking perfect, because a stripped branch
   * is a valid unconditional step. There is one schema now, and this asserts
   * the branch survives every layer between the request body and the row.
   */
  it('carries a branch through the route, the playbook and the stored sequence', async () => {
    await seat(WORKSPACE_A, '2026-01-01');

    const branched = [
      ASSEMBLED_STEPS[0],
      ASSEMBLED_STEPS[1],
      {
        id: 'follow-up',
        day: 4,
        kind: 'dm',
        intent: 'Only for the ones who accepted.',
        template: 'Thanks for connecting, {{firstName}}.',
        condition: { on: 'accepted', ofStepId: 'invite' }
      }
    ];

    const created = (await as(sessionA).post('/api/linkedin/campaigns').send({
      name: 'Branched',
      input: { targets: ['in/asha'], sequenceSteps: branched, kind: 'invite', horizonDays: 14, format: 'dripify' }
    }).expect(201)).body as { campaign: { id: string } };

    const stored = await db.prepare('SELECT sequence_json FROM linkedin_campaigns WHERE id=?').get<{
      sequence_json: { steps: Array<{ id: string; condition?: { on: string; ofStepId: string } | null }> };
    }>(created.campaign.id);
    const steps = stored?.sequence_json.steps ?? [];
    expect(steps.find((step) => step.id === 'follow-up')?.condition).toEqual({ on: 'accepted', ofStepId: 'invite' });
    // And the unconditional steps stay unconditional -- the field is absent
    // rather than null, so a sequence with no branches hashes as it always did
    // and no approval in flight is retired by this change.
    expect(steps.find((step) => step.id === 'invite')?.condition).toBeUndefined();
  });

  it('refuses a branch that waits on a step which cannot answer it, before anything runs', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const refused = await as(sessionA).post('/api/linkedin/campaigns').send({
      name: 'Dead arm',
      input: {
        targets: ['in/asha'],
        sequenceSteps: [
          { id: 'view', day: 0, kind: 'profile_view', intent: 'Look first.', template: '' },
          {
            id: 'follow-up',
            day: 2,
            kind: 'dm',
            intent: 'Waits on something nobody can accept.',
            template: 'Hello {{firstName}}.',
            condition: { on: 'accepted', ofStepId: 'view' }
          }
        ]
      }
    }).expect(400);
    // The validator's own sentence, verbatim: a profile view is never accepted,
    // so this branch could never be decided either way.
    expect((refused.body as { error: string }).error).toContain("'follow-up'");
    expect((refused.body as { error: string }).error).toContain('profile view');

    const runs = await db.prepare('SELECT id FROM playbook_runs WHERE workspace_id=?').all<{ id: string }>(WORKSPACE_A);
    expect(runs).toEqual([]);
  });

  it('refuses a request carrying both a brief and a sequence, in one sentence, before anything runs', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const refused = await as(sessionA).post('/api/linkedin/campaigns').send({
      name: 'Both',
      input: {
        targets: ['in/asha'],
        sequenceSteps: ASSEMBLED_STEPS,
        icp: { role: 'CTO', segment: 'seed-stage SaaS', pain: 'revenue leaks between tools' },
        offer: { name: 'Trevra', summary: 'Revenue system of record', mechanism: 'Reads the tools you already use' }
      }
    }).expect(400);
    expect((refused.body as { error: string }).error).toContain('not both');

    const runs = await db.prepare('SELECT id FROM playbook_runs WHERE workspace_id=?').all<{ id: string }>(WORKSPACE_A);
    expect(runs).toEqual([]);
  });

  it('refuses a request carrying neither, rather than starting a campaign with no copy', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const refused = await as(sessionA).post('/api/linkedin/campaigns')
      .send({ name: 'Neither', input: { targets: ['in/asha'] } })
      .expect(400);
    expect((refused.body as { error: string }).error).toContain('sequenceSteps');

    const runs = await db.prepare('SELECT id FROM playbook_runs WHERE workspace_id=?').all<{ id: string }>(WORKSPACE_A);
    expect(runs).toEqual([]);
  });

  it('holds an assembled sequence to the same rules the editor does, and starts nothing', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const refused = await as(sessionA).post('/api/linkedin/campaigns').send({
      name: 'Bad step',
      input: { targets: ['in/asha'], sequenceSteps: [{ id: 'open', day: 0, kind: 'dm', template: 'Hi {{fistName}}.' }] }
    }).expect(400);
    expect((refused.body as { error: string }).error).toContain("'open'");
    expect((refused.body as { error: string }).error).toContain('{{fistName}}');

    const runs = await db.prepare('SELECT id FROM playbook_runs WHERE workspace_id=?').all<{ id: string }>(WORKSPACE_A);
    expect(runs).toEqual([]);
    const campaigns = await db.prepare('SELECT id FROM linkedin_campaigns WHERE workspace_id=?').all<{ id: string }>(WORKSPACE_A);
    expect(campaigns).toEqual([]);
  });
});

describe('campaign lifecycle', () => {
  it('lists campaigns and releases their queued slots when stopped', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    await recordAction(db, {
      workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/queued', campaignId,
      status: 'planned', source: 'export', plannedFor: '2026-08-12T09:00:00.000Z'
    }, NOW);

    const listed = (await as(sessionA).get('/api/linkedin/campaigns').expect(200)).body as { campaigns: Array<{ id: string; name: string }> };
    expect(listed.campaigns.map((campaign) => campaign.id)).toContain(campaignId);

    const stopped = (await as(sessionA).post(`/api/linkedin/campaigns/${campaignId}/stop`).send({}).expect(200))
      .body as { campaign: { status: string; stopRequestedAt: string | null }; releasedActions: number };

    expect(stopped.campaign.status).toBe('stopped');
    expect(stopped.campaign.stopRequestedAt).toBeTruthy();
    expect(stopped.releasedActions).toBe(1);

    const released = await db.prepare("SELECT status FROM linkedin_actions WHERE workspace_id=? AND target_ref='in/queued'")
      .get<{ status: string }>(WORKSPACE_A);
    expect(released?.status).toBe('skipped');
  });

  it('refuses to start a campaign whose entire target list is excluded', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await as(sessionA).post('/api/linkedin/exclusions').send({ targets: [{ targetRef: 'in/maya' }] }).expect(201);
    await as(sessionA).post('/api/linkedin/campaigns')
      .send({
        name: 'All excluded',
        input: {
          targets: ['in/maya'],
          icp: { role: 'CTO', segment: 'seed-stage SaaS', pain: 'revenue leaks between tools' },
          offer: { name: 'Trevra', summary: 'Revenue system of record', mechanism: 'Reads the tools you already use' }
        }
      })
      .expect(400);
  });
});

/**
 * The routes modules 030-034 arrived without.
 *
 * Every one of them is held to the same four conventions as the twenty-one
 * that came before: session auth, `workspace_id` as the first clause of every
 * query, a zod body, and `{ error }` at the status `LinkedInApiError` carried.
 * What is asserted here is the part a client codes against and the part a
 * scoping bug hides behind -- that a read is scoped, that a write is gated,
 * and that a refusal says which kind of off it is.
 */
describe('lead sourcing routes (030)', () => {
  it('refuses every write while the opt-in is off, and names the switch', async () => {
    // OFF BY DEFAULT and separately from the worker: harvesting other people's
    // profiles is a decision with a different name on it than sending from your
    // own account, so a self-hoster who upgraded must not acquire a crawler.
    const refused = await as(sessionA).post('/api/linkedin/lead-sources')
      .send({ kind: 'search', url: 'https://www.linkedin.com/search/results/people/?keywords=revops' })
      .expect(409);
    expect((refused.body as { error: string }).error).toContain('TREVRA_LINKEDIN_LEAD_SOURCING');
  });

  it('still lists sources when the switch is off, reporting why rather than refusing', async () => {
    // A workspace with sources from before the switch was turned off must be
    // able to read what they found. Reading is not harvesting.
    const listed = (await as(sessionA).get('/api/linkedin/lead-sources').expect(200)).body as {
      enabled: boolean;
      offReason: string | null;
      sources: unknown[];
    };
    expect(listed.enabled).toBe(false);
    expect(listed.offReason).toContain('scraping');
    expect(listed.sources).toEqual([]);
  });

  it('404s a source belonging to another workspace', async () => {
    await as(sessionB).get('/api/linkedin/lead-sources/llsrc_someone_elses').expect(404);
    await as(sessionB).get('/api/linkedin/lead-sources/llsrc_someone_elses/leads').expect(404);
  });
});

describe('inbox routes (031)', () => {
  async function thread(workspaceId: string, threadUrn: string): Promise<void> {
    await db.prepare(`
      INSERT INTO linkedin_threads (id, workspace_id, seat_key, thread_urn, profile_url, name, unread, snippet, synced_at, created_at)
      VALUES (?,?,'owner',?,?,?,false,'',?::timestamptz,?::timestamptz)
    `).run(
      `lthr_${threadUrn.replace(/[^a-z0-9]/gi, '')}_${workspaceId}`,
      workspaceId,
      threadUrn,
      'https://www.linkedin.com/in/maya/',
      'Maya',
      NOW.toISOString(),
      NOW.toISOString()
    );
  }

  it('lists and reads conversations without opening a browser', async () => {
    await thread(WORKSPACE_A, '2-maya==');
    const listed = (await as(sessionA).get('/api/linkedin/inbox/threads').expect(200)).body as {
      threads: Array<{ threadUrn: string; hasReply: boolean }>;
    };
    expect(listed.threads.map((entry) => entry.threadUrn)).toEqual(['2-maya==']);

    const read = (await as(sessionA).get('/api/linkedin/inbox/threads/2-maya==').expect(200)).body as {
      thread: { threadUrn: string };
      messages: unknown[];
    };
    expect(read.thread.threadUrn).toBe('2-maya==');
    expect(read.messages).toEqual([]);
  });

  it('cannot read, sync or answer another workspace\'s conversation', async () => {
    await thread(WORKSPACE_A, '2-maya==');
    await as(sessionB).get('/api/linkedin/inbox/threads/2-maya==').expect(404);
    await as(sessionB).post('/api/linkedin/inbox/threads/2-maya==/sync').send({}).expect(404);
    await as(sessionB).post('/api/linkedin/inbox/threads/2-maya==/reply').send({ body: 'hello' }).expect(404);
    expect(await actionCount(WORKSPACE_B)).toBe(0);
  });

  it('queues a reply through the gate and sends nothing', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await thread(WORKSPACE_A, '2-maya==');

    const queued = (await as(sessionA).post('/api/linkedin/inbox/threads/2-maya==/reply')
      .send({ body: 'Happy to send it over.', plannedFor: '2026-08-06T10:00:00.000Z' })
      .expect(201)).body as { actionId: string; verdict: { allowed: boolean } };
    expect(queued.verdict.allowed).toBe(true);

    const row = await db.prepare('SELECT kind,status,thread_urn FROM linkedin_actions WHERE id=?')
      .get<{ kind: string; status: string; thread_urn: string | null }>(queued.actionId);
    // Its own kind, planned, carrying the conversation the worker answers in.
    expect(row).toMatchObject({ kind: 'reply', status: 'planned', thread_urn: '2-maya==' });
  });

  it('answers a gate refusal with a 409 carrying the check that refused it', async () => {
    // No seat: paced as a brand-new week-1 account, whose reply ceiling is zero.
    await thread(WORKSPACE_A, '2-maya==');
    const refused = await as(sessionA).post('/api/linkedin/inbox/threads/2-maya==/reply')
      .send({ body: 'hello', plannedFor: '2026-08-06T10:00:00.000Z' })
      .expect(409);
    expect((refused.body as { error: string }).error).toContain('safety gate');
    expect(await actionCount(WORKSPACE_A)).toBe(0);
  });
});

describe('withdrawal routes (032)', () => {
  async function pendingInvite(workspaceId: string, targetRef: string, daysAgo: number): Promise<void> {
    await recordAction(
      db,
      { workspaceId, kind: 'invite', targetRef, status: 'sent', source: 'export' },
      new Date(NOW.getTime() - daysAgo * 86_400_000)
    );
  }

  it('shows what WOULD be withdrawn, and persists nothing doing it', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await pendingInvite(WORKSPACE_A, 'in/stale', 40);
    await pendingInvite(WORKSPACE_A, 'in/fresh', 2);

    const preview = (await as(sessionA).get('/api/linkedin/withdrawals/candidates').expect(200)).body as {
      candidates: Array<{ targetRef: string; pendingDays: number }>;
      pendingInvites: number;
      maxOutstandingInvites: number;
      persisted: boolean;
    };
    expect(preview.candidates.map((entry) => entry.targetRef)).toEqual(['in/stale']);
    // The backlog and its ceiling ride along, so a screen can say WHY clearing
    // these returns capacity rather than only that it does.
    expect(preview.pendingInvites).toBe(2);
    expect(preview.maxOutstandingInvites).toBe(100);
    expect(preview.persisted).toBe(false);

    const queued = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_withdrawals WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_A);
    expect(queued?.total).toBe(0);
  });

  it('queues withdrawals and withdraws nothing, then lists the queue scoped to the workspace', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await pendingInvite(WORKSPACE_A, 'in/stale', 40);

    const enqueued = (await as(sessionA).post('/api/linkedin/withdrawals').send({}).expect(201)).body as {
      queued: number;
      withdrawn: number;
    };
    expect(enqueued.queued).toBe(1);
    // THE API NEVER ACTS. The worker claims these, re-runs the whole gate
    // against each one, and clicks at 30-120s gaps.
    expect(enqueued.withdrawn).toBe(0);

    const listed = (await as(sessionA).get('/api/linkedin/withdrawals').expect(200)).body as {
      withdrawals: Array<{ targetRef: string; status: string }>;
    };
    expect(listed.withdrawals.map((entry) => [entry.targetRef, entry.status])).toEqual([['in/stale', 'queued']]);

    const other = (await as(sessionB).get('/api/linkedin/withdrawals').expect(200)).body as { withdrawals: unknown[] };
    expect(other.withdrawals).toEqual([]);
  });

  it('refuses to sweep for a workspace with no seat rather than inventing one', async () => {
    await as(sessionA).post('/api/linkedin/withdrawals').send({}).expect(404);
  });
});

describe('engagement route (034)', () => {
  it('queues a follow through the full gate and sends nothing', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const queued = (await as(sessionA).post('/api/linkedin/engagement')
      .send({ kind: 'follow', targetRef: 'in/maya', plannedFor: '2026-08-06T10:00:00.000Z' })
      .expect(201)).body as { actionId: string; verdict: { allowed: boolean; checks: Array<{ check: string }> } };

    expect(queued.verdict.allowed).toBe(true);
    // EVERY check, unfiltered. "It is only a follow" is not a reason to skip one.
      expect(queued.verdict.checks).toHaveLength(14);

    const row = await db.prepare('SELECT kind,status FROM linkedin_actions WHERE id=?')
      .get<{ kind: string; status: string }>(queued.actionId);
    expect(row).toMatchObject({ kind: 'follow', status: 'planned' });
  });

  it('paces the passive kinds during warm-up instead of zeroing them', async () => {
    // Week 1 permits no invites at all; a like is what the warm-up CONSISTS of,
    // so it is allowed at the full band. Only the multiplier is bypassed.
    await seat(WORKSPACE_A);
    await as(sessionA).post('/api/linkedin/engagement')
      .send({ kind: 'like', targetRef: 'in/maya', plannedFor: '2026-08-06T10:00:00.000Z' })
      .expect(201);
  });

  it('refuses a kind that is not one of the three, before anything is filed', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await as(sessionA).post('/api/linkedin/engagement')
      .send({ kind: 'invite', targetRef: 'in/maya' })
      .expect(400);
    expect(await actionCount(WORKSPACE_A)).toBe(0);
  });

  it('refuses a second engagement of the same kind against the same person', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await as(sessionA).post('/api/linkedin/engagement')
      .send({ kind: 'follow', targetRef: 'in/maya', plannedFor: '2026-08-06T10:00:00.000Z' })
      .expect(201);
    const refused = await as(sessionA).post('/api/linkedin/engagement')
      .send({ kind: 'follow', targetRef: 'in/maya', plannedFor: '2026-08-06T10:30:00.000Z' })
      .expect(409);
    expect((refused.body as { error: string }).error).toContain('duplicate-target');
  });
});

describe('GET /api/linkedin/seat and /api/linkedin/analytics', () => {
  it('reports the seat, its posture, its warm-up week and today\'s rolling counts', async () => {
    // The endpoint derives warm-up from the real request clock. Do not anchor
    // this test to a calendar date that eventually ages into week 2.
    const activatedAt = new Date();
    await upsertSeat(db, WORKSPACE_A, { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' }, activatedAt);
    await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/today', status: 'sent', source: 'manual' }, new Date());

    const body = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as {
      seat: { label: string; activatedAt: string | null; detectedAt: string | null } | null;
      posture: string;
      warmupWeek: number;
      warmupWeeks: number;
      today: Record<string, number>;
    };
    expect(body.seat?.label).toBe('Pankaj (founder)');
    expect(body.posture).toBe('warmup');
    expect(body.warmupWeek).toBe(1);
    expect(body.today.invite).toBe(1);
    // The two clocks the setup screen reads instead of asking for a date.
    expect(body.seat?.activatedAt).toBe(activatedAt.toISOString());
    expect(body.seat?.detectedAt).toBeNull();
  });

  it('queues detection for a host-side worker when this process cannot open a browser', async () => {
    // THE CONTAINER CASE, which is the normal one: the API has no display and
    // no browser binaries, so detection becomes a request rather than a
    // failure. 202, not 409 -- nothing is wrong, it is just not finished.
    const queued = (await as(sessionA).post('/api/linkedin/seat/detect').send({ timezone: 'Europe/Zurich' }).expect(202))
      .body as { status: string; detected: null; seat: null; requestedAt: string; message: string };
    expect(queued.status).toBe('pending');
    expect(queued.detected).toBeNull();
    expect(queued.seat).toBeNull();
    expect(queued.message).toBe('Run `npm run linkedin:worker` on your machine to finish connecting.');

    // THE REPLAY GUARD, enforced by the partial unique index in 027 rather than
    // by this route remembering: pressing Connect again while the host worker
    // starts up joins the outstanding request instead of opening a second one.
    const again = (await as(sessionA).post('/api/linkedin/seat/detect').send({ timezone: 'Europe/Zurich' }).expect(202))
      .body as { requestedAt: string };
    expect(again.requestedAt).toBe(queued.requestedAt);

    // And it is visible on the route the client already polls.
    const seatBody = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as {
      detectRequest: { status: string; timezone: string; failureReason: string | null } | null;
    };
    expect(seatBody.detectRequest?.status).toBe('pending');
    expect(seatBody.detectRequest?.timezone).toBe('Europe/Zurich');
    expect(seatBody.detectRequest?.failureReason).toBeNull();

    // A timezone this runtime does not know is caller input, and is refused
    // HERE rather than queued for another machine to fail on minutes later.
    await as(sessionA).post('/api/linkedin/seat/detect').send({ timezone: 'Mars/Olympus' }).expect(400);
  });

  it('refuses detection outright on a hosted deployment, with nothing queued', async () => {
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    try {
      const refusal = (await as(sessionA).post('/api/linkedin/seat/detect').send({ timezone: 'Europe/Zurich' }).expect(409))
        .body as { error: string };
      expect(refusal.error).toBe('This deployment is hosted, so LinkedIn automation is off and cannot be enabled.');
      expect(refusal.error).not.toMatch(/TREVRA_LINKEDIN_LOCAL/);
    } finally {
      delete process.env.TREVRA_DEPLOYMENT_MODE;
    }

    const seatBody = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as { detectRequest: unknown };
    expect(seatBody.detectRequest).toBeNull();
  });

  it('accepts exactly one field on the detect route', async () => {
    // `strict()` is the enforcement: everything else about the seat is READ
    // from the session, never accepted from the client.
    await as(sessionA).post('/api/linkedin/seat/detect').send({}).expect(400);
    await as(sessionA).post('/api/linkedin/seat/detect')
      .send({ timezone: 'Europe/Zurich', connectionsCount: 9000 })
      .expect(400);
  });

  it('pauses and resumes the seat, and keeps the reason while it is paused', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const paused = (await as(sessionA).post('/api/linkedin/seat/pause').send({ reason: 'LinkedIn asked for a re-login' }).expect(200))
      .body as { seat: { pausedReason: string }; posture: string };
    expect(paused.posture).toBe('paused');
    expect(paused.seat.pausedReason).toBe('LinkedIn asked for a re-login');

    const resumed = (await as(sessionA).post('/api/linkedin/seat/resume').send({}).expect(200))
      .body as { seat: { pausedReason: string | null }; posture: string };
    expect(resumed.seat.pausedReason).toBeNull();
    // Stored 'warmup', but an account opened in January is past the ramp.
    expect(resumed.posture).toBe('steady');
  });

  it('deletes the seat, resets the ramp, and never touches the other workspace', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await seat(WORKSPACE_B);

    const deleted = (await as(sessionA).delete('/api/linkedin/seat').expect(200)).body as {
      deleted: boolean;
      clearedThreads: number;
      fullyStopped: boolean;
      released: { actionsSkipped: number; tasksCancelled: number; actionsInFlight: number };
    };
    // `released` and `fullyStopped` are the disconnect actually disconnecting:
    // the seat row was never the only thing that had to go.
    expect(deleted).toMatchObject({ deleted: true, clearedThreads: 0, fullyStopped: true });
    expect(deleted.released).toMatchObject({ actionsSkipped: 0, tasksCancelled: 0, actionsInFlight: 0 });

    const after = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as { seat: unknown };
    expect(after.seat).toBeNull();

    // A second delete finds nothing left to remove, honestly.
    expect((await as(sessionA).delete('/api/linkedin/seat').expect(200)).body)
      .toMatchObject({ deleted: false, clearedThreads: 0, fullyStopped: true });

    // The other workspace's seat is untouched.
    const other = (await as(sessionB).get('/api/linkedin/seat').expect(200)).body as { seat: unknown };
    expect(other.seat).not.toBeNull();
  });

  it('clears this workspace\'s stored inbox when the seat is deleted, and never the other workspace\'s', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await seat(WORKSPACE_B);

    await db.prepare(`
      INSERT INTO linkedin_threads (id, workspace_id, seat_key, thread_urn, profile_url, name)
      VALUES ('lthr_a', ?, 'owner', '2-a==', 'https://www.linkedin.com/in/stale/', 'Someone from the old account')
    `).run(WORKSPACE_A);
    await db.prepare(`
      INSERT INTO linkedin_messages (id, workspace_id, thread_id, direction, body, external_ref)
      VALUES ('lmsg_a', ?, 'lthr_a', 'in', 'A message from before the reconnect', 'sha256:stale-a')
    `).run(WORKSPACE_A);
    await db.prepare(`
      INSERT INTO linkedin_threads (id, workspace_id, seat_key, thread_urn, profile_url, name)
      VALUES ('lthr_b', ?, 'owner', '2-b==', 'https://www.linkedin.com/in/other/', 'Someone in the other workspace')
    `).run(WORKSPACE_B);

    const deleted = (await as(sessionA).delete('/api/linkedin/seat').expect(200)).body as { deleted: boolean; clearedThreads: number };
    expect(deleted).toMatchObject({ deleted: true, clearedThreads: 1 });

    expect(await db.prepare('SELECT id FROM linkedin_threads WHERE workspace_id=?').all(WORKSPACE_A)).toEqual([]);
    expect(await db.prepare('SELECT id FROM linkedin_messages WHERE workspace_id=?').all(WORKSPACE_A)).toEqual([]);

    // The other workspace's inbox is untouched.
    expect(await db.prepare('SELECT id FROM linkedin_threads WHERE workspace_id=?').all(WORKSPACE_B)).toHaveLength(1);
  });

  it('refuses a seat write it cannot honour, and refuses to set posture at all', async () => {
    await as(sessionA).put('/api/linkedin/seat').send({ label: 'Solo' }).expect(400);
    await as(sessionA).put('/api/linkedin/seat').send({ label: 'Solo', timezone: 'Mars/Olympus' }).expect(400);
    // The kill switch has its own route; it is not a field in a settings PUT.
    await as(sessionA).put('/api/linkedin/seat').send({ label: 'Solo', timezone: 'Europe/Zurich', posture: 'steady' }).expect(400);
  });

  it('reports the funnel by campaign with a filled 30-day series', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/a', campaignId, status: 'sent', source: 'manual' }, NOW);
    await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/b', campaignId, status: 'accepted', source: 'manual' }, NOW);
    await recordAction(db, { workspaceId: WORKSPACE_A, kind: 'invite', targetRef: 'in/c', campaignId, status: 'declined', source: 'manual' }, NOW);

    const body = (await as(sessionA).get('/api/linkedin/analytics').expect(200)).body as {
      windowDays: number;
      total: { sent: number; accepted: number };
      byCampaign: Array<{ campaignId: string; name: string; acceptanceRate: number | null }>;
      series: Array<{ date: string }>;
    };

    expect(body.windowDays).toBe(30);
    expect(body.series).toHaveLength(30);
    expect(body.total.sent).toBe(1);
    const campaign = body.byCampaign.find((entry) => entry.campaignId === campaignId);
    expect(campaign?.name).toBe('Platform leads');
    // 1 accepted of 2 decided. An unanswered invite is not a refusal and is not
    // in the denominator.
    expect(campaign?.acceptanceRate).toBeCloseTo(0.5);
  });
});
