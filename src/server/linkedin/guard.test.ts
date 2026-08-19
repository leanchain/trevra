import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { recordAction, type LinkedInActionKind, type LinkedInActionStatus } from './actions.js';
import {
  LINKEDIN_CHECK_NAMES,
  evaluateLinkedInSafety,
  linkedinGuardSkill,
  type LinkedInCheckName,
  type LinkedInSafetyVerdict
} from './guard.js';
import { MAX_OUTSTANDING_INVITES } from './limits.js';
import { FLAT_DAY_SHAPE, type DayShapeFn } from './pacing.js';
import { upsertSeat } from './seats.js';

let db: Db;

// Thursday 09:00 UTC. "Yesterday" is Wednesday, a business day, so the
// day-over-day seed is a real number rather than a skipped weekend.
const NOW = new Date('2026-08-06T09:00:00.000Z');
/** Thursday 10:00 -- inside business hours, on a weekday, in the seat's UTC zone. */
const SLOT = '2026-08-06T10:00:00.000Z';

const WORKSPACE_ID = 'ws_linkedin_guard_test';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'LinkedIn Guard Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_workflows WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
});

/**
 * The seat, activated on `activatedOn`.
 *
 * The ramp clock is the seat's FIRST WRITE, so the date is passed as the
 * instant of that write rather than declared on the row. Null means "activated
 * now", which is what a brand-new seat looks like.
 */
function seat(activatedOn: string | null, posture?: 'warmup' | 'steady' | 'paused' | 'cooldown') {
  const activatedAt = activatedOn ? new Date(`${activatedOn}T09:00:00.000Z`) : NOW;
  return upsertSeat(
    db,
    WORKSPACE_ID,
    { label: 'Test seat', timezone: 'UTC', posture },
    activatedAt
  );
}

let actionSeq = 0;
async function log(
  kind: LinkedInActionKind,
  status: LinkedInActionStatus,
  hoursAgo: number
): Promise<void> {
  actionSeq += 1;
  await recordAction(
    db,
    { workspaceId: WORKSPACE_ID, kind, targetRef: `logged-${actionSeq}`, status, source: 'export' },
    new Date(NOW.getTime() - hoursAgo * 3_600_000)
  );
}

/**
 * `options` defaults to EMPTY, so the gate runs with its real day shaping and
 * every test here exercises it. A test asserting a CEILING passes
 * `{ dayShape: FLAT_DAY_SHAPE }`, because "the band is 18/day" is a claim about
 * the ceiling and not about what this particular Thursday drew from it.
 */
function guard(
  overrides: Partial<Parameters<typeof evaluateLinkedInSafety>[1]> = {},
  options: Parameters<typeof evaluateLinkedInSafety>[3] = {}
): Promise<LinkedInSafetyVerdict> {
  return evaluateLinkedInSafety(
    db,
    {
      workspaceId: WORKSPACE_ID,
      kind: 'invite',
      targetRef: 'https://www.linkedin.com/in/fresh',
      plannedFor: SLOT,
      ...overrides
    },
    NOW,
    options
  );
}

function check(verdict: LinkedInSafetyVerdict, name: LinkedInCheckName) {
  const found = verdict.checks.find((entry) => entry.check === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

describe('the every-check contract', () => {
  it('runs all fourteen checks even when the very first one fails', async () => {
    // No seat, a weekend midnight slot, and a duplicate target all at once.
    // The reference behaviour this mirrors -- outreach/safety.ts -- exists
    // because short-circuiting makes an operator fix one blocker per run.
    await log('invite', 'sent', 1);
    const verdict = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'logged-1',
        plannedFor: '2026-08-08T23:00:00.000Z'
      },
      NOW
    );
    expect(verdict.checks).toHaveLength(LINKEDIN_CHECK_NAMES.length);
    expect(verdict.checks.map((entry) => entry.check)).toEqual([...LINKEDIN_CHECK_NAMES]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('seat-configured');
    expect(check(verdict, 'business-hours').passed).toBe(false);
    expect(check(verdict, 'weekend').passed).toBe(false);
    expect(check(verdict, 'duplicate-target').passed).toBe(false);
  });

  it('allows a well-paced action, and still says LinkedIn is prepare-only', async () => {
    await seat('2026-01-01');
    const verdict = await guard();
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.automationMode).toBe('prepare-only');
    expect(verdict.automationReason).toContain('Share on LinkedIn');
  });
});

describe('seat state', () => {
  it('fails closed for a workspace with no seat', async () => {
    const verdict = await guard();
    expect(check(verdict, 'seat-configured').passed).toBe(false);
    // ...and the ceilings are evaluated as a week-1 account, so it also fails
    // the warm-up check rather than passing by accident.
    expect(check(verdict, 'warmup-ceiling').passed).toBe(false);
  });

  it('blocks a paused seat and repeats the reason it was paused for', async () => {
    await seat('2026-01-01', 'paused');
    await db
      .prepare('UPDATE linkedin_seats SET paused_reason=? WHERE workspace_id=?')
      .run('LinkedIn asked for a re-login', WORKSPACE_ID);
    const verdict = await guard();
    expect(check(verdict, 'seat-paused').passed).toBe(false);
    expect(check(verdict, 'seat-paused').detail).toContain('re-login');
  });
});

