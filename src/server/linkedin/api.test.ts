import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { recordAction } from './actions.js';
import { OWNER_SEAT_KEY, upsertSeat } from './seats.js';
import { LinkedInApiError } from './errors.js';
import { writeActionStatus } from './action-ledger.js';
import { canonicalPayloadHash } from '../control-plane/payload.js';
import { encodeBackgroundRunDetail, recordSeatEvent } from './seat-events.js';
import { AVAILABILITY_RETURN_MARKER, markSideTaskRun } from './side-tasks.js';
import { LINKEDIN_CHECK_NAMES } from './guard.js';

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
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(workspaceId, label, NOW.toISOString());
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(userId, workspaceId, `${userId}@trevra.test`, label, NOW.toISOString());
  const token = randomBytes(32).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
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
  await upsertSeat(
    db,
    workspaceId,
    { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' },
    activatedAt
  );
}

/**
 * A `linkedin_campaigns` row, inserted directly now that the legacy
 * `createCampaign` this used to call is gone with the rest of `campaigns.ts`.
 * Only the columns this file's fixtures actually set.
 */
async function createCampaign(
  db: Db,
  input: { id: string; workspaceId: string; name: string; status?: string; seatKey?: string },
  now: Date
): Promise<void> {
  const timestamp = now.toISOString();
  await db
    .prepare(
      `
    INSERT INTO linkedin_campaigns (id, workspace_id, name, status, seat_key, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)
  `
    )
    .run(
      input.id,
      input.workspaceId,
      input.name,
      input.status ?? 'draft',
      input.seatKey ?? OWNER_SEAT_KEY,
      timestamp,
      timestamp
    );
}

async function actionCount(workspaceId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
    .get<{ total: number }>(workspaceId);
  return row?.total ?? 0;
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    // Children before parents: messages reference threads and leads reference
    // sources, and withdrawals reference the ledger rows deleted below.
    await db.prepare('DELETE FROM linkedin_messages WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_threads WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_leads WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_lead_sources WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_withdrawals WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_batches WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_seat_events WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_side_task_runs WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_exclusions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(workspaceId);
    await db
      .prepare('DELETE FROM linkedin_seat_detect_requests WHERE workspace_id=?')
      .run(workspaceId);
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
  it("never shows one workspace the other workspace's actions", async () => {
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/only-a',
        status: 'planned',
        source: 'export',
        plannedFor: NOW.toISOString()
      },
      NOW
    );
    const theirs = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_B,
        kind: 'invite',
        targetRef: 'in/only-b',
        status: 'planned',
        source: 'export',
        plannedFor: NOW.toISOString()
      },
      NOW
    );

    const mine = (await as(sessionA).get('/api/linkedin/actions').expect(200)).body as {
      actions: Array<{ targetRef: string }>;
    };
    expect(mine.actions.map((action) => action.targetRef)).toEqual(['in/only-a']);

    const yours = (await as(sessionB).get('/api/linkedin/actions').expect(200)).body as {
      actions: Array<{ targetRef: string }>;
    };
    expect(yours.actions.map((action) => action.targetRef)).toEqual(['in/only-b']);

    // The id is real and resolvable -- just not by this session.
    await as(sessionA).post(`/api/linkedin/actions/${theirs.id}/skip`).send({}).expect(404);
    await as(sessionA)
      .post('/api/linkedin/actions/outcome')
      .send({ actionId: theirs.id, outcome: 'sent' })
      .expect(404);

    const untouched = await db
      .prepare('SELECT status FROM linkedin_actions WHERE id=?')
      .get<{ status: string }>(theirs.id);
    expect(untouched?.status).toBe('planned');
  });
});

describe('the API never sends', () => {
  it('refuses a status smuggled into the skip route, and leaves the action planned', async () => {
    const action = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/maya',
        status: 'planned',
        source: 'export'
      },
      NOW
    );

    // `skip` takes no fields at all, so there is nothing here to name a status
    // with. The strict schema is the enforcement, not a convention.
    await as(sessionA)
      .post(`/api/linkedin/actions/${action.id}/skip`)
      .send({ status: 'sent' })
      .expect(400);
    await as(sessionA)
      .post(`/api/linkedin/actions/${action.id}/skip`)
      .send({ outcome: 'sent', status: 'accepted' })
      .expect(400);

    const row = await db
      .prepare('SELECT status, recorded_at FROM linkedin_actions WHERE id=?')
      .get<{ status: string; recorded_at: string | null }>(action.id);
    expect(row?.status).toBe('planned');
    expect(row?.recorded_at).toBeNull();
  });

  it('refuses a worker-only status at the choke point every route writes through', async () => {
    const action = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/jonas',
        status: 'planned',
        source: 'export'
      },
      NOW
    );

    for (const status of ['sent', 'accepted', 'replied'] as const) {
      const refusal = await writeActionStatus(
        db,
        { workspaceId: WORKSPACE_A, actionId: action.id, status, via: 'api' },
        NOW
      ).then(
        () => null,
        (error: unknown) => error
      );
      expect(refusal).toBeInstanceOf(LinkedInApiError);
      expect((refusal as LinkedInApiError).status).toBe(409);
      expect((refusal as LinkedInApiError).message).toMatch(/never sends/);
    }

    const row = await db
      .prepare('SELECT status FROM linkedin_actions WHERE id=?')
      .get<{ status: string }>(action.id);
    expect(row?.status).toBe('planned');
  });

  it('lets the one sanctioned route report an outcome, dated when it happened', async () => {
    const action = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/sofia',
        status: 'exported',
        source: 'export'
      },
      NOW
    );
    const occurredAt = '2026-08-04T14:00:00.000Z';

    const body = (
      await as(sessionA)
        .post('/api/linkedin/actions/outcome')
        .send({ actionId: action.id, outcome: 'accepted', occurredAt })
        .expect(200)
    ).body as { action: { status: string; recordedAt: string } };

    expect(body.action.status).toBe('accepted');
    // Every rolling window reads recorded_at, so an outcome reported today for
    // Tuesday's send must charge Tuesday.
    expect(new Date(body.action.recordedAt).toISOString()).toBe(occurredAt);
  });

  it('refuses an outcome against an action that was skipped and never went out', async () => {
    const action = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/dropped',
        status: 'planned',
        source: 'export'
      },
      NOW
    );
    await as(sessionA).post(`/api/linkedin/actions/${action.id}/skip`).send({}).expect(200);
    await as(sessionA)
      .post('/api/linkedin/actions/outcome')
      .send({ actionId: action.id, outcome: 'sent' })
      .expect(409);
  });

  it('refuses to skip work that already left the building', async () => {
    const action = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/gone',
        status: 'exported',
        source: 'export'
      },
      NOW
    );
    // Skipping releases the replay guard, which would free the target for a
    // second invite to somebody who has already had one.
    await as(sessionA).post(`/api/linkedin/actions/${action.id}/skip`).send({}).expect(409);
  });
});

