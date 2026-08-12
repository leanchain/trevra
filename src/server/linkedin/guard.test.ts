import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { recordAction, type LinkedInActionKind, type LinkedInActionStatus } from './actions.js';
import { LINKEDIN_CHECK_NAMES, evaluateLinkedInSafety, type LinkedInCheckName, type LinkedInSafetyVerdict } from './guard.js';
import { MAX_OUTSTANDING_INVITES } from './limits.js';
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
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Guard Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(WORKSPACE_ID);
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
  return upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC', posture }, activatedAt);
}

let actionSeq = 0;
async function log(kind: LinkedInActionKind, status: LinkedInActionStatus, hoursAgo: number): Promise<void> {
  actionSeq += 1;
  await recordAction(
    db,
    { workspaceId: WORKSPACE_ID, kind, targetRef: `logged-${actionSeq}`, status, source: 'export' },
    new Date(NOW.getTime() - hoursAgo * 3_600_000)
  );
}

function guard(overrides: Partial<Parameters<typeof evaluateLinkedInSafety>[1]> = {}): Promise<LinkedInSafetyVerdict> {
  return evaluateLinkedInSafety(
    db,
    { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/fresh', plannedFor: SLOT, ...overrides },
    NOW
  );
}

function check(verdict: LinkedInSafetyVerdict, name: LinkedInCheckName) {
  const found = verdict.checks.find((entry) => entry.check === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

describe('the every-check contract', () => {
  it('runs all thirteen checks even when the very first one fails', async () => {
    // No seat, a weekend midnight slot, and a duplicate target all at once.
    // The reference behaviour this mirrors -- outreach/safety.ts -- exists
    // because short-circuiting makes an operator fix one blocker per run.
    await log('invite', 'sent', 1);
    const verdict = await evaluateLinkedInSafety(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'logged-1', plannedFor: '2026-08-08T23:00:00.000Z' },
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
    await db.prepare('UPDATE linkedin_seats SET paused_reason=? WHERE workspace_id=?').run('LinkedIn asked for a re-login', WORKSPACE_ID);
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

    // ...and the band is still a ceiling: 15/day in the warm-up band.
    for (let index = 0; index < 15; index += 1) await log('profile_view', 'sent', 1);
    const capped = await guard({ kind: 'profile_view' });
    expect(check(capped, 'warmup-ceiling').passed).toBe(false);
    expect(check(capped, 'rolling-24h').passed).toBe(false);
  });

  it('blocks the invite that would exceed the rolling 24h band', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 1);
    const verdict = await guard();
    expect(check(verdict, 'rolling-24h').passed).toBe(false);
    expect(check(verdict, 'rolling-24h').detail).toContain('18 of 18');
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

  it('counts exported actions, because from LinkedIn\'s side they are about to be real', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 18; index += 1) await log('invite', 'exported', 1);
    const verdict = await guard();
    expect(check(verdict, 'rolling-24h').passed).toBe(false);
  });

  it('does not count planned or skipped actions', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 18; index += 1) await log('invite', 'planned', 1);
    for (let index = 0; index < 18; index += 1) await log('invite', 'skipped', 1);
    const verdict = await guard();
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
  it('blocks a slot outside the seat\'s business hours', async () => {
    await seat('2026-01-01');
    const verdict = await guard({ plannedFor: '2026-08-06T22:00:00.000Z' });
    expect(check(verdict, 'business-hours').passed).toBe(false);
  });

  it('reads business hours in the SEAT\'s timezone, not the server\'s', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'Asia/Tokyo' }, new Date('2026-01-01T09:00:00.000Z'));
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
  it('enforces LinkedIn\'s published 50-a-month InMail quota', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 50; index += 1) await log('inmail', 'sent', 2 + index * 12);
    const verdict = await guard({ kind: 'inmail' });
    expect(check(verdict, 'inmail-monthly-quota').passed).toBe(false);
    expect(check(verdict, 'inmail-monthly-quota').detail).toContain('50 InMails');
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
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/known', status: 'sent', source: 'export' },
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
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/claimed', status: 'planned', source: 'export' },
      NOW
    );

    const blind = await guard({ targetRef: 'https://www.linkedin.com/in/claimed' });
    expect(check(blind, 'duplicate-target').passed).toBe(false);

    const aware = await evaluateLinkedInSafety(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/claimed', plannedFor: SLOT },
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
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/other', status: 'sent', source: 'export' },
      NOW
    );

    const verdict = await evaluateLinkedInSafety(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/other', plannedFor: SLOT },
      NOW,
      { excludeActionId: 'lact_not_the_one_in_the_ledger' }
    );
    expect(check(verdict, 'duplicate-target').passed).toBe(false);
    expect(verdict.allowed).toBe(false);
  });

  it('leaves the other twelve checks untouched when a row is excluded', async () => {
    await seat('2026-01-01');
    const claimed = await recordAction(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/late', status: 'planned', source: 'export' },
      NOW
    );
    // An excluded duplicate does not excuse a slot at 23:00 on a Saturday.
    const verdict = await evaluateLinkedInSafety(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/late', plannedFor: '2026-08-08T23:00:00.000Z' },
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
        { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: `stale-${index}`, status: 'sent', source: 'export' },
        new Date(NOW.getTime() - 200 * 86_400_000)
      );
    }

    const verdict = await guard({ kind: 'invite', targetRef: 'https://www.linkedin.com/in/new' });
    expect(check(verdict, 'pending-invite-backlog').passed).toBe(false);
    expect(check(verdict, 'pending-invite-backlog').detail).toContain(`of ${MAX_OUTSTANDING_INVITES}`);
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
        { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: `stale-${index}`, status: 'sent', source: 'export' },
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
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/known', status: 'accepted', source: 'export' },
      NOW
    );
    const verdict = await guard({ kind: 'dm', targetRef: 'https://www.linkedin.com/in/known' });
    expect(check(verdict, 'duplicate-target').passed).toBe(true);
  });
});