describe('volume ceilings', () => {
  it('blocks anything at all in warm-up week 1', async () => {
    await seat('2026-08-04');
    const verdict = await guard();
    expect(check(verdict, 'warmup-ceiling').passed).toBe(false);
    expect(check(verdict, 'warmup-ceiling').detail).toContain('no invites at all');
  });

  it('lets passive activity through in week 1, still against the full band', async () => {
    await seat('2026-08-04');
    const views = await guard({ kind: 'profile_view' });
    expect(check(views, 'warmup-ceiling').passed).toBe(true);
    expect(check(views, 'warmup-ceiling').detail).toContain('Passive activity is not ramped');

    // ...and the band is still a ceiling: 30/day in the warm-up band.
    for (let index = 0; index < 30; index += 1) await log('profile_view', 'sent', 1);
    const capped = await guard({ kind: 'profile_view' });
    expect(check(capped, 'warmup-ceiling').passed).toBe(false);
    expect(check(capped, 'rolling-24h').passed).toBe(false);
  });

  it('blocks the invite that would exceed the rolling 24h band', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 1);
    const verdict = await guard({}, { dayShape: FLAT_DAY_SHAPE });
    expect(check(verdict, 'rolling-24h').passed).toBe(false);
    expect(check(verdict, 'rolling-24h').detail).toContain('18 of 18');
  });

  it('lets an explicit manual action bypass Trevra pacing but not account integrity', async () => {
    await seat('2026-01-01');
    // Fill the researched daily band and create a poor acceptance signal. These
    // are Trevra pacing inputs, so a human-driven action may override them.
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 1);
    for (let index = 0; index < 2; index += 1) await log('invite', 'accepted', 30);
    for (let index = 0; index < 8; index += 1) await log('invite', 'declined', 30);

    const manual = await guard(
      { manual: true, plannedFor: '2026-08-08T23:00:00.000Z' },
      { dayShape: FLAT_DAY_SHAPE }
    );
    expect(manual.allowed).toBe(true);
    for (const name of [
      'rolling-24h',
      'day-over-day-delta',
      'acceptance-rate',
      'business-hours',
      'weekend'
    ] as const) {
      expect(check(manual, name).passed).toBe(true);
    }
    expect(check(manual, 'rolling-24h').detail).toContain('explicitly bypassed Trevra pacing');

    // Replay protection is not pacing. A manual action cannot turn a duplicate
    // into a new action merely by asking for it interactively.
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/fresh',
        status: 'sent',
        source: 'manual'
      },
      NOW
    );
    const duplicate = await guard({ manual: true });
    expect(duplicate.allowed).toBe(false);
    expect(check(duplicate, 'duplicate-target').passed).toBe(false);
  });

  it('blocks on the rolling 7-day band even when today is quiet', async () => {
    await seat('2026-01-01');
    // 90 invites across the week, none in the last 24 hours.
    for (let index = 0; index < 90; index += 1) await log('invite', 'sent', 30 + (index % 5) * 24);
    const verdict = await guard();
    expect(check(verdict, 'rolling-24h').passed).toBe(true);
    expect(check(verdict, 'rolling-7d').passed).toBe(false);
  });

  it('does not invent a ceiling where none was published', async () => {
    await seat('2026-01-01');
    const verdict = await guard();
    // Invites have no reported 30-day figure, and profile views have no weekly
    // one. Neither gets a number made up for it.
    expect(check(verdict, 'rolling-30d').detail).toContain('No 30-day ceiling is published');
    const views = await guard({ kind: 'profile_view' });
    expect(check(views, 'rolling-7d').detail).toContain('No 7-day ceiling is published');
  });

  it("counts exported actions, because from LinkedIn's side they are about to be real", async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 18; index += 1) await log('invite', 'exported', 1);
    const verdict = await guard();
    expect(check(verdict, 'rolling-24h').passed).toBe(false);
  });

  it('does not count planned or skipped actions', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 18; index += 1) await log('invite', 'planned', 1);
    for (let index = 0; index < 18; index += 1) await log('invite', 'skipped', 1);
    const verdict = await guard({}, { dayShape: FLAT_DAY_SHAPE });
    expect(check(verdict, 'rolling-24h').passed).toBe(true);
    expect(check(verdict, 'rolling-24h').detail).toContain('0 of 18');
  });
});

describe('day-over-day delta', () => {
  it('blocks a spike over yesterday even while the daily band has room', async () => {
    await seat('2026-01-01');
    // 4 yesterday (Wednesday), 5 already today: the 6th is a 50% jump.
    for (let index = 0; index < 4; index += 1) await log('invite', 'sent', 30);
    for (let index = 0; index < 5; index += 1) await log('invite', 'sent', 1);
    const verdict = await guard();
    expect(check(verdict, 'rolling-24h').passed).toBe(true);
    expect(check(verdict, 'day-over-day-delta').passed).toBe(false);
    expect(check(verdict, 'day-over-day-delta').detail).toContain('ceiling is 5');
  });

  it('allows the ramp when it stays inside the delta', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 10; index += 1) await log('invite', 'sent', 30);
    for (let index = 0; index < 12; index += 1) await log('invite', 'sent', 1);
    const verdict = await guard();
    // 10 x 1.35 = 13.
    expect(check(verdict, 'day-over-day-delta').passed).toBe(true);
  });
});

describe('acceptance rate', () => {
  it('blocks below the 30% floor', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 2; index += 1) await log('invite', 'accepted', 30);
    for (let index = 0; index < 8; index += 1) await log('invite', 'declined', 30);
    const verdict = await guard();
    expect(check(verdict, 'acceptance-rate').passed).toBe(false);
    expect(check(verdict, 'acceptance-rate').detail).toContain('20%');
  });

  it('passes when nothing has been decided: an absent signal is not a bad one', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 10; index += 1) await log('invite', 'exported', 30);
    const verdict = await guard();
    expect(check(verdict, 'acceptance-rate').passed).toBe(true);
  });
});