describe('GET /api/linkedin/limits', () => {
  it('reports every ceiling with the rule that bound it and its confidence tag', async () => {
    await seat(WORKSPACE_A);

    const body = (await as(sessionA).get('/api/linkedin/limits').expect(200)).body as {
      seat: { configured: boolean; posture: string; warmupWeek: number; band: string };
      limits: Array<{
        kind: string;
        window: string;
        ceiling: number;
        bandCeiling: number;
        boundBy: string;
        rule: string;
        confidence: string;
        source: string;
      }>;
      signals: {
        acceptance: { confidence: string; floor: number };
        dayOverDay: { maxDelta: number; confidence: string };
      };
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
    const inmailMonth = body.limits.find(
      (limit) => limit.kind === 'inmail' && limit.window === 'month'
    );
    expect(inmailMonth?.confidence).toBe('HARD FACT');
    expect(inmailMonth?.ceiling).toBe(50);
    expect(inmailMonth?.source).toMatch(/1\.1/);

    const inviteDay = body.limits.find(
      (limit) => limit.kind === 'invite' && limit.window === 'day'
    );
    expect(inviteDay?.confidence).toBe('REPORTED');
    expect(inviteDay?.boundBy).toBe('warmup-multiplier');
    expect(inviteDay?.ceiling).toBeLessThan(inviteDay?.bandCeiling ?? 0);

    expect(body.signals.acceptance.confidence).toBe('REPORTED');
    expect(body.signals.dayOverDay.confidence).toBe('REPORTED');
  });

  it('publishes BOTH numbers and says which one bound, so the trade-off is not silent', async () => {
    // THE DEFECT THIS ASSERTS AGAINST: an operator sets 30, `min(band,
    // operator)` lets 18 out, and every screen printed one number without ever
    // naming the other or saying whose it was. Every figure a screen prints has
    // to come from here, so all three have to be here.
    await upsertSeat(
      db,
      WORKSPACE_A,
      { label: 'Pankaj (founder)', timezone: 'Europe/Zurich', dailyInviteLimit: 30 },
      new Date('2026-01-01T09:00:00.000Z')
    );

    const body = (await as(sessionA).get('/api/linkedin/limits').expect(200)).body as {
      seat: { safetyBandOverride: boolean };
      limits: Array<{
        kind: string;
        window: string;
        ceiling: number;
        bandCeiling: number;
        operatorLimit?: number | null;
        ceilingSource?: string;
        rule: string;
      }>;
    };
    const invite = body.limits.find((limit) => limit.kind === 'invite' && limit.window === 'day')!;

    expect(body.seat.safetyBandOverride).toBe(false);
    expect(invite.operatorLimit).toBe(30);
    expect(invite.bandCeiling).toBeLessThan(30);
    // The researched band still binds by default -- that decision is unchanged.
    expect(invite.ceilingSource).toBe('band');
    expect(invite.ceiling).toBe(invite.bandCeiling);
    // And the sentence beside it names both numbers rather than only the one
    // that won.
    expect(invite.rule).toContain('30');
    expect(invite.rule).toContain(String(invite.bandCeiling));

    // The per-account opt-out is what changes which of the two binds, and it
    // says so on the row rather than only on the seat.
    await upsertSeat(
      db,
      WORKSPACE_A,
      {
        label: 'Pankaj (founder)',
        timezone: 'Europe/Zurich',
        dailyInviteLimit: 30,
        safetyBandOverride: true
      },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const overridden = (await as(sessionA).get('/api/linkedin/limits').expect(200)).body as {
      seat: { safetyBandOverride: boolean };
      limits: Array<{
        kind: string;
        window: string;
        ceiling: number;
        bandCeiling: number;
        ceilingSource?: string;
      }>;
    };
    const raised = overridden.limits.find(
      (limit) => limit.kind === 'invite' && limit.window === 'day'
    )!;
    expect(overridden.seat.safetyBandOverride).toBe(true);
    expect(raised.ceilingSource).toBe('operator-override');
    expect(raised.ceiling).toBe(30);
    // The band is still reported: an override changes what binds, never what
    // the research says.
    expect(raised.bandCeiling).toBeLessThan(30);
  });

  it('stores an account proxy, never says its password back, and refuses one it could not use', async () => {
    await seat(WORKSPACE_A, '2026-01-01');

    // REFUSED AT THE WRITE, through the launcher's own resolver: storing a value
    // the worker would reject is storing an account that silently does no work.
    const refused = await as(sessionA)
      .put('/api/linkedin/seat')
      .send({ proxyUrl: 'socks5://relay:hunter2@proxy.example:1080' })
      .expect(400);
    expect((refused.body as { error: string }).error).toContain('SOCKS');
    expect((refused.body as { error: string }).error).not.toContain('hunter2');

    const saved = (
      await as(sessionA)
        .put('/api/linkedin/seat')
        .send({ proxyUrl: 'http://relay:hunter2@proxy.example:3128' })
        .expect(200)
    ).body as {
      seat: { proxy: { server: string; username: string | null; hasPassword: boolean } | null };
    };
    expect(saved.seat.proxy).toEqual({
      server: 'http://proxy.example:3128',
      username: 'relay',
      hasPassword: true
    });
    // The one rule this feature cannot break: a stored password is never
    // rendered back to a browser, in any field, on any route.
    expect(JSON.stringify(saved)).not.toContain('hunter2');

    const read = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as {
      seat: { proxy: { server: string } | null };
    };
    expect(read.seat.proxy?.server).toBe('http://proxy.example:3128');
    expect(JSON.stringify(read)).not.toContain('hunter2');

    // A save that says nothing about the proxy leaves it alone; an explicit
    // null removes it.
    const renamed = (
      await as(sessionA).put('/api/linkedin/seat').send({ label: 'Pankaj (renamed)' }).expect(200)
    ).body as { seat: { proxy: { server: string } | null } };
    expect(renamed.seat.proxy?.server).toBe('http://proxy.example:3128');
    const cleared = (
      await as(sessionA).put('/api/linkedin/seat').send({ proxyUrl: null }).expect(200)
    ).body as { seat: { proxy: unknown } };
    expect(cleared.seat.proxy).toBeNull();
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

interface WorkerStatusBody {
  enabled: boolean;
  companionBrowser: boolean;
  playwrightInstalled: boolean;
  playwrightPath: string | null;
  loggedIn: boolean;
  browser: {
    canLaunchHeaded: boolean;
    canLaunchHeadless: boolean;
    reasons: string[];
    headlessReasons: string[];
  };
  ready: boolean;
  blockers: string[];
}

function workerStatus(): Promise<WorkerStatusBody> {
  return as(sessionA)
    .get('/api/linkedin/worker/status')
    .expect(200)
    .then((response) => response.body as WorkerStatusBody);
}

describe('GET /api/linkedin/worker/status', () => {
  it('fails closed when no external browser is configured and never recommends local Chrome', async () => {
    const body = await workerStatus();

    expect(body.enabled).toBe(false);
    expect(typeof body.playwrightInstalled).toBe('boolean');
    expect(body.loggedIn).toBe(false);
    expect(body.browser.canLaunchHeaded).toBe(false);
    expect(body.browser.canLaunchHeadless).toBe(false);
    expect(body.ready).toBe(false);
    expect(body.blockers).toEqual(['LinkedIn automation is switched off on this server.']);
    expect(body.blockers.join(' ')).not.toMatch(/playwright install|chromium|xvfb|display/i);
  });

  it('ignores Docker-local browser registry and display signals', async () => {
    const saved = {
      browsers: process.env.PLAYWRIGHT_BROWSERS_PATH,
      display: process.env.DISPLAY,
      wayland: process.env.WAYLAND_DISPLAY,
      local: process.env.TREVRA_LINKEDIN_LOCAL
    };
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/tmp/pretend-local-chromium';
    process.env.DISPLAY = ':99';
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    process.env.TREVRA_LINKEDIN_LOCAL = 'true';

    try {
      const body = await workerStatus();
      expect(body.enabled).toBe(false);
      expect(body.ready).toBe(false);
      expect(body.browser.canLaunchHeaded).toBe(false);
      expect(body.browser.canLaunchHeadless).toBe(false);
      expect(body.blockers.join(' ')).not.toMatch(/chromium|xvfb|display/i);
    } finally {
      if (saved.browsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = saved.browsers;
      if (saved.display === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = saved.display;
      if (saved.wayland === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = saved.wayland;
      if (saved.local === undefined) delete process.env.TREVRA_LINKEDIN_LOCAL;
      else process.env.TREVRA_LINKEDIN_LOCAL = saved.local;
    }
  });

  it('becomes ready when Companion is configured while the visible browser remains off-server', async () => {
    const saved = {
      relay: process.env.TREVRA_COMPANION_RELAY_URL,
      key: process.env.TREVRA_SECRETS_KEY
    };
    process.env.TREVRA_COMPANION_RELAY_URL = 'ws://127.0.0.1:43887/api/linkedin/companion';
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');

    try {
      const body = await workerStatus();
      expect(body.enabled).toBe(true);
      expect(body.companionBrowser).toBe(true);
      expect(body.playwrightInstalled).toBe(true);
      expect(body.browser.canLaunchHeaded).toBe(false);
      expect(body.browser.canLaunchHeadless).toBe(true);
      expect(body.ready).toBe(true);
      expect(body.blockers).toEqual([]);
    } finally {
      if (saved.relay === undefined) delete process.env.TREVRA_COMPANION_RELAY_URL;
      else process.env.TREVRA_COMPANION_RELAY_URL = saved.relay;
      if (saved.key === undefined) delete process.env.TREVRA_SECRETS_KEY;
      else process.env.TREVRA_SECRETS_KEY = saved.key;
    }
  });

  it('keeps a confirmed LinkedIn session separate from browser availability', async () => {
    await seat(WORKSPACE_A);
    await upsertSeat(db, WORKSPACE_A, { sessionValidAt: NOW.toISOString() }, NOW);

    const body = await workerStatus();
    expect(body.loggedIn).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.ready).toBe(false);
    expect(body.blockers).toEqual(['LinkedIn automation is switched off on this server.']);
  });
});

/* ---------------------------------------------------------------------------
 * Campaigns and exports.
 *
 * The approved run is seeded directly rather than driven through the
 * playbook that used to produce it, because what these tests are about is
 * the export layer -- the bytes, the ledger, and the download -- and routing
 * them through a guard whose verdict depends on the day of the week would
 * make them assert the calendar instead.
 * ------------------------------------------------------------------------ */

const APPROVED_PAYLOAD = {
  format: 'dripify',
  campaignId: null as string | null,
  plan: {
    seatKey: 'owner',
    slots: [
      {
        plannedFor: '2026-08-10T09:00:00.000Z',
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/maya'
      },
      {
        plannedFor: '2026-08-10T13:30:00.000Z',
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/jonas'
      }
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
    {
      targetRef: 'https://www.linkedin.com/in/maya',
      firstName: 'Maya',
      lastName: 'Chen',
      company: 'Acme, Inc.',
      role: 'Head of Platform'
    }
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
  await db
    .prepare(
      `
    INSERT INTO playbook_runs (
      id,workspace_id,playbook_key,playbook_version,status,actor_type,actor_id,
      input_json,correlation_id,created_at,started_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?::jsonb,?,?,?,?)
  `
    )
    .run(
      runId,
      workspaceId,
      // Any registered playbook_key/version satisfies the FK on playbook_runs;
      // the row this fixture builds is never read back through the registry,
      // only through linkedin_campaigns and linkedin_actions.
      'gtm.audit-led-outreach',
      '1.0.0',
      'running',
      'user',
      `usr_${workspaceId}`,
      JSON.stringify({ targets: payload.plan.slots.map((slot) => slot.targetRef) }),
      `corr_${workspaceId}`,
      iso,
      iso,
      iso
    );
  await db
    .prepare(
      `
    INSERT INTO playbook_step_runs (
      id,playbook_run_id,step_id,step_type,status,attempt,input_json,approval_payload_hash,available_at,updated_at
    ) VALUES (?,?,?,?,?,?,?::jsonb,?,?,?)
  `
    )
    .run(
      stepRunId,
      runId,
      'approve-campaign',
      'approval',
      'completed',
      1,
      JSON.stringify(payload),
      payloadHash,
      iso,
      iso
    );
  await db
    .prepare(
      `
    INSERT INTO playbook_approvals (
      id,workspace_id,playbook_run_id,step_run_id,user_id,decision,payload_hash,comment,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `
    )
    .run(
      `pba_${workspaceId}`,
      workspaceId,
      runId,
      stepRunId,
      `usr_${workspaceId}`,
      'approve',
      payloadHash,
      null,
      iso
    );

  await db
    .prepare(
      `
    INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,playbook_run_id,seat_key,created_at,updated_at)
    VALUES (?,?,?,?,?::jsonb,?,'owner',?,?)
  `
    )
    .run(
      campaignId,
      workspaceId,
      name,
      'running',
      JSON.stringify(payload.sequence),
      runId,
      iso,
      iso
    );

  return campaignId;
}

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
  const SOURCING = 'TREVRA_LINKEDIN_LEAD_SOURCING';
  const MODE = 'TREVRA_DEPLOYMENT_MODE';
  const RELAY = 'TREVRA_COMPANION_RELAY_URL';
  const before = {
    sourcing: process.env[SOURCING],
    mode: process.env[MODE],
    relay: process.env[RELAY]
  };
  afterEach(() => {
    if (before.sourcing === undefined) delete process.env[SOURCING];
    else process.env[SOURCING] = before.sourcing;
    if (before.mode === undefined) delete process.env[MODE];
    else process.env[MODE] = before.mode;
    if (before.relay === undefined) delete process.env[RELAY];
    else process.env[RELAY] = before.relay;
  });

  it('is ON for a self-hosted deployment without anybody setting anything', async () => {
    // The switch used to be opt-in, so a self-hoster's Find-leads screen refused
    // with a sentence naming an environment variable they had no reason to know
    // existed. `TREVRA_DEPLOYMENT_MODE=local` already says this Trevra serves
    // one operator driving their own account.
    delete process.env[SOURCING];
    delete process.env[MODE];
    const created = await as(sessionA)
      .post('/api/linkedin/lead-sources')
      .send({
        kind: 'search',
        url: 'https://www.linkedin.com/search/results/people/?keywords=revops'
      })
      .expect(201);
    expect((created.body as { source: { kind: string } }).source.kind).toBe('search');

    const listed = (await as(sessionA).get('/api/linkedin/lead-sources').expect(200)).body as {
      enabled: boolean;
      offReason: string | null;
    };
    expect(listed.enabled).toBe(true);
    expect(listed.offReason).toBeNull();
  });

  it('allows hosted lead sourcing when browser custody is the local companion', async () => {
    process.env[SOURCING] = 'true';
    process.env[MODE] = 'hosted';
    process.env[RELAY] = 'ws://trevra:8080';
    await seat(WORKSPACE_A, '2026-01-01');
    const created = await as(sessionA)
      .post('/api/linkedin/lead-sources')
      .send({
        kind: 'search',
        url: 'https://www.linkedin.com/search/results/people/?keywords=hosted-companion'
      })
      .expect(201);
    expect((created.body as { source: { kind: string } }).source.kind).toBe('search');

    const listed = (await as(sessionA).get('/api/linkedin/lead-sources').expect(200)).body as {
      enabled: boolean;
      offReason: string | null;
      sources: Array<{
        nextRunAt?: string | null;
        nextRunWindowEndAt?: string | null;
        waitingFor?: string | null;
      }>;
    };
    expect(listed.enabled).toBe(true);
    expect(listed.offReason).toBeNull();
    expect(listed.sources[0]?.waitingFor).toBe('computer');
    expect(Date.parse(listed.sources[0]?.nextRunAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(listed.sources[0]?.nextRunWindowEndAt ?? '')).toBeGreaterThan(
      Date.parse(listed.sources[0]?.nextRunAt ?? '')
    );
  });

  it('still refuses hosted lead sourcing when no local companion execution home exists', async () => {
    process.env[SOURCING] = 'true';
    process.env[MODE] = 'hosted';
    delete process.env[RELAY];
    const refused = await as(sessionA)
      .post('/api/linkedin/lead-sources')
      .send({
        kind: 'search',
        url: 'https://www.linkedin.com/search/results/people/?keywords=no-companion'
      })
      .expect(409);
    expect((refused.body as { error: string }).error).toContain('local LinkedIn companion');
  });

  it('refuses every write when the operator switched it off, and names the switch', async () => {
    process.env[SOURCING] = 'false';
    const refused = await as(sessionA)
      .post('/api/linkedin/lead-sources')
      .send({
        kind: 'search',
        url: 'https://www.linkedin.com/search/results/people/?keywords=revops'
      })
      .expect(409);
    expect((refused.body as { error: string }).error).toContain('TREVRA_LINKEDIN_LEAD_SOURCING');
  });

  it('still lists sources when the switch is off, reporting why rather than refusing', async () => {
    // A workspace with sources from before the switch was turned off must be
    // able to read what they found. Reading is not harvesting.
    process.env[SOURCING] = 'false';
    const listed = (await as(sessionA).get('/api/linkedin/lead-sources').expect(200)).body as {
      enabled: boolean;
      offReason: string | null;
      sources: unknown[];
    };
    expect(listed.enabled).toBe(false);
    expect(listed.offReason).toContain('TREVRA_LINKEDIN_LEAD_SOURCING=false');
    expect(listed.sources).toEqual([]);
  });
});

describe('inbox routes (031)', () => {
  async function thread(workspaceId: string, threadUrn: string): Promise<void> {
    await db
      .prepare(
        `
      INSERT INTO linkedin_threads (id, workspace_id, seat_key, thread_urn, profile_url, name, unread, snippet, synced_at, created_at)
      VALUES (?,?,'owner',?,?,?,false,'',?::timestamptz,?::timestamptz)
    `
      )
      .run(
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

    const read = (await as(sessionA).get('/api/linkedin/inbox/threads/2-maya==').expect(200))
      .body as {
      thread: { threadUrn: string };
      messages: unknown[];
    };
    expect(read.thread.threadUrn).toBe('2-maya==');
    expect(read.messages).toEqual([]);
  });

  it("cannot read, sync or answer another workspace's conversation", async () => {
    await thread(WORKSPACE_A, '2-maya==');
    await as(sessionB).get('/api/linkedin/inbox/threads/2-maya==').expect(404);
    await as(sessionB).post('/api/linkedin/inbox/threads/2-maya==/sync').send({}).expect(404);
    await as(sessionB)
      .post('/api/linkedin/inbox/threads/2-maya==/reply')
      .send({ body: 'hello' })
      .expect(404);
    expect(await actionCount(WORKSPACE_B)).toBe(0);
  });

  it('queues a reply through the gate and sends nothing', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await thread(WORKSPACE_A, '2-maya==');

    const queued = (
      await as(sessionA)
        .post('/api/linkedin/inbox/threads/2-maya==/reply')
        .send({ body: 'Happy to send it over.', plannedFor: '2026-08-06T10:00:00.000Z' })
        .expect(201)
    ).body as { actionId: string; verdict: { allowed: boolean } };
    expect(queued.verdict.allowed).toBe(true);

    const row = await db
      .prepare('SELECT kind,status,thread_urn FROM linkedin_actions WHERE id=?')
      .get<{ kind: string; status: string; thread_urn: string | null }>(queued.actionId);
    // Its own kind, planned, carrying the conversation the worker answers in.
    expect(row).toMatchObject({ kind: 'reply', status: 'planned', thread_urn: '2-maya==' });
  });

  it('answers a gate refusal with a 409 carrying the check that refused it', async () => {
    // No seat: paced as a brand-new week-1 account, whose reply ceiling is zero.
    await thread(WORKSPACE_A, '2-maya==');
    const refused = await as(sessionA)
      .post('/api/linkedin/inbox/threads/2-maya==/reply')
      .send({ body: 'hello', plannedFor: '2026-08-06T10:00:00.000Z' })
      .expect(409);
    expect((refused.body as { error: string }).error).toContain('safety gate');
    expect(await actionCount(WORKSPACE_A)).toBe(0);
  });
});

describe('withdrawal routes (032)', () => {
  async function pendingInvite(
    workspaceId: string,
    targetRef: string,
    daysAgo: number
  ): Promise<void> {
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

    const preview = (await as(sessionA).get('/api/linkedin/withdrawals/candidates').expect(200))
      .body as {
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

    const queued = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_withdrawals WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_A);
    expect(queued?.total).toBe(0);
  });

  it('queues withdrawals and withdraws nothing, then lists the queue scoped to the workspace', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await pendingInvite(WORKSPACE_A, 'in/stale', 40);

    const enqueued = (await as(sessionA).post('/api/linkedin/withdrawals').send({}).expect(201))
      .body as {
      queued: number;
      withdrawn: number;
    };
    expect(enqueued.queued).toBe(1);
    // THE API NEVER ACTS. The worker claims these, re-runs the whole gate
    // against each one, and clicks at 30-120s gaps.
    expect(enqueued.withdrawn).toBe(0);

    const listed = (await as(sessionA).get('/api/linkedin/withdrawals').expect(200)).body as {
      withdrawals: Array<{
        targetRef: string;
        status: string;
        nextRunAt?: string | null;
        nextRunWindowEndAt?: string | null;
        nextRunTimezone?: string | null;
        waitingFor?: string | null;
      }>;
    };
    expect(listed.withdrawals.map((entry) => [entry.targetRef, entry.status])).toEqual([
      ['in/stale', 'queued']
    ]);
    expect(listed.withdrawals[0]?.nextRunTimezone).toBe('Europe/Zurich');
    expect(Date.parse(listed.withdrawals[0]?.nextRunAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(listed.withdrawals[0]?.nextRunWindowEndAt ?? '')).toBeGreaterThan(
      Date.parse(listed.withdrawals[0]?.nextRunAt ?? '')
    );
    expect(listed.withdrawals[0]?.waitingFor).toBe('worker');

    const other = (await as(sessionB).get('/api/linkedin/withdrawals').expect(200)).body as {
      withdrawals: unknown[];
    };
    expect(other.withdrawals).toEqual([]);
  });

  it('refuses to sweep for a workspace with no seat rather than inventing one', async () => {
    await as(sessionA).post('/api/linkedin/withdrawals').send({}).expect(404);
  });
});

describe('engagement route (034)', () => {
  it('queues a follow through the full gate and sends nothing', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const queued = (
      await as(sessionA)
        .post('/api/linkedin/engagement')
        .send({ kind: 'follow', targetRef: 'in/maya', plannedFor: '2026-08-06T10:00:00.000Z' })
        .expect(201)
    ).body as { actionId: string; verdict: { allowed: boolean; checks: Array<{ check: string }> } };

    expect(queued.verdict.allowed).toBe(true);
    // EVERY check, unfiltered. "It is only a follow" is not a reason to skip one.
    // Compare against the gate's canonical check vocabulary so adding a real
    // safety boundary (for example workspace suppression) cannot leave this
    // HTTP test frozen on an obsolete count.
    expect(queued.verdict.checks.map((check) => check.check)).toEqual([...LINKEDIN_CHECK_NAMES]);

    const row = await db
      .prepare('SELECT kind,status FROM linkedin_actions WHERE id=?')
      .get<{ kind: string; status: string }>(queued.actionId);
    expect(row).toMatchObject({ kind: 'follow', status: 'planned' });
  });

  it('paces the passive kinds during warm-up instead of zeroing them', async () => {
    // Week 1 permits no invites at all; a like is what the warm-up CONSISTS of,
    // so it is allowed at the full band. Only the multiplier is bypassed.
    await seat(WORKSPACE_A);
    await as(sessionA)
      .post('/api/linkedin/engagement')
      .send({ kind: 'like', targetRef: 'in/maya', plannedFor: '2026-08-06T10:00:00.000Z' })
      .expect(201);
  });

  it('refuses a kind that is not one of the three, before anything is filed', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await as(sessionA)
      .post('/api/linkedin/engagement')
      .send({ kind: 'invite', targetRef: 'in/maya' })
      .expect(400);
    expect(await actionCount(WORKSPACE_A)).toBe(0);
  });

  it('refuses a second engagement of the same kind against the same person', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await as(sessionA)
      .post('/api/linkedin/engagement')
      .send({ kind: 'follow', targetRef: 'in/maya', plannedFor: '2026-08-06T10:00:00.000Z' })
      .expect(201);
    const refused = await as(sessionA)
      .post('/api/linkedin/engagement')
      .send({ kind: 'follow', targetRef: 'in/maya', plannedFor: '2026-08-06T10:30:00.000Z' })
      .expect(409);
    expect((refused.body as { error: string }).error).toContain('duplicate-target');
  });
});

describe('GET /api/linkedin/seat and /api/linkedin/analytics', () => {
  it("reports the seat, its posture, its warm-up week and today's rolling counts", async () => {
    // The endpoint derives warm-up from the real request clock. Do not anchor
    // this test to a calendar date that eventually ages into week 2.
    const activatedAt = new Date();
    await upsertSeat(
      db,
      WORKSPACE_A,
      { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' },
      activatedAt
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/today',
        status: 'sent',
        source: 'manual'
      },
      new Date()
    );

    const body = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as {
      seat: { label: string; activatedAt: string | null; detectedAt: string | null } | null;
      execution: { ready: boolean; waitingFor: string | null };
      backgroundRun: {
        startAt: string;
        endAt: string;
        timezone: string;
        source: string;
        waitingFor: string | null;
      } | null;
      maintenance: Array<{
        task: string;
        nextRunAt: string | null;
        nextRunWindowEndAt: string | null;
        timezone: string;
      }>;
      posture: string;
      warmupWeek: number;
      warmupWeeks: number;
      today: Record<string, number>;
    };
    expect(body.seat?.label).toBe('Pankaj (founder)');
    expect(body.posture).toBe('warmup');
    expect(body.warmupWeek).toBe(1);
    expect(body.today.invite).toBe(1);
    expect(body.execution).toEqual({ ready: false, waitingFor: 'worker' });
    expect(body.backgroundRun).not.toBeNull();
    expect(body.backgroundRun?.timezone).toBe('Europe/Zurich');
    expect(Date.parse(body.backgroundRun?.endAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(body.maintenance.map((entry) => entry.task)).toEqual([
      'inbox',
      'pending_invites',
      'acceptance',
      'withdrawals',
      'lead_sources'
    ]);
    expect(body.maintenance.every((entry) => entry.timezone === 'Europe/Zurich')).toBe(true);
    expect(
      body.maintenance.every(
        (entry) => entry.nextRunAt === null || Date.parse(entry.nextRunAt) > Date.now() - 60_000
      )
    ).toBe(true);
    // The two clocks the setup screen reads instead of asking for a date.
    expect(body.seat?.activatedAt).toBe(activatedAt.toISOString());
    expect(body.seat?.detectedAt).toBeNull();
  });

  it('shows the next background run and merges send sittings with read-only visit history', async () => {
    const now = new Date();
    await upsertSeat(
      db,
      WORKSPACE_A,
      { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' },
      now
    );
    const maintenanceStart = new Date(now.getTime() - 10 * 60_000);
    const maintenanceEnd = new Date(now.getTime() - 8 * 60_000);
    await recordSeatEvent(
      db,
      {
        workspaceId: WORKSPACE_A,
        seatKey: 'owner',
        kind: 'background_run',
        detail: encodeBackgroundRunDetail({
          startedAt: maintenanceStart.toISOString(),
          finishedAt: maintenanceEnd.toISOString(),
          tasks: ['inbox', 'lead_sources'],
          status: 'completed',
          failedTasks: [],
          reason: null
        })
      },
      maintenanceEnd
    );
    await db
      .prepare(
        `
      INSERT INTO linkedin_batches (id,workspace_id,seat_key,status,executed_count,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?)
    `
      )
      .run(
        'lbatch_activity_test',
        WORKSPACE_A,
        'owner',
        'completed',
        2,
        new Date(now.getTime() - 20 * 60_000).toISOString(),
        new Date(now.getTime() - 15 * 60_000).toISOString()
      );

    const body = (await as(sessionA).get('/api/linkedin/activity?limit=20').expect(200)).body as {
      nextRun: {
        seatKey: string;
        seatLabel: string;
        startAt: string;
        endAt: string;
        waitingFor: string | null;
      } | null;
      runs: Array<{
        kind: string;
        seatLabel: string;
        tasks: string[];
        executedCount: number;
        status: string;
      }>;
    };
    expect(body.nextRun).not.toBeNull();
    expect(body.nextRun?.seatKey).toBe('owner');
    expect(body.nextRun?.seatLabel).toBe('Pankaj (founder)');
    expect(Date.parse(body.nextRun?.endAt ?? '')).toBeGreaterThan(now.getTime());
    expect(body.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'maintenance',
          tasks: ['inbox', 'lead_sources'],
          status: 'completed'
        }),
        expect.objectContaining({ kind: 'actions', executedCount: 2, status: 'completed' })
      ])
    );
  });

  it('scopes Activity to the selected LinkedIn account', async () => {
    const now = new Date();
    await upsertSeat(db, WORKSPACE_A, { label: 'Owner', timezone: 'UTC' }, now, 'owner');
    await upsertSeat(db, WORKSPACE_A, { label: 'Second', timezone: 'UTC' }, now, 'second');
    for (const [seatKey, batchId, count] of [
      ['owner', 'lbatch_owner_only', 1],
      ['second', 'lbatch_second_only', 3]
    ] as const) {
      await db
        .prepare(
          `
        INSERT INTO linkedin_batches (id,workspace_id,seat_key,status,executed_count,started_at,finished_at)
        VALUES (?,?,?,?,?,?,?)
      `
        )
        .run(
          batchId,
          WORKSPACE_A,
          seatKey,
          'completed',
          count,
          new Date(now.getTime() - 20_000).toISOString(),
          new Date(now.getTime() - 10_000).toISOString()
        );
      await recordSeatEvent(
        db,
        {
          workspaceId: WORKSPACE_A,
          seatKey,
          kind: 'background_run',
          detail: encodeBackgroundRunDetail({
            startedAt: new Date(now.getTime() - 40_000).toISOString(),
            finishedAt: new Date(now.getTime() - 30_000).toISOString(),
            tasks: ['inbox'],
            status: 'completed',
            failedTasks: [],
            reason: null
          })
        },
        now
      );
    }

    const body = (
      await as(sessionA).get('/api/linkedin/activity?seatKey=second&limit=20').expect(200)
    ).body as {
      nextRun: { seatKey: string } | null;
      runs: Array<{ seatKey: string; executedCount: number }>;
    };
    expect(body.nextRun?.seatKey).toBe('second');
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.runs.every((run) => run.seatKey === 'second')).toBe(true);
    expect(body.runs.some((run) => run.executedCount === 3)).toBe(true);
    expect(body.runs.some((run) => run.executedCount === 1)).toBe(false);
  });

  it('reports an availability return as a catch-up ready now instead of a later normal window', async () => {
    await upsertSeat(
      db,
      WORKSPACE_A,
      { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' },
      new Date()
    );
    const returnedAt = new Date();
    await markSideTaskRun(db, WORKSPACE_A, 'owner', AVAILABILITY_RETURN_MARKER, returnedAt);

    const body = (await as(sessionA).get('/api/linkedin/activity?limit=20').expect(200)).body as {
      nextRun: { source: string; startAt: string; endAt: string } | null;
    };
    expect(body.nextRun?.source).toBe('catchup');
    expect(body.nextRun?.endAt).toBe(body.nextRun?.startAt);
    expect(Math.abs(Date.parse(body.nextRun?.startAt ?? '') - Date.now())).toBeLessThan(10_000);
  });
  it('queues detection for Companion when the paired computer is configured but offline', async () => {
    const saved = {
      relay: process.env.TREVRA_COMPANION_RELAY_URL,
      key: process.env.TREVRA_SECRETS_KEY
    };
    process.env.TREVRA_COMPANION_RELAY_URL = 'ws://127.0.0.1:43887/api/linkedin/companion';
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');

    try {
      const queued = (
        await as(sessionA)
          .post('/api/linkedin/seat/detect')
          .send({ timezone: 'Europe/Zurich' })
          .expect(202)
      ).body as {
        status: string;
        detected: null;
        seat: null;
        requestedAt: string;
        message: string;
      };
      expect(queued.status).toBe('pending');
      expect(queued.detected).toBeNull();
      expect(queued.seat).toBeNull();
      expect(queued.message).toBe(
        'Run `npx trevra linkedin` on your computer and keep this Trevra tab open. The pending connection will be picked up when both are online.'
      );

      const again = (
        await as(sessionA)
          .post('/api/linkedin/seat/detect')
          .send({ timezone: 'Europe/Zurich' })
          .expect(202)
      ).body as { requestedAt: string };
      expect(again.requestedAt).toBe(queued.requestedAt);

      const seatBody = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as {
        detectRequest: {
          status: string;
          timezone: string;
          failureReason: string | null;
          nextAttemptAt?: string | null;
          waitingFor?: string | null;
        } | null;
      };
      expect(seatBody.detectRequest?.status).toBe('pending');
      expect(seatBody.detectRequest?.timezone).toBe('Europe/Zurich');
      expect(seatBody.detectRequest?.failureReason).toBeNull();
      expect(seatBody.detectRequest?.waitingFor).toBe('computer');
      expect(seatBody.detectRequest?.nextAttemptAt ?? null).toBeNull();

      await as(sessionA)
        .post('/api/linkedin/seat/detect')
        .send({ timezone: 'Mars/Olympus' })
        .expect(400);
    } finally {
      if (saved.relay === undefined) delete process.env.TREVRA_COMPANION_RELAY_URL;
      else process.env.TREVRA_COMPANION_RELAY_URL = saved.relay;
      if (saved.key === undefined) delete process.env.TREVRA_SECRETS_KEY;
      else process.env.TREVRA_SECRETS_KEY = saved.key;
    }
  });

  it('refuses detection when hosted has no external browser configured', async () => {
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    try {
      const refusal = (
        await as(sessionA)
          .post('/api/linkedin/seat/detect')
          .send({ timezone: 'Europe/Zurich' })
          .expect(409)
      ).body as { error: string };
      expect(refusal.error).toBe('LinkedIn automation is switched off on this server.');
      expect(refusal.error).not.toMatch(/chromium|playwright install|TREVRA_LINKEDIN_LOCAL/i);
    } finally {
      delete process.env.TREVRA_DEPLOYMENT_MODE;
    }

    const seatBody = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as {
      detectRequest: unknown;
    };
    expect(seatBody.detectRequest).toBeNull();
  });

  it('accepts exactly one field on the detect route', async () => {
    // `strict()` is the enforcement: everything else about the seat is READ
    // from the session, never accepted from the client.
    await as(sessionA).post('/api/linkedin/seat/detect').send({}).expect(400);
    await as(sessionA)
      .post('/api/linkedin/seat/detect')
      .send({ timezone: 'Europe/Zurich', connectionsCount: 9000 })
      .expect(400);
  });

  it('pauses and resumes the seat, and keeps the reason while it is paused', async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    const paused = (
      await as(sessionA)
        .post('/api/linkedin/seat/pause')
        .send({ reason: 'LinkedIn asked for a re-login' })
        .expect(200)
    ).body as { seat: { pausedReason: string }; posture: string };
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
      released: {
        actionsSkipped: number;
        tasksCancelled: number;
        channelActionsSkipped: number;
        channelActionsInFlight: number;
        actionsInFlight: number;
      };
    };
    // `released` and `fullyStopped` are the disconnect actually disconnecting:
    // the seat row was never the only thing that had to go.
    expect(deleted).toMatchObject({ deleted: true, clearedThreads: 0, fullyStopped: true });
    expect(deleted.released).toMatchObject({
      actionsSkipped: 0,
      tasksCancelled: 0,
      channelActionsSkipped: 0,
      channelActionsInFlight: 0,
      actionsInFlight: 0
    });

    const after = (await as(sessionA).get('/api/linkedin/seat').expect(200)).body as {
      seat: unknown;
    };
    expect(after.seat).toBeNull();

    // A second delete finds nothing left to remove, honestly.
    expect((await as(sessionA).delete('/api/linkedin/seat').expect(200)).body).toMatchObject({
      deleted: false,
      clearedThreads: 0,
      fullyStopped: true
    });

    // The other workspace's seat is untouched.
    const other = (await as(sessionB).get('/api/linkedin/seat').expect(200)).body as {
      seat: unknown;
    };
    expect(other.seat).not.toBeNull();
  });

  it("clears this workspace's stored inbox when the seat is deleted, and never the other workspace's", async () => {
    await seat(WORKSPACE_A, '2026-01-01');
    await seat(WORKSPACE_B);

    await db
      .prepare(
        `
      INSERT INTO linkedin_threads (id, workspace_id, seat_key, thread_urn, profile_url, name)
      VALUES ('lthr_a', ?, 'owner', '2-a==', 'https://www.linkedin.com/in/stale/', 'Someone from the old account')
    `
      )
      .run(WORKSPACE_A);
    await db
      .prepare(
        `
      INSERT INTO linkedin_messages (id, workspace_id, thread_id, direction, body, external_ref)
      VALUES ('lmsg_a', ?, 'lthr_a', 'in', 'A message from before the reconnect', 'sha256:stale-a')
    `
      )
      .run(WORKSPACE_A);
    await db
      .prepare(
        `
      INSERT INTO linkedin_threads (id, workspace_id, seat_key, thread_urn, profile_url, name)
      VALUES ('lthr_b', ?, 'owner', '2-b==', 'https://www.linkedin.com/in/other/', 'Someone in the other workspace')
    `
      )
      .run(WORKSPACE_B);

    const deleted = (await as(sessionA).delete('/api/linkedin/seat').expect(200)).body as {
      deleted: boolean;
      clearedThreads: number;
    };
    expect(deleted).toMatchObject({ deleted: true, clearedThreads: 1 });

    expect(
      await db.prepare('SELECT id FROM linkedin_threads WHERE workspace_id=?').all(WORKSPACE_A)
    ).toEqual([]);
    expect(
      await db.prepare('SELECT id FROM linkedin_messages WHERE workspace_id=?').all(WORKSPACE_A)
    ).toEqual([]);

    // The other workspace's inbox is untouched.
    expect(
      await db.prepare('SELECT id FROM linkedin_threads WHERE workspace_id=?').all(WORKSPACE_B)
    ).toHaveLength(1);
  });

  it('refuses a seat write it cannot honour, and refuses to set posture at all', async () => {
    await as(sessionA).put('/api/linkedin/seat').send({ label: 'Solo' }).expect(400);
    await as(sessionA)
      .put('/api/linkedin/seat')
      .send({ label: 'Solo', timezone: 'Mars/Olympus' })
      .expect(400);
    // The kill switch has its own route; it is not a field in a settings PUT.
    await as(sessionA)
      .put('/api/linkedin/seat')
      .send({ label: 'Solo', timezone: 'Europe/Zurich', posture: 'steady' })
      .expect(400);
  });

  it('reports the funnel by campaign with a filled 30-day series', async () => {
    const campaignId = await seedApprovedCampaign(WORKSPACE_A, 'Platform leads');
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/a',
        campaignId,
        status: 'sent',
        source: 'manual'
      },
      NOW
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/b',
        campaignId,
        status: 'accepted',
        source: 'manual'
      },
      NOW
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/c',
        campaignId,
        status: 'declined',
        source: 'manual'
      },
      NOW
    );

    const body = (await as(sessionA).get('/api/linkedin/analytics').expect(200)).body as {
      windowDays: number;
      total: { sent: number; accepted: number };
      byCampaign: Array<{
        campaignId: string;
        name: string;
        invitesSent: number;
        acceptanceRate: number | null;
        acceptanceRateOfDecided: number | null;
      }>;
      series: Array<{ date: string }>;
    };

    expect(body.windowDays).toBe(30);
    expect(body.series).toHaveLength(30);
    expect(body.total.sent).toBe(1);
    const campaign = body.byCampaign.find((entry) => entry.campaignId === campaignId);
    expect(campaign?.name).toBe('Platform leads');
    // 1 accepted of 3 INVITES SENT -- the one denominator a user is shown, on
    // this screen and on Campaigns. The declined invite is in it because it was
    // sent; the unanswered one is in it because it was sent too.
    expect(campaign?.invitesSent).toBe(3);
    expect(campaign?.acceptanceRate).toBeCloseTo(1 / 3);
    // The throttle's kinder denominator is still reported, under its own name,
    // so the two figures cannot be confused for each other: 1 of 2 decided.
    expect(campaign?.acceptanceRateOfDecided).toBeCloseTo(0.5);

    // ALL TIME IS A WINDOW THE ROUTE ACCEPTS. `days=0` used to be a 400 --
    // `min(1)` -- which is why the screen sent a constant 7 and printed "every
    // action ever filed" over the answer.
    const all = (await as(sessionA).get('/api/linkedin/analytics?days=0').expect(200)).body as {
      windowDays: number | null;
    };
    expect(all.windowDays).toBeNull();
  });
});