describe('timing', () => {
  it("blocks a slot outside the seat's business hours", async () => {
    await seat('2026-01-01');
    const verdict = await guard({ plannedFor: '2026-08-06T22:00:00.000Z' });
    expect(check(verdict, 'business-hours').passed).toBe(false);
  });

  it("reads business hours in the SEAT's timezone, not the server's", async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Test seat', timezone: 'Asia/Tokyo' },
      new Date('2026-01-01T09:00:00.000Z')
    );
    // 10:00 UTC is 19:00 in Tokyo, past the window.
    const verdict = await guard({ plannedFor: SLOT });
    expect(check(verdict, 'business-hours').passed).toBe(false);
    expect(check(verdict, 'business-hours').detail).toContain('Asia/Tokyo');
  });

  it('blocks a weekend slot while the weekend factor is zero', async () => {
    await seat('2026-01-01');
    const verdict = await guard({ plannedFor: '2026-08-08T10:00:00.000Z' });
    expect(check(verdict, 'weekend').passed).toBe(false);
  });

  it('lets a seat that WORKS Saturdays act on a Saturday', async () => {
    // WEEKEND_FACTOR shapes the volume of a weekend day nobody configured. It
    // does not overrule an operator who ticked Saturday in `working_days`:
    // the configured days are authoritative for the weekday question, and
    // `pacing.ts` places slots on exactly the days this check accepts.
    await upsertSeat(
      db,
      WORKSPACE_ID,
      {
        label: 'Weekend seat',
        timezone: 'UTC',
        workingDays: [3, 6],
        workStartMinute: 600,
        workEndMinute: 840
      },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const verdict = await guard({ plannedFor: '2026-08-08T11:00:00.000Z' });
    expect(check(verdict, 'weekend').passed).toBe(true);
    expect(check(verdict, 'weekend').detail).toContain('explicitly configured');
    expect(check(verdict, 'business-hours').passed).toBe(true);
    expect(verdict.allowed).toBe(true);
  });

  it('still refuses a day the operator did not tick, and the hours outside the window', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      {
        label: 'Weekend seat',
        timezone: 'UTC',
        workingDays: [3, 6],
        workStartMinute: 600,
        workEndMinute: 840
      },
      new Date('2026-01-01T09:00:00.000Z')
    );
    // Thursday: a weekday, and not one of this seat's working days.
    const offDay = await guard({ plannedFor: '2026-08-06T11:00:00.000Z' });
    expect(check(offDay, 'business-hours').passed).toBe(false);
    expect(check(offDay, 'business-hours').detail).toContain('weekday(s) 3,6');
    // Wednesday, but at 09:00 -- an hour before the configured window opens.
    const early = await guard({ plannedFor: '2026-08-05T09:00:00.000Z' });
    expect(check(early, 'business-hours').passed).toBe(false);
    expect(check(early, 'business-hours').detail).toContain('between 10:00 and 14:00');
  });

  it('names Tuesday and Wednesday as enforcement-scan days without blocking them', async () => {
    await seat('2026-01-01');
    const verdict = await guard({ plannedFor: '2026-08-11T10:00:00.000Z' });
    expect(check(verdict, 'weekend').passed).toBe(true);
    expect(check(verdict, 'weekend').detail).toContain('enforcement-scan day');
  });

  it('fails both timing checks on an unparseable instant rather than throwing', async () => {
    await seat('2026-01-01');
    const verdict = await guard({ plannedFor: 'whenever' });
    expect(check(verdict, 'business-hours').passed).toBe(false);
    expect(check(verdict, 'weekend').passed).toBe(false);
  });
});

describe('InMail quota and duplicates', () => {
  it("enforces LinkedIn's published 50-a-month InMail quota, even for a manual action", async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 50; index += 1) await log('inmail', 'sent', 2 + index * 12);
    const verdict = await guard({ kind: 'inmail', manual: true });
    expect(check(verdict, 'inmail-monthly-quota').passed).toBe(false);
    expect(check(verdict, 'inmail-monthly-quota').detail).toContain('50 InMails');
    expect(verdict.allowed).toBe(false);
  });

  it('leaves the InMail quota alone for other kinds', async () => {
    await seat('2026-01-01');
    const verdict = await guard();
    expect(check(verdict, 'inmail-monthly-quota').passed).toBe(true);
  });

  it('blocks a second action against a target this seat already touched', async () => {
    await seat('2026-01-01');
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/known',
        status: 'sent',
        source: 'export'
      },
      NOW
    );
    const verdict = await guard({ targetRef: 'https://www.linkedin.com/in/known' });
    expect(check(verdict, 'duplicate-target').passed).toBe(false);
  });

  it('excludes the row under evaluation, so a claimed action is not its own duplicate', async () => {
    // The pre-flight caller claims its ledger row and then re-runs this gate.
    // Without the exclusion the check finds the very action being evaluated
    // and fails on it, every single time.
    await seat('2026-01-01');
    const claimed = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/claimed',
        status: 'planned',
        source: 'export'
      },
      NOW
    );

    const blind = await guard({ targetRef: 'https://www.linkedin.com/in/claimed' });
    expect(check(blind, 'duplicate-target').passed).toBe(false);

    const aware = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/claimed',
        plannedFor: SLOT
      },
      NOW,
      { excludeActionId: claimed.id }
    );
    expect(check(aware, 'duplicate-target').passed).toBe(true);
    expect(aware.allowed).toBe(true);
  });

  it('excludes exactly one row by id, not every row for that target', async () => {
    // The ledger's partial unique index means a second NON-SKIPPED row for the
    // same seat, kind and target cannot exist today -- which is precisely why
    // the exclusion is keyed on the row's id rather than on the target. Naming
    // a different id must leave the real row visible, so the check still
    // fails if that replay guard is ever relaxed.
    await seat('2026-01-01');
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/other',
        status: 'sent',
        source: 'export'
      },
      NOW
    );

    const verdict = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/other',
        plannedFor: SLOT
      },
      NOW,
      { excludeActionId: 'lact_not_the_one_in_the_ledger' }
    );
    expect(check(verdict, 'duplicate-target').passed).toBe(false);
    expect(verdict.allowed).toBe(false);
  });

  it('leaves every other check untouched when a row is excluded', async () => {
    await seat('2026-01-01');
    const claimed = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/late',
        status: 'planned',
        source: 'export'
      },
      NOW
    );
    // An excluded duplicate does not excuse a slot at 23:00 on a Saturday.
    const verdict = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/late',
        plannedFor: '2026-08-08T23:00:00.000Z'
      },
      NOW,
      { excludeActionId: claimed.id }
    );
    expect(verdict.checks).toHaveLength(LINKEDIN_CHECK_NAMES.length);
    expect(check(verdict, 'duplicate-target').passed).toBe(true);
    expect(check(verdict, 'business-hours').passed).toBe(false);
    expect(check(verdict, 'weekend').passed).toBe(false);
    expect(verdict.allowed).toBe(false);
  });

  it('counts the outstanding-invite backlog, which no rolling window can see', async () => {
    await seat('2026-01-01');
    // Older than every rolling window in this file, and still occupying the
    // seat's invite capacity on LinkedIn's side. That is the whole gap: before
    // this check, withdrawing two hundred of these returned nothing here.
    for (let index = 0; index < MAX_OUTSTANDING_INVITES; index += 1) {
      await recordAction(
        db,
        {
          workspaceId: WORKSPACE_ID,
          kind: 'invite',
          targetRef: `stale-${index}`,
          status: 'sent',
          source: 'export'
        },
        new Date(NOW.getTime() - 200 * 86_400_000)
      );
    }

    const verdict = await guard({ kind: 'invite', targetRef: 'https://www.linkedin.com/in/new' });
    expect(check(verdict, 'pending-invite-backlog').passed).toBe(false);
    expect(check(verdict, 'pending-invite-backlog').detail).toContain(
      `of ${MAX_OUTSTANDING_INVITES}`
    );
    // The rolling windows see none of them, which is exactly why the backlog
    // needed its own check rather than a wider window.
    expect(check(verdict, 'rolling-24h').passed).toBe(true);
    expect(check(verdict, 'rolling-7d').passed).toBe(true);
    expect(verdict.allowed).toBe(false);
  });

  it('applies the backlog ceiling to invites only', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < MAX_OUTSTANDING_INVITES; index += 1) {
      await recordAction(
        db,
        {
          workspaceId: WORKSPACE_ID,
          kind: 'invite',
          targetRef: `stale-${index}`,
          status: 'sent',
          source: 'export'
        },
        new Date(NOW.getTime() - 200 * 86_400_000)
      );
    }
    // Nobody leaves a DM pending. A backlog of unanswered invites is not a
    // reason to refuse a message to somebody who already connected.
    const verdict = await guard({ kind: 'dm', targetRef: 'https://www.linkedin.com/in/known' });
    expect(check(verdict, 'pending-invite-backlog').passed).toBe(true);
  });

  it('scopes the duplicate check to the kind, so a DM after an invite is fine', async () => {
    await seat('2026-01-01');
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/known',
        status: 'accepted',
        source: 'export'
      },
      NOW
    );
    const verdict = await guard({ kind: 'dm', targetRef: 'https://www.linkedin.com/in/known' });
    expect(check(verdict, 'duplicate-target').passed).toBe(true);
  });
});

/**
 * THE CAMPAIGN-DAY RAMP, the second of the two warm-ups.
 *
 * `warmup-ceiling` ramps by week since the SEAT was first automated;
 * `campaign-warmup` ramps by day since this CAMPAIGN was started, at the
 * manager brief's 20/40/60/80/100%. Both apply, and the stricter one binds --
 * a seat automated since January is at full capacity and a campaign it started
 * this morning still only gets a fifth of it.
 */
describe('campaign warm-up', () => {
  let campaignSeq = 0;

  async function campaignRow(
    startedAt: string | null,
    options: { workflow?: boolean } = {}
  ): Promise<string> {
    const workflowId = 'liwf_guard_test';
    const withWorkflow = options.workflow !== false;
    if (withWorkflow) {
      await db
        .prepare(
          'INSERT INTO linkedin_workflows (id,workspace_id,name,steps_json,created_at,updated_at) VALUES (?,?,?,?::jsonb,?,?) ON CONFLICT (id) DO NOTHING'
        )
        .run(
          workflowId,
          WORKSPACE_ID,
          'Guard test workflow',
          '[]',
          NOW.toISOString(),
          NOW.toISOString()
        );
    }
    campaignSeq += 1;
    const campaignId = `licmp_guard_${campaignSeq}`;
    await db
      .prepare(
        `
        INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,workflow_id,started_at,created_at,updated_at)
        VALUES (?,?,?,'running','{}'::jsonb,'owner',?,?::timestamptz,?,?)
      `
      )
      .run(
        campaignId,
        WORKSPACE_ID,
        `Guard campaign ${campaignSeq}`,
        withWorkflow ? workflowId : null,
        startedAt,
        NOW.toISOString(),
        NOW.toISOString()
      );
    return campaignId;
  }

  async function logCampaignInvites(campaignId: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      actionSeq += 1;
      await recordAction(
        db,
        {
          workspaceId: WORKSPACE_ID,
          kind: 'invite',
          targetRef: `campaign-${actionSeq}`,
          campaignId,
          status: 'sent',
          source: 'campaign'
        },
        new Date(NOW.getTime() - 3_600_000)
      );
    }
  }

  function seatWithInviteLimit(limit: number) {
    return upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Test seat', timezone: 'UTC', dailyInviteLimit: limit },
      new Date('2026-01-01T09:00:00.000Z')
    );
  }

  it('blocks the third invite of a managed campaign on its first day', async () => {
    await seatWithInviteLimit(10);
    const campaignId = await campaignRow(NOW.toISOString());

    // Day 1 is 20% of the seat's effective 10/day ceiling: two invites.
    const fresh = await guard({ campaignId }, { dayShape: FLAT_DAY_SHAPE });
    expect(check(fresh, 'campaign-warmup').passed).toBe(true);
    expect(check(fresh, 'campaign-warmup').detail).toContain('0 of 2');
    expect(check(fresh, 'campaign-warmup').detail).toContain('campaign day 1');

    await logCampaignInvites(campaignId, 2);
    const third = await guard({ campaignId }, { dayShape: FLAT_DAY_SHAPE });
    expect(check(third, 'campaign-warmup').passed).toBe(false);
    expect(check(third, 'campaign-warmup').detail).toContain('2 of 2');
    expect(third.reason).toContain('campaign-warmup');
    // The per-seat ramp is untouched and still passing -- this seat has been
    // automated since January. Two ramps, and the stricter one binds.
    expect(check(third, 'warmup-ceiling').passed).toBe(true);
    expect(check(third, 'rolling-24h').passed).toBe(true);
  });

  it('lifts the ceiling as the campaign ages: day 3 is 60%', async () => {
    await seatWithInviteLimit(10);
    const campaignId = await campaignRow(new Date(NOW.getTime() - 2 * 86_400_000).toISOString());
    await logCampaignInvites(campaignId, 2);
    const verdict = await guard({ campaignId }, { dayShape: FLAT_DAY_SHAPE });
    expect(check(verdict, 'campaign-warmup').passed).toBe(true);
    expect(check(verdict, 'campaign-warmup').detail).toContain('2 of 6');
    expect(check(verdict, 'campaign-warmup').detail).toContain('campaign day 3');
  });

  it('passes, and says why, for a campaign that is not a managed one', async () => {
    await seatWithInviteLimit(10);
    // No workflow and never started: a 025-era campaign folder whose actions a
    // human exports by hand. Never silently absent -- reported as not ramped.
    const campaignId = await campaignRow(null, { workflow: false });
    const verdict = await guard({ campaignId }, { dayShape: FLAT_DAY_SHAPE });
    expect(check(verdict, 'campaign-warmup').passed).toBe(true);
    expect(check(verdict, 'campaign-warmup').detail).toContain('not a managed campaign');
    expect(verdict.allowed).toBe(true);
  });

  it('passes, and says why, when no campaign was named at all', async () => {
    await seatWithInviteLimit(10);
    const verdict = await guard();
    expect(check(verdict, 'campaign-warmup').passed).toBe(true);
    expect(check(verdict, 'campaign-warmup').detail).toContain('No campaign was named');
  });

  it("counts only this campaign's own actions", async () => {
    await seatWithInviteLimit(10);
    const first = await campaignRow(NOW.toISOString());
    const second = await campaignRow(NOW.toISOString());
    await logCampaignInvites(first, 2);

    // One seat runs several campaigns and their ramps are independent -- the
    // seat-level ceilings above are what stop the total running away.
    const verdict = await guard({ campaignId: second }, { dayShape: FLAT_DAY_SHAPE });
    expect(check(verdict, 'campaign-warmup').passed).toBe(true);
    expect(check(verdict, 'campaign-warmup').detail).toContain('0 of 2');
  });
});