/**
 * THE ACCOUNT SWITCHER, AT THE ROUTES IT CLAIMS TO REACH.
 *
 * `useActiveSeatKey` is one value for the whole browser tab, and the copy on
 * the Accounts screen tells an operator that picking an account moves the
 * Inbox, the campaign list, the send queue and the numbers with them. Only the
 * inbox was true of: the queue sent no `seatKey` at all, the campaign list had
 * no filter to send one to, and analytics took the key and used it to relabel
 * the days of a workspace-wide count.
 *
 * Every test here is the same shape and it is the shape that matters: TWO
 * accounts in ONE workspace, a row belonging to each, and an assertion that
 * the second account's row is ABSENT from the first account's answer. A route
 * that merely accepts `seatKey` passes nothing here -- a filter that is
 * ignored returns both rows, which is exactly what these caught.
 */
describe('account (seat) scoping', () => {
  const SECOND_SEAT = 'partner';
  /** Past the warm-up ramp, so a campaign run reaches its approval step rather than being refused for having no slots. */
  const ESTABLISHED = new Date(NOW.getTime() - 90 * 86_400_000);

  /** Two LinkedIn accounts in one workspace, both established. */
  async function twoAccounts(workspaceId: string): Promise<void> {
    await upsertSeat(
      db,
      workspaceId,
      { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' },
      ESTABLISHED
    );
    await upsertSeat(
      db,
      workspaceId,
      { label: 'Partner', timezone: 'America/Los_Angeles' },
      ESTABLISHED,
      SECOND_SEAT
    );
  }

  it("answers the send queue for the account asked for, and never with the other one's rows", async () => {
    await twoAccounts(WORKSPACE_A);
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/owner-target',
        status: 'planned',
        source: 'export',
        plannedFor: NOW.toISOString()
      },
      NOW
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        seatKey: SECOND_SEAT,
        kind: 'invite',
        targetRef: 'in/partner-target',
        status: 'planned',
        source: 'export',
        plannedFor: NOW.toISOString()
      },
      NOW
    );

    type Queue = { actions: Array<{ targetRef: string; seatKey: string }> };
    const owner = (await as(sessionA).get('/api/linkedin/actions?seatKey=owner').expect(200))
      .body as Queue;
    expect(owner.actions.map((action) => action.targetRef)).toEqual(['in/owner-target']);

    const partner = (
      await as(sessionA).get(`/api/linkedin/actions?seatKey=${SECOND_SEAT}`).expect(200)
    ).body as Queue;
    expect(partner.actions.map((action) => action.targetRef)).toEqual(['in/partner-target']);

    // And the filter is a NARROWING, not a new default: a caller that names no
    // account still gets the workspace, which is what every pre-switcher
    // caller has always meant.
    const both = (await as(sessionA).get('/api/linkedin/actions').expect(200)).body as Queue;
    expect(both.actions.map((action) => action.targetRef).sort()).toEqual([
      'in/owner-target',
      'in/partner-target'
    ]);
  });

  it('counts analytics for one account only, and says which account it counted', async () => {
    await twoAccounts(WORKSPACE_A);
    await createCampaign(
      db,
      {
        id: 'lcmp_owner_stats',
        workspaceId: WORKSPACE_A,
        name: 'Owner campaign',
        status: 'running'
      },
      NOW
    );
    await createCampaign(
      db,
      {
        id: 'lcmp_partner_stats',
        workspaceId: WORKSPACE_A,
        name: 'Partner campaign',
        status: 'running',
        seatKey: SECOND_SEAT
      },
      NOW
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        kind: 'invite',
        targetRef: 'in/owner-sent',
        campaignId: 'lcmp_owner_stats',
        status: 'sent',
        source: 'manual'
      },
      NOW
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        seatKey: SECOND_SEAT,
        kind: 'invite',
        targetRef: 'in/partner-sent',
        campaignId: 'lcmp_partner_stats',
        status: 'sent',
        source: 'manual'
      },
      NOW
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        seatKey: SECOND_SEAT,
        kind: 'invite',
        targetRef: 'in/partner-accepted',
        campaignId: 'lcmp_partner_stats',
        status: 'accepted',
        source: 'manual'
      },
      NOW
    );

    type Funnel = {
      seatKey: string | null;
      total: { sent: number; accepted: number };
      byCampaign: Array<{ campaignId: string }>;
      series: Array<{ sent: number; accepted: number }>;
    };

    const owner = (await as(sessionA).get('/api/linkedin/analytics?seatKey=owner').expect(200))
      .body as Funnel;
    expect(owner.seatKey).toBe('owner');
    expect(owner.total.sent).toBe(1);
    expect(owner.total.accepted).toBe(0);
    expect(owner.byCampaign.map((row) => row.campaignId)).toEqual(['lcmp_owner_stats']);
    // The chart under the numbers is cut from the same rows, so it cannot
    // disagree with them: one sent, none accepted.
    expect(owner.series.reduce((sum, day) => sum + day.sent, 0)).toBe(1);
    expect(owner.series.reduce((sum, day) => sum + day.accepted, 0)).toBe(0);

    const partner = (
      await as(sessionA).get(`/api/linkedin/analytics?seatKey=${SECOND_SEAT}`).expect(200)
    ).body as Funnel;
    expect(partner.seatKey).toBe(SECOND_SEAT);
    expect(partner.total.sent).toBe(1);
    expect(partner.total.accepted).toBe(1);
    expect(partner.byCampaign.map((row) => row.campaignId)).toEqual(['lcmp_partner_stats']);
    expect(partner.series.reduce((sum, day) => sum + day.accepted, 0)).toBe(1);

    // Unnamed is still the whole workspace, and says so with a null seat.
    const workspace = (await as(sessionA).get('/api/linkedin/analytics').expect(200))
      .body as Funnel;
    expect(workspace.seatKey).toBeNull();
    expect(workspace.total.sent).toBe(2);
    expect(workspace.byCampaign.map((row) => row.campaignId).sort()).toEqual([
      'lcmp_owner_stats',
      'lcmp_partner_stats'
    ]);
  });

  it("reports each account's own limits, spent against its own ledger", async () => {
    await twoAccounts(WORKSPACE_A);
    // Written at the REAL now, not the fixture's: every ceiling here is a
    // rolling 24h window measured from the moment the route runs, so a send
    // dated a week ago is correctly spent against nothing.
    const justNow = new Date();
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        seatKey: SECOND_SEAT,
        kind: 'invite',
        targetRef: 'in/partner-spent',
        status: 'sent',
        source: 'manual'
      },
      justNow
    );

    type Report = {
      seat: { label: string; timezone: string };
      limits: Array<{ kind: string; window: string; used: number }>;
    };
    const used = (report: Report) =>
      report.limits.find((limit) => limit.kind === 'invite' && limit.window === 'day')?.used;

    const owner = (await as(sessionA).get('/api/linkedin/limits?seatKey=owner').expect(200))
      .body as Report;
    expect(owner.seat.timezone).toBe('Europe/Zurich');
    expect(used(owner)).toBe(0);

    const partner = (
      await as(sessionA).get(`/api/linkedin/limits?seatKey=${SECOND_SEAT}`).expect(200)
    ).body as Report;
    expect(partner.seat.label).toBe('Partner');
    expect(partner.seat.timezone).toBe('America/Los_Angeles');
    expect(used(partner)).toBe(1);
  });

  it('keeps the seat filter inside the workspace it was asked in', async () => {
    // Two workspaces both using the key 'partner'. `seat_key` is not unique on
    // its own, so a filter that reached SQL without the workspace predicate
    // beside it would answer with somebody else's account.
    await twoAccounts(WORKSPACE_A);
    await twoAccounts(WORKSPACE_B);
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_A,
        seatKey: SECOND_SEAT,
        kind: 'invite',
        targetRef: 'in/a-partner',
        status: 'planned',
        source: 'export',
        plannedFor: NOW.toISOString()
      },
      NOW
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_B,
        seatKey: SECOND_SEAT,
        kind: 'invite',
        targetRef: 'in/b-partner',
        status: 'planned',
        source: 'export',
        plannedFor: NOW.toISOString()
      },
      NOW
    );

    const mine = (
      await as(sessionA).get(`/api/linkedin/actions?seatKey=${SECOND_SEAT}`).expect(200)
    ).body as { actions: Array<{ targetRef: string }> };
    expect(mine.actions.map((action) => action.targetRef)).toEqual(['in/a-partner']);
  });
});