/**
 * TWO DAILY CEILINGS, NOT ONE, and the difference is what an InMail costs.
 *
 * Trevra's band is per kind; the operator's "messages" setting is one pool over
 * dm+reply+inmail. Comparing the POOL against the per-kind band collapsed the
 * whole pool to whichever band was smallest, so an account that had sent three
 * DMs could never send an InMail.
 */
describe('the operator pool and the per-kind band are independent', () => {
  function seatWithMessageLimit(limit: number) {
    return upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Test seat', timezone: 'UTC', dailyMessageLimit: limit },
      new Date('2026-01-01T09:00:00.000Z')
    );
  }

  it('LETS AN INMAIL THROUGH after three DMs, instead of collapsing the pool to 3', async () => {
    await seatWithMessageLimit(25);
    for (let index = 0; index < 3; index += 1) await log('dm', 'sent', 1);

    // Before: `min(inmail band 3, operator 25) = 3` was compared against the
    // POOL count of 3, so 3 + 1 <= 3 failed and every InMail was refused.
    const inmail = await guard({ kind: 'inmail' });
    expect(check(inmail, 'rolling-24h').passed).toBe(true);
    expect(check(inmail, 'rolling-24h').detail).toContain("3 of the operator's 25");
  });

  it('lets a reply through after twelve DMs, for the same reason', async () => {
    await seatWithMessageLimit(25);
    for (let index = 0; index < 12; index += 1) await log('dm', 'sent', 1);
    expect(check(await guard({ kind: 'reply' }), 'rolling-24h').passed).toBe(true);
  });

  it("still enforces the per-kind band against that kind's own count", async () => {
    await seatWithMessageLimit(25);
    // Three InMails is the whole steady band for InMails, whatever the pool says.
    for (let index = 0; index < 3; index += 1) await log('inmail', 'sent', 1);
    const verdict = await guard({ kind: 'inmail' });
    expect(check(verdict, 'rolling-24h').passed).toBe(false);
    expect(check(verdict, 'rolling-24h').detail).toContain('per-kind ceiling is full');
  });

  it('still enforces the operator pool across all three message kinds', async () => {
    await seatWithMessageLimit(5);
    // Two DMs, two replies and one InMail is five messages: the pool is full,
    // even though no single kind is anywhere near its band.
    for (let index = 0; index < 2; index += 1) await log('dm', 'sent', 1);
    for (let index = 0; index < 2; index += 1) await log('reply', 'sent', 1);
    await log('inmail', 'sent', 1);

    const verdict = await guard({ kind: 'dm' });
    expect(check(verdict, 'rolling-24h').passed).toBe(false);
    expect(check(verdict, 'rolling-24h').detail).toContain('operator pool is full');
  });

  it('names the stricter of the two numbers in the ceiling it quotes', async () => {
    await seatWithMessageLimit(4);
    const verdict = await guard({ kind: 'dm' });
    // 4 < the 12/day steady dm band, so the operator's number is what binds and
    // the sentence says which is which.
    expect(check(verdict, 'rolling-24h').detail).toContain(
      "the stricter of Trevra's 12/day safety band and the operator setting 4/day"
    );
    expect(check(verdict, 'warmup-ceiling').detail).toContain('4/day');
  });
});

describe('duplicate-target is scoped the way the ledger is scoped', () => {
  it('does not let one workflow step veto the next one', async () => {
    await seat('2026-01-01');
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'dm',
        targetRef: 'https://www.linkedin.com/in/lead/',
        status: 'sent',
        source: 'campaign',
        replayScope: 'limem_1:step-2'
      },
      new Date(NOW.getTime() - 3_600_000)
    );

    // Step 4 is a different action, and the ledger's own replay index (047)
    // would store it. The gate used to refuse it forever, so a workflow with
    // two message steps could never send the second.
    const next = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'dm',
        targetRef: 'https://www.linkedin.com/in/lead/',
        plannedFor: SLOT,
        replayScope: 'limem_1:step-4'
      },
      NOW
    );
    expect(check(next, 'duplicate-target').passed).toBe(true);
    expect(check(next, 'duplicate-target').detail).toContain('limem_1:step-4');

    // And a genuine repeat of the SAME step for the SAME member is still the
    // thing the replay guard exists to prevent.
    const repeat = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'dm',
        targetRef: 'https://www.linkedin.com/in/lead/',
        plannedFor: SLOT,
        replayScope: 'limem_1:step-2'
      },
      NOW
    );
    expect(check(repeat, 'duplicate-target').passed).toBe(false);
  });

  it('keeps the legacy one-kind-per-target guard for unscoped callers', async () => {
    await seat('2026-01-01');
    // An export writes with no replay scope, which stores 'legacy'. A second
    // unscoped invite to that target is still the duplicate it always was --
    // this is what stops a replayed export inviting one stranger twice.
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/exported/',
        status: 'exported',
        source: 'export'
      },
      new Date(NOW.getTime() - 3_600_000)
    );
    const verdict = await guard({ targetRef: 'https://www.linkedin.com/in/exported/' });
    expect(check(verdict, 'duplicate-target').passed).toBe(false);
  });
});

/**
 * Migration 044's column, honoured. The COMMENT on it is the specification:
 * it relaxes ONE check, for replies only, and says so out loud.
 */
describe('the warm-up ceiling override', () => {
  it('relaxes the warm-up ceiling for a reply, and says it was overridden', async () => {
    await seat('2026-08-04'); // Week 1: the ramp permits no messages at all.
    const refused = await guard({ kind: 'reply' });
    expect(check(refused, 'warmup-ceiling').passed).toBe(false);

    const overridden = await guard({ kind: 'reply', overrideWarmupCeiling: true });
    expect(check(overridden, 'warmup-ceiling').passed).toBe(true);
    expect(check(overridden, 'warmup-ceiling').detail).toContain('overrode the warm-up ceiling');
    expect(check(overridden, 'warmup-ceiling').detail).toContain(
      'relaxes this ceiling and nothing else'
    );
  });

  it('leaves every other check able to refuse', async () => {
    await seat('2026-08-04');
    // Outside business hours, with the override on: still refused, and not by
    // the warm-up ceiling.
    const nightly = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'reply',
        targetRef: 'https://www.linkedin.com/in/maya/',
        plannedFor: '2026-08-06T02:00:00.000Z',
        overrideWarmupCeiling: true
      },
      NOW
    );
    expect(check(nightly, 'warmup-ceiling').passed).toBe(true);
    expect(nightly.allowed).toBe(false);
    expect(nightly.reason).toContain('business-hours');
  });

  it('is ignored for every kind except a reply', async () => {
    await seat('2026-08-04');
    // A warm-up ramp exists to stop a new seat behaving like an established
    // one; answering somebody who wrote to you first is the only exception
    // offered, and a cold DM is not it.
    const dm = await guard({ kind: 'dm', overrideWarmupCeiling: true });
    expect(check(dm, 'warmup-ceiling').passed).toBe(false);
    expect(check(dm, 'warmup-ceiling').detail).not.toContain('overrode');
  });
});

/**
 * ANSWERING SOMEBODY WHO WROTE TO YOU IS NOT OUTREACH (migration 074).
 *
 * The ramp exists to slow a new seat's outreach. Applied to a reply in a
 * conversation the other person started, it refused the most ordinary thing
 * anybody does on LinkedIn -- and the only way past it was an operator override
 * that no control in the product ever set, so week one had no way to answer a
 * message at all.
 */
describe('a reply to somebody who wrote first', () => {
  it('is not held by the warm-up ceiling, and says why', async () => {
    await seat('2026-08-04'); // Week 1: the ramp permits no messages at all.
    expect(check(await guard({ kind: 'reply' }), 'warmup-ceiling').passed).toBe(false);

    const answered = await guard({ kind: 'reply', replyToInbound: true });
    expect(check(answered, 'warmup-ceiling').passed).toBe(true);
    expect(check(answered, 'warmup-ceiling').detail).toContain('wrote to this account first');
    expect(check(answered, 'warmup-ceiling').detail).toContain(
      'relaxes this ceiling and nothing else'
    );
    expect(answered.allowed).toBe(true);
  });

  it('does not excuse a cold message that merely claims to be one', async () => {
    await seat('2026-08-04');
    for (const kind of ['dm', 'invite', 'inmail'] as const) {
      const verdict = await guard({ kind, replyToInbound: true });
      expect(check(verdict, 'warmup-ceiling').passed).toBe(false);
      expect(check(verdict, 'warmup-ceiling').detail).not.toContain('wrote to this account first');
    }
  });

  /**
   * WHEN A PERSON IS TYPING, THE CLOCK IS THEIRS. The working window paces what
   * the account does by itself; people read their messages in the evening.
   */
  it('is not held by the hour of the day or the day of the week', async () => {
    await seat('2026-08-04');

    const nightly = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'reply',
        targetRef: 'https://www.linkedin.com/in/maya/',
        plannedFor: '2026-08-06T02:00:00.000Z',
        replyToInbound: true
      },
      NOW
    );
    expect(check(nightly, 'business-hours').passed).toBe(true);
    expect(check(nightly, 'business-hours').detail).toContain(
      'a person uses LinkedIn when they are at it'
    );
    expect(nightly.allowed).toBe(true);

    // 2026-08-08 is a Saturday, which this seat has not configured.
    const weekend = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'reply',
        targetRef: 'https://www.linkedin.com/in/maya/',
        plannedFor: '2026-08-08T10:00:00.000Z',
        replyToInbound: true
      },
      NOW
    );
    expect(check(weekend, 'weekend').passed).toBe(true);
    expect(weekend.allowed).toBe(true);
  });

  it('still refuses everybody else at 02:00', async () => {
    await seat('2026-08-04');
    for (const input of [
      { kind: 'dm' as const, replyToInbound: true },
      { kind: 'reply' as const, replyToInbound: false }
    ]) {
      const nightly = await evaluateLinkedInSafety(
        db,
        {
          workspaceId: WORKSPACE_ID,
          kind: input.kind,
          targetRef: 'https://www.linkedin.com/in/maya/',
          plannedFor: '2026-08-06T02:00:00.000Z',
          ...(input.replyToInbound ? { replyToInbound: true } : {})
        },
        NOW
      );
      expect(check(nightly, 'business-hours').passed).toBe(false);
      expect(nightly.allowed).toBe(false);
    }
  });

  it('leaves the checks that are about VOLUME able to refuse it', async () => {
    // Relaxing WHEN is not relaxing HOW MUCH: the rolling windows, posture and
    // the duplicate guard all still run.
    await seat('2026-08-04');
    const twice = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'reply',
        targetRef: 'https://www.linkedin.com/in/maya/',
        plannedFor: '2026-08-05T10:00:00.000Z',
        replyToInbound: true
      },
      NOW
    );
    expect(twice.checks.map((entry) => entry.check)).toContain('rolling-24h');
    expect(twice.checks.map((entry) => entry.check)).toContain('duplicate-target');
  });

  it('spells the refusal it is most likely to be read in', async () => {
    await seat('2026-08-04');
    const refused = await guard({ kind: 'reply' });
    expect(check(refused, 'warmup-ceiling').detail).toContain('permits no replies at all');
    expect(check(refused, 'warmup-ceiling').detail).not.toContain('replys');
  });
});