describe('LinkedIn posts', () => {
  const BLOCKS = [{ runs: [{ type: 'text', text: 'Hello world' }] }];

  it('creates a draft, lists it, edits it, then cancels it', async () => {
    const token = await seedSession(WORKSPACE_A, 'A');
    await seat(WORKSPACE_A);
    const created = await as(token).post('/api/linkedin/posts').send({ blocks: BLOCKS });
    expect(created.status).toBe(200);
    expect(created.body.post.status).toBe('draft');

    const listed = await as(token).get('/api/linkedin/posts');
    expect(listed.body.posts.map((p: { id: string }) => p.id)).toContain(created.body.post.id);

    const edited = await as(token)
      .patch(`/api/linkedin/posts/${created.body.post.id}`)
      .send({ blocks: [{ runs: [{ type: 'text', text: 'Edited' }] }] });
    expect(edited.body.post.blocks[0].runs[0].text).toBe('Edited');

    const canceled = await as(token).delete(`/api/linkedin/posts/${created.body.post.id}`);
    expect(canceled.body.post.status).toBe('canceled');
  });

  it('refuses to schedule with no scheduledAt, and refuses a post over 3000 characters', async () => {
    const token = await seedSession(WORKSPACE_A, 'A');
    await seat(WORKSPACE_A);
    const noTime = await as(token)
      .post('/api/linkedin/posts')
      .send({ blocks: BLOCKS, status: 'scheduled' });
    expect(noTime.status).toBe(400);

    const tooLong = await as(token)
      .post('/api/linkedin/posts')
      .send({ blocks: [{ runs: [{ type: 'text', text: 'x'.repeat(3001) }] }] });
    expect(tooLong.status).toBe(400);
  });

  it('publish-now sets scheduledAt to now and status to scheduled -- never synchronously posted', async () => {
    const token = await seedSession(WORKSPACE_A, 'A');
    await seat(WORKSPACE_A);
    const created = await as(token).post('/api/linkedin/posts').send({ blocks: BLOCKS });
    const published = await as(token).post(
      `/api/linkedin/posts/${created.body.post.id}/publish-now`
    );
    expect(published.body.post.status).toBe('scheduled');
    expect(published.body.post.scheduledAt).toBeTruthy();
  });

  it('scopes posts to the calling workspace', async () => {
    const tokenA = await seedSession(WORKSPACE_A, 'A');
    const tokenB = await seedSession(WORKSPACE_B, 'B');
    await seat(WORKSPACE_A);
    await seat(WORKSPACE_B);
    const created = await as(tokenA).post('/api/linkedin/posts').send({ blocks: BLOCKS });
    const fromB = await as(tokenB).get(`/api/linkedin/posts/${created.body.post.id}`);
    expect(fromB.status).toBe(404);
  });

  /**
   * A seat key nobody configured must be refused, not filed. Accepted, the row
   * lands under a seat that does not exist: no screen lists it and no worker
   * tick ever opens a session for it -- the same failure the campaigns route
   * already guards against.
   */
  it('refuses a seatKey that is not configured for the workspace', async () => {
    const token = await seedSession(WORKSPACE_A, 'A');
    await seat(WORKSPACE_A);
    const created = await as(token)
      .post('/api/linkedin/posts')
      .send({ blocks: BLOCKS, seatKey: 'seat-that-does-not-exist' });
    expect(created.status).toBe(404);

    const listed = await as(token).get('/api/linkedin/posts?seatKey=seat-that-does-not-exist');
    expect(listed.body.posts).toHaveLength(0);
  });
});