/**
 * THE WORKING WINDOW IS A STATEMENT ABOUT THE AUTOMATION, NOT ABOUT THE
 * OPERATOR.
 *
 * It exists so the ACCOUNT does not look like a scheduler when it works by
 * itself. Enforced against a hand-driven action it refused work a person had
 * already decided to do -- and the account holder's own answer to that is the
 * whole of this block: they read and answer LinkedIn on weekends, in the
 * evening and at midnight, like everybody else.
 *
 * SPARSE, STILL. Only the two time checks move; every ceiling below counts a
 * manual action exactly like any other.
 */
describe('an action a person asked for', () => {
  // 02:00 on a Thursday, and 10:00 on a Saturday this seat has not configured.
  const NIGHT = '2026-08-06T02:00:00.000Z';
  const SATURDAY = '2026-08-08T10:00:00.000Z';

  it('is not held by the hour of the day or the day of the week', async () => {
    await seat('2026-06-01');
    for (const kind of ['invite', 'dm', 'reply', 'profile_view'] as const) {
      const nightly = await guard({ kind, plannedFor: NIGHT, manual: true });
      expect(check(nightly, 'business-hours').passed).toBe(true);
      expect(check(nightly, 'business-hours').detail).toContain(
        'a person asked for at the moment they asked for it'
      );

      const saturday = await guard({ kind, plannedFor: SATURDAY, manual: true });
      expect(check(saturday, 'weekend').passed).toBe(true);
      expect(check(saturday, 'business-hours').passed).toBe(true);
    }
  });

  it('leaves the planner inside the window', async () => {
    // The same instants, with nobody at the keyboard. Nothing about the
    // scheduled side of this product changed.
    await seat('2026-06-01');
    expect(check(await guard({ kind: 'invite', plannedFor: NIGHT }), 'business-hours').passed).toBe(
      false
    );
    expect(check(await guard({ kind: 'invite', plannedFor: SATURDAY }), 'weekend').passed).toBe(
      false
    );
  });

  it('bypasses Trevra pacing for a manual action, not just the clock', async () => {
    // Week 1 autonomously permits no invites, but a signed-in person may still
    // explicitly ask Trevra to perform one now. The gate keeps running all
    // checks so the non-bypassable account/integrity checks still apply.
    await seat('2026-08-04');
    const midnight = await guard({ kind: 'invite', plannedFor: NIGHT, manual: true });
    expect(check(midnight, 'business-hours').passed).toBe(true);
    expect(check(midnight, 'warmup-ceiling').passed).toBe(true);
    expect(check(midnight, 'warmup-ceiling').detail).toContain('explicitly bypassed Trevra pacing');
    expect(midnight.allowed).toBe(true);
    const names = midnight.checks.map((entry) => entry.check);
    expect(names).toContain('rolling-24h');
    expect(names).toContain('rolling-7d');
    expect(names).toContain('duplicate-target');
  });

  it('does not need the inbound-reply exception when the action itself is manual', async () => {
    await seat('2026-08-04');
    const manualReply = await guard({ kind: 'reply', plannedFor: NIGHT, manual: true });
    expect(check(manualReply, 'warmup-ceiling').passed).toBe(true);
    const answered = await guard({
      kind: 'reply',
      plannedFor: NIGHT,
      manual: true,
      replyToInbound: true
    });
    expect(check(answered, 'warmup-ceiling').passed).toBe(true);
  });

  it('is not zeroed by a rest day, which is the same rhythm wearing a third name', async () => {
    // About one working day in eight is drawn empty so the account does not do
    // the same volume every day. That is the seat's rhythm; applied to a person
    // typing, it reported a ceiling of zero as "the ramp permits none at all"
    // and refused an ordinary Tuesday's work for a reason nobody could act on.
    await seat('2026-06-01');
    const dayShape: DayShapeFn = (_seed, _day, window) => ({
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      resting: true,
      draw: 1
    });

    const planner = await guard({ kind: 'dm' }, { dayShape });
    expect(check(planner, 'rolling-24h').passed).toBe(false);

    const person = await guard({ kind: 'dm', manual: true }, { dayShape });
    expect(check(person, 'rolling-24h').passed).toBe(true);
    expect(check(person, 'warmup-ceiling').passed).toBe(true);
  });

  it('is refused by a paused seat like anything else', async () => {
    await seat('2026-06-01', 'paused');
    const verdict = await guard({ kind: 'dm', plannedFor: NIGHT, manual: true });
    expect(check(verdict, 'seat-paused').passed).toBe(false);
    expect(verdict.allowed).toBe(false);
  });
});

/**
 * THE SKILL'S OWN SEAT RESOLUTION.
 *
 * `evaluateLinkedInSafety` still defaults an ABSENT `seatKey` to the owner
 * seat, and that is correct for it: it is the internal function every
 * single-seat call site in this subsystem has always called that way. What
 * changed is the SKILL boundary -- an agent calling `gtm.linkedin-guard`
 * without naming an account has not asked for the owner one, and the schema no
 * longer answers on its behalf. `resolveSkillSeatKey` (pacing.ts) is where
 * that decision lives and where its cases are asserted; this pins the two
 * facts about the gate that go with it.
 */
describe('the guard skill and the seat it is asked about', () => {
  it('leaves seatKey optional on the input schema rather than defaulting it', () => {
    // A default here would make "unspecified" indistinguishable from "the
    // owner account" at the one boundary where an agent, not a call site, is
    // supplying the value.
    const parsed = linkedinGuardSkill.manifest.inputSchema.parse({
      kind: 'invite',
      targetRef: 'https://www.linkedin.com/in/maya/',
      plannedFor: SLOT
    }) as { seatKey?: string };
    expect(parsed.seatKey).toBeUndefined();
  });

  it('prices its ceilings against the seat it is given, not the owner seat', async () => {
    // The owner seat is established; the sales seat was activated today and is
    // in warm-up week 1. Evaluating one against the other's ramp is the
    // wrong-account action the resolution exists to prevent.
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC' },
      new Date('2026-01-05T09:00:00.000Z')
    );
    await upsertSeat(db, WORKSPACE_ID, { label: 'Sales (SDR)', timezone: 'UTC' }, NOW, 'sales');

    const owner = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/maya/',
        plannedFor: SLOT
      },
      NOW
    );
    const sales = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'sales',
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/maya/',
        plannedFor: SLOT
      },
      NOW
    );

    expect(owner.checks.find((entry) => entry.check === 'seat-configured')?.detail).toContain(
      "'Owner'"
    );
    expect(sales.checks.find((entry) => entry.check === 'seat-configured')?.detail).toContain(
      "'Sales (SDR)'"
    );
    expect(sales.checks.find((entry) => entry.check === 'warmup-ceiling')?.detail).toContain(
      'Warm-up week 1 permits no invites'
    );
    expect(sales.checks.find((entry) => entry.check === 'warmup-ceiling')?.passed).toBe(false);
    expect(owner.checks.find((entry) => entry.check === 'warmup-ceiling')?.passed).toBe(true);
  });

  it("counts each seat's own ledger, so one account's volume never charges another's", async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC' },
      new Date('2026-01-05T09:00:00.000Z')
    );
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Sales (SDR)', timezone: 'UTC' },
      new Date('2026-01-05T09:00:00.000Z'),
      'sales'
    );
    for (let index = 0; index < 5; index += 1) {
      await recordAction(
        db,
        {
          workspaceId: WORKSPACE_ID,
          seatKey: 'owner',
          kind: 'invite',
          targetRef: `https://www.linkedin.com/in/owner-${index}/`,
          status: 'sent',
          source: 'export'
        },
        NOW
      );
    }

    const sales = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'sales',
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/maya/',
        plannedFor: SLOT
      },
      NOW
    );
    expect(sales.checks.find((entry) => entry.check === 'rolling-24h')?.detail).toMatch(/^0 of /);
  });
});

/**
 * THE PLANNER'S DAY SHAPE IS POLITE; THIS IS THE ENFORCED VERSION.
 *
 * Rest days, the 80-100% daily draw and the moved window edges shape a plan --
 * and a plan is only one of the routes an action can arrive by. A manual send,
 * an ad-hoc API call and a reply all reach LinkedIn without going anywhere near
 * `planPacing`, and every one of them goes through this gate.
 */
describe('the day shape binds at the gate, not only in the plan', () => {
  it('refuses everything on a day this seat does not work', async () => {
    await seat('2026-01-01');
    const verdict = await guard(
      {},
      {
        dayShape: (_seed, _day, window) => ({
          startMinute: window.startMinute,
          endMinute: window.endMinute,
          resting: true,
          draw: 1
        })
      }
    );
    expect(check(verdict, 'business-hours').passed).toBe(false);
    expect(check(verdict, 'business-hours').detail).toContain('not working that day');
    expect(verdict.allowed).toBe(false);
  });

  it('applies the daily draw to the ceiling, not just to the schedule', async () => {
    await seat('2026-01-01');
    // 15 sent against an 18/day band: allowed at full ceiling, refused once the
    // day has drawn 80% of it (14).
    for (let index = 0; index < 15; index += 1) await log('invite', 'sent', 1);

    const full = await guard({}, { dayShape: FLAT_DAY_SHAPE });
    expect(check(full, 'rolling-24h').passed).toBe(true);

    const drawn = await guard(
      {},
      {
        dayShape: (_seed, _day, window) => ({
          startMinute: window.startMinute,
          endMinute: window.endMinute,
          resting: false,
          draw: 0.8
        })
      }
    );
    expect(check(drawn, 'rolling-24h').passed).toBe(false);
    expect(check(drawn, 'rolling-24h').detail).toContain('of 14');
  });

  it("refuses an instant inside the configured window but outside the day's own hours", async () => {
    await seat('2026-01-01');
    // The slot is 10:00. A day that started at 11:00 has not started yet.
    const verdict = await guard(
      {},
      {
        dayShape: (_seed, _day, window) => ({
          startMinute: 11 * 60,
          endMinute: window.endMinute,
          resting: false,
          draw: 1
        })
      }
    );
    expect(check(verdict, 'business-hours').passed).toBe(false);
    expect(check(verdict, 'business-hours').detail).toContain('today between 11:00');
  });
});
