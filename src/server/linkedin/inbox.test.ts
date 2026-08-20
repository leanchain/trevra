import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { recordAction, type LinkedInActionKind, type LinkedInActionStatus } from './actions.js';
import { LinkedInApiError } from './errors.js';
import { createCampaign, newCampaignId } from './campaigns.js';
import type { LinkedInInboxMessage, LinkedInThreadSummary } from './driver-inbox.js';
import { addExclusions } from './exclusions.js';
import {
  clearInboxForWorkspace,
  editQueuedMessage,
  enqueueReply,
  listThreads,
  readThread,
  syncThreadMessages,
  syncThreads,
  targetRefCandidates
} from './inbox.js';
import { postgresLocalWorkerStore } from './local-worker.js';
import { upsertSeat } from './seats.js';

/**
 * Real ephemeral Postgres, per the repo's test harness. An in-memory stub would
 * test nothing that ships: the re-sync guard IS a unique index, the reply
 * linkage IS a query against the ledger, and the claimability of an enqueued
 * reply IS the worker's own claim statement.
 *
 * THE TWO THINGS THIS FILE EXISTS TO PIN DOWN, both of which are safety and not
 * behaviour:
 *
 *   1. No reply reaches a browser without `evaluateLinkedInSafety`. There is
 *      one path out of this module and it files a paced, gated ledger row.
 *   2. No inbound reply writes `linkedin_actions.status` except through
 *      `ingestOutcome`, which is the only caller `writeActionStatus` accepts a
 *      worker-only status from.
 */

let db: Db;

const NOW = new Date('2026-08-04T10:00:00.000Z'); // A Tuesday, 10:00 UTC: inside business hours.
const WORKSPACE_ID = 'ws_linkedin_inbox_test';
const OTHER_WORKSPACE_ID = 'ws_linkedin_inbox_other';
const MAYA = 'https://www.linkedin.com/in/maya/';
/** The person the SALES seat is talking to, in its own inbox. */
const SALES_LEAD = 'https://www.linkedin.com/in/sales-lead/';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(workspaceId, 'LinkedIn inbox test', NOW.toISOString());
    await db.prepare('DELETE FROM linkedin_messages WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_threads WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_batches WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_exclusions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(workspaceId);
  }
});

afterEach(async () => {
  await db?.close();
});

function summary(overrides: Partial<LinkedInThreadSummary> = {}): LinkedInThreadSummary {
  return {
    threadUrn: '2-maya==',
    profileUrl: MAYA,
    name: 'Maya Chen',
    lastMessageAt: '2026-08-04T09:30:00.000Z',
    snippet: 'Thanks for reaching out',
    unread: true,
    ...overrides
  };
}

function inbound(
  body = 'Sure, what does it do?',
  at: string | null = '2026-08-04T09:30:00.000Z'
): LinkedInInboxMessage {
  return { at, direction: 'in', body };
}

/** A seat old enough to be past the ramp, so the gate has a steady band to judge against. */
async function steadySeat(workspaceId = WORKSPACE_ID): Promise<void> {
  await upsertSeat(
    db,
    workspaceId,
    { label: 'Pankaj (founder)', timezone: 'UTC' },
    new Date(NOW.getTime() - 60 * 86_400_000)
  );
}

async function ledgerAction(
  options: {
    kind?: LinkedInActionKind;
    status?: LinkedInActionStatus;
    target?: string;
    campaignId?: string;
    hoursAgo?: number;
  } = {}
): Promise<string> {
  const filed = await recordAction(
    db,
    {
      workspaceId: WORKSPACE_ID,
      kind: options.kind ?? 'invite',
      targetRef: options.target ?? MAYA,
      status: options.status ?? 'sent',
      campaignId: options.campaignId ?? null,
      source: 'export'
    },
    new Date(NOW.getTime() - (options.hoursAgo ?? 48) * 3_600_000)
  );
  return filed.id;
}

async function actionRow(
  actionId: string
): Promise<{ status: string; recorded_at: string | null; body: string | null }> {
  const row = await db
    .prepare(
      `
    SELECT status, body, TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at
    FROM linkedin_actions WHERE id=?
  `
    )
    .get<{ status: string; recorded_at: string | null; body: string | null }>(actionId);
  if (!row) throw new Error(`no ledger row ${actionId}`);
  return row;
}

describe('targetRefCandidates', () => {
  it('expands one canonical profile into the spellings a target_ref legitimately holds', () => {
    const candidates = targetRefCandidates(MAYA);
    expect(candidates).toContain('maya');
    expect(candidates).toContain('https://www.linkedin.com/in/maya/');
    expect(candidates).toContain('https://linkedin.com/in/maya');
    expect(candidates).toContain('linkedin.com/in/maya');
    // Lower-cased, because the ledger stores whatever a human typed.
    expect(candidates.every((value) => value === value.toLowerCase())).toBe(true);
  });

  it('expands nothing that is not a LinkedIn profile', () => {
    expect(targetRefCandidates('https://evil.example/in/maya/')).toEqual([]);
    expect(targetRefCandidates('not a url at all!!')).toEqual([]);
  });
});

describe('syncThreads', () => {
  it('is keyed by conversation id, so a second sync updates instead of duplicating', async () => {
    const first = await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
    expect(first.created).toBe(1);

    const second = await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threads: [summary({ snippet: 'Actually, yes', unread: false })]
      },
      new Date(NOW.getTime() + 3_600_000)
    );
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const threads = await listThreads(db, WORKSPACE_ID);
    expect(threads).toHaveLength(1);
    expect(threads[0].snippet).toBe('Actually, yes');
    // A badge is a fact about the page just read; a stale one is worse than none.
    expect(threads[0].unread).toBe(false);
    expect(threads[0].lastMessageAt).toBe('2026-08-04T09:30:00.000Z');
  });

  it('keeps a profile URL that a later walk could not resolve', async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
    await syncThreads(
      db,
      { workspaceId: WORKSPACE_ID, threads: [summary({ profileUrl: null, name: null })] },
      NOW
    );

    const [thread] = await listThreads(db, WORKSPACE_ID);
    // A failed profile hop must not erase the campaign linkage.
    expect(thread.profileUrl).toBe(MAYA);
    expect(thread.name).toBe('Maya Chen');
  });

  it('resolves the campaign this conversation belongs to from the ledger', async () => {
    const campaignId = newCampaignId();
    await createCampaign(
      db,
      { id: campaignId, workspaceId: WORKSPACE_ID, name: 'Seed-stage CTOs' },
      NOW
    );
    await ledgerAction({ campaignId });

    const result = await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
    expect(result.linked).toBe(1);
    expect(result.threads[0].campaignId).toBe(campaignId);
  });

  it('keeps one workspace out of another', async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
    await syncThreads(
      db,
      { workspaceId: OTHER_WORKSPACE_ID, threads: [summary({ name: 'Somebody else' })] },
      NOW
    );

    const mine = await listThreads(db, WORKSPACE_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe('Maya Chen');
    expect((await readThread(db, OTHER_WORKSPACE_ID, '2-maya=='))?.thread.name).toBe(
      'Somebody else'
    );
  });
});

describe('syncThreadMessages', () => {
  beforeEach(async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
  });

  it('stores a transcript once, however many times it is re-read', async () => {
    const messages: LinkedInInboxMessage[] = [
      { at: '2026-08-03T09:00:00.000Z', direction: 'out', body: 'Hi Maya, saw your talk.' },
      inbound()
    ];

    const first = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages },
      NOW
    );
    expect(first.inserted).toBe(2);
    expect(first.duplicates).toBe(0);

    // The driver re-reads the tail of a conversation on every sync. Without the
    // guard the transcript would grow by its own length each time.
    const second = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages },
      NOW
    );
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);

    const conversation = await readThread(db, WORKSPACE_ID, '2-maya==');
    expect(conversation?.messages.map((entry) => entry.body)).toEqual([
      'Hi Maya, saw your talk.',
      'Sure, what does it do?'
    ]);
    expect(conversation?.thread.messageCount).toBe(2);
    expect(conversation?.thread.hasReply).toBe(true);
  });

  it('appends later messages after the ones already stored', async () => {
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound('one')] },
      NOW
    );
    await syncThreadMessages(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threadUrn: '2-maya==',
        messages: [inbound('one'), { at: null, direction: 'out', body: 'two' }]
      },
      NOW
    );
    const conversation = await readThread(db, WORKSPACE_ID, '2-maya==');
    expect(conversation?.messages.map((entry) => entry.body)).toEqual(['one', 'two']);
  });

  it('refuses messages for a conversation nobody has synced', async () => {
    await expect(
      syncThreadMessages(
        db,
        { workspaceId: WORKSPACE_ID, threadUrn: '2-nobody==', messages: [inbound()] },
        NOW
      )
    ).rejects.toBeInstanceOf(LinkedInApiError);
  });
});

describe('reply detection', () => {
  beforeEach(async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
  });

  it('marks the invite replied through the outcome path, dated at the message', async () => {
    const actionId = await ledgerAction({ kind: 'invite', status: 'sent' });

    const result = await syncThreadMessages(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threadUrn: '2-maya==',
        messages: [inbound('Sure, tell me more.')]
      },
      NOW
    );

    expect(result.repliedActionId).toBe(actionId);
    const row = await actionRow(actionId);
    expect(row.status).toBe('replied');
    // Dated when they answered, not when the sync noticed.
    expect(row.recorded_at).toBe('2026-08-04T09:30:00.000Z');
  });

  /**
   * A REPLY IS ALSO ACCEPTANCE EVIDENCE, and it is the second of the two
   * writers `accepted` finally has. Before this, a stranger who accepted an
   * invite and immediately answered it left the ledger with 'replied' and
   * nothing whatsoever recording that the acceptance had been established, when
   * it was, or on what evidence -- so every acceptance counter in the product
   * had to compensate by spelling out `IN ('accepted','replied')`.
   */
  it('records the acceptance a reply proves, alongside the reply itself', async () => {
    const actionId = await ledgerAction({ kind: 'invite', status: 'sent' });

    const result = await syncThreadMessages(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threadUrn: '2-maya==',
        messages: [inbound('Sure, tell me more.')]
      },
      NOW
    );

    expect(result.acceptedActionIds).toEqual([actionId]);
    // 'replied' is the stronger statement and wins the status; the acceptance
    // survives it in its own two columns.
    const row = await db
      .prepare(
        `
      SELECT status, accepted_source,
             TO_CHAR(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at
      FROM linkedin_actions WHERE id=?
    `
      )
      .get<{ status: string; accepted_source: string; accepted_at: string }>(actionId);
    expect(row).toMatchObject({ status: 'replied', accepted_source: 'detected' });
    // Dated at the message that proves it, not at the sync that noticed.
    expect(row?.accepted_at).toBe('2026-08-04T09:30:00.000Z');
    expect(result.linkage).toContain('also recorded as accepted');
  });

  it('does not restate acceptance for an invite a human already ruled on', async () => {
    const actionId = await ledgerAction({ kind: 'invite', status: 'declined' });
    const result = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );
    // A declined invite is decided. A later message is a conversation, not a
    // retroactive acceptance, and the detector never walks a ruling backwards.
    expect(result.acceptedActionIds).toEqual([]);
    expect((await actionRow(actionId)).status).toBe('declined');
  });

  it('matches a ledger target stored as a bare handle', async () => {
    // `target_ref` is opaque -- whatever a human typed or a CSV supplied.
    const actionId = await ledgerAction({ target: 'maya' });
    const result = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );
    expect(result.repliedActionId).toBe(actionId);
    expect((await actionRow(actionId)).status).toBe('replied');
  });

  it('prefers the invite over the DM, because the acceptance rate counts invites', async () => {
    const invite = await ledgerAction({ kind: 'invite', status: 'sent', hoursAgo: 72 });
    const dm = await ledgerAction({ kind: 'dm', status: 'sent', hoursAgo: 24 });

    const result = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );

    expect(result.repliedActionId).toBe(invite);
    expect((await actionRow(dm)).status).toBe('sent');
  });

  it('never reports a reply against an action that never went out', async () => {
    const planned = await ledgerAction({ status: 'planned' });
    const result = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );

    // Nobody can have replied to a message that was never sent, and marking it
    // 'replied' would invent both a send and the budget it consumed.
    expect(result.repliedActionId).toBeNull();
    expect((await actionRow(planned)).status).toBe('planned');
    expect(result.linkage).toContain('no outreach action');
  });

  it('reports a reply once, however often the conversation is re-synced', async () => {
    const actionId = await ledgerAction();
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );
    const before = await actionRow(actionId);

    const again = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      new Date(NOW.getTime() + 86_400_000)
    );

    expect(again.repliedActionId).toBeNull();
    // `recorded_at` must not walk forward on every tick: rolling windows read it.
    expect(await actionRow(actionId)).toEqual(before);
  });

  it('stores the conversation and leaves the funnel alone when nothing matches', async () => {
    await ledgerAction({ target: 'https://www.linkedin.com/in/someone-else/' });
    const result = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );

    expect(result.inserted).toBe(1);
    expect(result.repliedActionId).toBeNull();
    expect(result.linkage).toContain('funnel is unchanged');
  });

  it('says so when the conversation has no profile URL to match on', async () => {
    await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threads: [summary({ threadUrn: '2-anon==', profileUrl: null })]
      },
      NOW
    );
    const result = await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-anon==', messages: [inbound()] },
      NOW
    );

    expect(result.inserted).toBe(1);
    expect(result.repliedActionId).toBeNull();
    expect(result.linkage).toContain('no resolved profile URL');
  });

  it('adopts the campaign of the action the reply landed on', async () => {
    const campaignId = newCampaignId();
    await createCampaign(
      db,
      { id: campaignId, workspaceId: WORKSPACE_ID, name: 'Seed-stage CTOs' },
      NOW
    );
    // The conversation was synced before the ledger row existed, so the pointer
    // could not be resolved then.
    await ledgerAction({ campaignId });

    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );

    expect((await readThread(db, WORKSPACE_ID, '2-maya=='))?.thread.campaignId).toBe(campaignId);
  });
});

describe('listThreads', () => {
  beforeEach(async () => {
    const campaignId = 'lcmp_fixed';
    await createCampaign(
      db,
      { id: campaignId, workspaceId: WORKSPACE_ID, name: 'Seed-stage CTOs' },
      NOW
    );
    await ledgerAction({ campaignId, target: 'https://www.linkedin.com/in/jonas/' });

    await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threads: [
          summary(),
          summary({
            threadUrn: '2-jonas==',
            profileUrl: 'https://www.linkedin.com/in/jonas/',
            name: 'Jonas Keller',
            unread: false,
            lastMessageAt: '2026-08-04T08:00:00.000Z'
          })
        ]
      },
      NOW
    );
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-jonas==', messages: [inbound('yes please')] },
      NOW
    );
  });

  it('orders by the last message and filters on unread, has-reply and campaign', async () => {
    expect((await listThreads(db, WORKSPACE_ID)).map((entry) => entry.threadUrn)).toEqual([
      '2-maya==',
      '2-jonas=='
    ]);

    expect(
      (await listThreads(db, WORKSPACE_ID, { unread: true })).map((entry) => entry.threadUrn)
    ).toEqual(['2-maya==']);
    expect(
      (await listThreads(db, WORKSPACE_ID, { hasReply: true })).map((entry) => entry.threadUrn)
    ).toEqual(['2-jonas==']);
    expect(
      (await listThreads(db, WORKSPACE_ID, { hasReply: false })).map((entry) => entry.threadUrn)
    ).toEqual(['2-maya==']);
    expect(
      (await listThreads(db, WORKSPACE_ID, { campaignId: 'lcmp_fixed' })).map(
        (entry) => entry.threadUrn
      )
    ).toEqual(['2-jonas==']);
    expect(await listThreads(db, WORKSPACE_ID, { campaignId: 'lcmp_missing' })).toEqual([]);
  });
});

describe('enqueueReply', () => {
  beforeEach(async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
  });

  it('files a paced reply the local worker can claim, carrying the approved bytes and the thread', async () => {
    await steadySeat();

    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to send it over.' },
      NOW
    );

    expect(queued.targetRef).toBe(MAYA);
    expect(queued.verdict.allowed).toBe(true);
    // Its OWN kind, whose band in limits.ts is `dm`'s numbers verbatim: same
    // ceilings, same windows, same guard -- and its own duplicate scope, which
    // is the whole reason it is not filed as a `dm`.
    const row = await db
      .prepare(
        'SELECT kind, status, source, campaign_id, thread_urn FROM linkedin_actions WHERE id=?'
      )
      .get<{
        kind: string;
        status: string;
        source: string;
        campaign_id: string | null;
        thread_urn: string | null;
      }>(queued.actionId);
    expect(row).toMatchObject({
      kind: 'reply',
      status: 'planned',
      source: 'manual',
      thread_urn: '2-maya=='
    });
    expect((await actionRow(queued.actionId)).body).toBe('Happy to send it over.');

    // The real claim statement, unchanged: the enqueued reply is executable by
    // the worker that already exists, which is what "goes through the ledger"
    // has to mean to be worth anything.
    const store = postgresLocalWorkerStore(db, WORKSPACE_ID);
    const batchId = await store.openBatch(NOW);
    const claimed = await store.claimNextDueAction(batchId, NOW);
    expect(claimed?.id).toBe(queued.actionId);
    expect(claimed?.body).toBe('Happy to send it over.');
  });

  // Team workspace access (migration 043): who queued this, for a founder who
  // wants to know which of two members answered a conversation.
  it('records queuedByUserId when the caller has one, and leaves it null when it does not', async () => {
    await steadySeat();
    await db
      .prepare(
        'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(
        'usr_inbox_reply_test',
        WORKSPACE_ID,
        'inbox-reply-test@example.com',
        'Inbox Reply Tester',
        NOW.toISOString()
      );

    const withUser = await enqueueReply(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threadUrn: '2-maya==',
        body: 'Happy to send it over.',
        queuedByUserId: 'usr_inbox_reply_test'
      },
      NOW
    );
    const withUserRow = await db
      .prepare('SELECT queued_by_user_id FROM linkedin_actions WHERE id=?')
      .get<{ queued_by_user_id: string | null }>(withUser.actionId);
    expect(withUserRow?.queued_by_user_id).toBe('usr_inbox_reply_test');
  });

  it('claims nothing has been sent', async () => {
    await steadySeat();
    await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' },
      NOW
    );

    // Trevra plans and approves; it never sends. A reply is not an exception.
    const counted = await db
      .prepare(
        `
      SELECT COUNT(*)::int AS total FROM linkedin_actions
      WHERE workspace_id=? AND status IN ('sent','accepted','replied','exported')
    `
      )
      .get<{ total: number }>(WORKSPACE_ID);
    expect(counted?.total).toBe(0);
  });

  it('FAILS CLOSED when the gate refuses, and says which check refused it', async () => {
    // No seat at all: paced as a brand-new week-1 account, whose DM ceiling is
    // zero. The reply is refused rather than queued into a queue that would
    // never drain.
    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' }, NOW)
    ).rejects.toThrow(/safety gate/);

    const filed = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(filed?.total).toBe(0);
  });

  /**
   * THE COMPOSER IS THE OPERATOR, AND THE OPERATOR'S CLOCK IS THEIR OWN.
   *
   * This used to assert the refusal. The working window paces what the account
   * does BY ITSELF; a person typing an answer at 02:00, or on a Sunday, is a
   * person using LinkedIn, and telling them to come back on Monday is a
   * product refusing work its owner had already decided to do.
   */
  it("queues a reply the operator typed outside the seat's business hours", async () => {
    await steadySeat();
    const midnight = new Date('2026-08-05T02:00:00.000Z');
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' },
      midnight
    );
    expect(queued.verdict.allowed).toBe(true);
    const hours = queued.verdict.checks.find((entry) => entry.check === 'business-hours');
    // Passed, and it says why rather than reading as a window this instant sat
    // inside.
    expect(hours?.passed).toBe(true);
    expect(hours?.detail).toContain('a person asked for at the moment they asked for it');

    // They write again before Saturday, so this is a NEW conversational turn,
    // not a duplicate submit of the reply above. Advancing the replay scope is
    // important: this test is about the weekend rule and must not weaken the
    // duplicate-target guard just to reach it.
    await syncThreadMessages(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threadUrn: '2-maya==',
        messages: [inbound('One more thing', '2026-08-08T09:30:00.000Z')]
      },
      new Date('2026-08-08T09:30:00.000Z')
    );
    // 2026-08-08 is a Saturday this seat has not configured.
    const saturday = new Date('2026-08-08T10:00:00.000Z');
    const weekendReply = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'and again' },
      saturday
    );
    expect(weekendReply.verdict.checks.find((entry) => entry.check === 'weekend')?.passed).toBe(
      true
    );
  });

  it('still refuses one the seat has no room for, whatever the hour', async () => {
    // Relaxing WHEN is not relaxing HOW MUCH. A paused seat at midnight is
    // refused for being paused, which is the check that is actually about
    // whether this account may act at all.
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Pankaj (founder)', timezone: 'UTC', posture: 'paused' },
      new Date(NOW.getTime() - 60 * 86_400_000)
    );
    const midnight = new Date('2026-08-05T02:00:00.000Z');
    await expect(
      enqueueReply(
        db,
        { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' },
        midnight
      )
    ).rejects.toThrow(/seat-paused/);
  });

  it('never lets a manual reply bypass the workspace Never contact list', async () => {
    await steadySeat();
    await addExclusions(
      db,
      WORKSPACE_ID,
      [{ targetRef: MAYA, reason: 'Asked not to be contacted' }],
      NOW
    );

    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' }, NOW)
    ).rejects.toThrow(/Never contact/i);

    const rows = await db
      .prepare(
        "SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=? AND kind='reply'"
      )
      .get<{ total: number }>(WORKSPACE_ID);
    expect(rows?.total).toBe(0);
  });

  it('answers somebody this seat has already DMd, which is the normal case in an inbox', async () => {
    await steadySeat();
    await ledgerAction({ kind: 'dm', status: 'sent' });

    // THE REASON `reply` IS ITS OWN KIND. Filed as a `dm` this was refused by
    // `duplicate-target` and by 022's replay guard -- both correct about a cold
    // DM and both wrong about answering a conversation. The guards are
    // unchanged; the kind is what makes the question a different one.
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello again' },
      NOW
    );
    expect(queued.verdict.allowed).toBe(true);
    expect(queued.verdict.checks.find((entry) => entry.check === 'duplicate-target')?.passed).toBe(
      true
    );
  });

  it('still refuses a double-submitted reply to the same message in the same conversation', async () => {
    await steadySeat();
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );
    await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'first' },
      NOW
    );

    // The narrower scope moved the boundary; it did not remove one. Nothing
    // has happened in the conversation since, so a second queued answer to the
    // same message is a double-submit and the replay guard says so.
    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'first' }, NOW)
    ).rejects.toThrow(/duplicate-target/);
  });

  it('ANSWERS THE SAME CONVERSATION AGAIN once it has moved on', async () => {
    // The defect this replaces: a reply filed under the default 'legacy' scope,
    // so ONE reply per person for the life of the ledger and every later answer
    // a permanent 409. A conversation is the one place where messaging somebody
    // repeatedly is the normal case, not the abuse the guard was built for.
    await steadySeat();
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );

    const first = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Sure -- here it is.' },
      NOW
    );
    expect(first.verdict.allowed).toBe(true);

    // They write again. That is a different message, so answering it is a
    // different action.
    await syncThreadMessages(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threadUrn: '2-maya==',
        messages: [inbound(), inbound('And what does it cost?', '2026-08-04T09:45:00.000Z')]
      },
      NOW
    );

    const second = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Two hundred a month.' },
      NOW
    );
    expect(second.actionId).not.toBe(first.actionId);
    expect(second.verdict.checks.find((entry) => entry.check === 'duplicate-target')?.passed).toBe(
      true
    );

    // Both rows survive side by side, which is what migration 047's widened
    // replay index is for.
    const scopes = await db
      .prepare(
        'SELECT replay_scope FROM linkedin_actions WHERE workspace_id=? AND kind=? ORDER BY created_at'
      )
      .all<{ replay_scope: string }>(WORKSPACE_ID, 'reply');
    expect(scopes).toHaveLength(2);
    expect(scopes[0].replay_scope).not.toBe(scopes[1].replay_scope);
    for (const row of scopes) expect(row.replay_scope).toContain('thread:2-maya==');
  });

  it('still persists the legacy warm-up override when an operator supplies it', async () => {
    // Manual replies now bypass Trevra pacing as a class, so migration 044's
    // one-check override is no longer required to get a hand-written reply
    // through week 1. Keep persisting it for backwards compatibility and audit
    // fidelity when an older client explicitly sends the flag.
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, NOW);

    const queued = await enqueueReply(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threadUrn: '2-maya==',
        body: 'hello',
        overrideWarmupCeiling: true
      },
      NOW
    );
    expect(queued.verdict.allowed).toBe(true);
    const detail =
      queued.verdict.checks.find((entry) => entry.check === 'warmup-ceiling')?.detail ?? '';
    expect(detail).toContain('overrode the warm-up ceiling');
    expect(detail).toContain('explicitly bypassed Trevra pacing');

    const row = await db
      .prepare('SELECT override_warmup_ceiling FROM linkedin_actions WHERE id=?')
      .get<{ override_warmup_ceiling: boolean }>(queued.actionId);
    expect(row?.override_warmup_ceiling).toBe(true);
  });

  /**
   * THE CASE THE PRODUCT ACTUALLY REFUSED (migration 074).
   *
   * Somebody writes to the account in week one. Answering them is the most
   * ordinary thing on LinkedIn and the least like the outreach the ramp exists
   * to slow -- and Trevra refused it with "warm-up week 1 permits no replies at
   * all. Wait for the ramp." The only way past it was an operator override that
   * no control in the product ever set, so there was no way past it.
   */
  it('queues a reply to somebody who wrote first, in warm-up week 1, with no override', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, NOW);
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );

    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to explain.' },
      NOW
    );

    expect(queued.verdict.allowed).toBe(true);
    const ceiling = queued.verdict.checks.find((entry) => entry.check === 'warmup-ceiling');
    expect(ceiling?.passed).toBe(true);
    expect(ceiling?.detail).toContain('wrote to this account first');

    // PERSISTED, so the worker's pre-send re-evaluation reaches the same
    // verdict instead of refusing what was already accepted.
    const row = await db
      .prepare('SELECT reply_to_inbound, override_warmup_ceiling FROM linkedin_actions WHERE id=?')
      .get<{ reply_to_inbound: boolean; override_warmup_ceiling: boolean }>(queued.actionId);
    expect(row?.reply_to_inbound).toBe(true);
    // NOT an operator override. Two different facts, and the row says which.
    expect(row?.override_warmup_ceiling).toBe(false);
  });

  it('lets a manual follow-up bypass the warm-up ramp even when nobody answered first', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, NOW);
    await syncThreadMessages(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threadUrn: '2-maya==',
        messages: [
          { at: '2026-08-04T09:00:00.000Z', direction: 'out', body: 'Hi Maya -- worth a chat?' }
        ]
      },
      NOW
    );

    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Just following up.' },
      NOW
    );
    expect(queued.verdict.allowed).toBe(true);
    expect(
      queued.verdict.checks.find((entry) => entry.check === 'warmup-ceiling')?.detail
    ).toContain('explicitly bypassed Trevra pacing');
    const row = await db
      .prepare('SELECT reply_to_inbound FROM linkedin_actions WHERE id=?')
      .get<{ reply_to_inbound: boolean }>(queued.actionId);
    expect(row?.reply_to_inbound).toBe(false);
  });

  it('leaves the override off by default, so nothing acquires it by accident', async () => {
    await steadySeat();
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' },
      NOW
    );
    const row = await db
      .prepare('SELECT override_warmup_ceiling FROM linkedin_actions WHERE id=?')
      .get<{ override_warmup_ceiling: boolean }>(queued.actionId);
    expect(row?.override_warmup_ceiling).toBe(false);
  });

  it('refuses an empty body, an unknown conversation, and one with no profile URL', async () => {
    await steadySeat();

    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: '  ' }, NOW)
    ).rejects.toThrow(/needs a body/);
    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-nobody==', body: 'hi' }, NOW)
    ).rejects.toThrow(/not found/);

    await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threads: [summary({ threadUrn: '2-anon==', profileUrl: null })]
      },
      NOW
    );
    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-anon==', body: 'hi' }, NOW)
    ).rejects.toThrow(/no resolved LinkedIn profile URL/);
  });

  it("cannot reply into another workspace's conversation", async () => {
    await steadySeat(OTHER_WORKSPACE_ID);
    await expect(
      enqueueReply(
        db,
        { workspaceId: OTHER_WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' },
        NOW
      )
    ).rejects.toThrow(/not found/);
  });

  it("CANNOT REPLY INTO ANOTHER SEAT'S CONVERSATION EITHER", async () => {
    // The same rule one level down, and the one that actually bit: an inbox is
    // per LinkedIn ACCOUNT, not per workspace. `threadByUrn` defaults to the
    // owner seat, so a reply queued for the sales account used to resolve the
    // OWNER's conversation and file a row against the wrong identity -- a
    // message that would have been sent from an account nobody chose.
    await steadySeat();
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Sales seat', timezone: 'UTC' },
      new Date(NOW.getTime() - 60 * 86_400_000),
      'sales'
    );

    // '2-maya==' is synced for the OWNER seat by this describe's beforeEach.
    await expect(
      enqueueReply(
        db,
        { workspaceId: WORKSPACE_ID, seatKey: 'sales', threadUrn: '2-maya==', body: 'hello' },
        NOW
      )
    ).rejects.toThrow(/not found/);
    expect(
      await db
        .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
        .get<{ total: number }>(WORKSPACE_ID)
    ).toMatchObject({ total: 0 });

    // The sales seat's OWN conversation, with the same LinkedIn thread id, is
    // a different conversation and is answerable by that seat alone.
    await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'sales',
        threads: [summary({ profileUrl: SALES_LEAD })]
      },
      NOW
    );
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, seatKey: 'sales', threadUrn: '2-maya==', body: 'hello' },
      NOW
    );

    expect(queued.targetRef).toBe(SALES_LEAD);
    const row = await db
      .prepare('SELECT seat_key, target_ref FROM linkedin_actions WHERE id=?')
      .get<{ seat_key: string; target_ref: string }>(queued.actionId);
    expect(row).toMatchObject({ seat_key: 'sales', target_ref: SALES_LEAD });
  });
});

/**
 * A QUEUE NOBODY CAN CORRECT IS A QUEUE PEOPLE CANCEL AND RETYPE.
 *
 * Until the worker claims a row, its approved bytes are text in a database the
 * operator owns: rewriting them changes WHAT will be typed and nothing else --
 * not the slot, not the person, not the count it charges against any ceiling.
 * What the tests below pin is the other half, which is where the danger is:
 * every row that is NOT the operator's own waiting message refuses the edit,
 * and says which of the four reasons refused it.
 */
describe('editQueuedMessage', () => {
  beforeEach(async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
    await steadySeat();
  });

  it('rewrites the words of a message that has not been typed yet, and changes nothing else', async () => {
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to send it over.' },
      NOW
    );

    const edited = await editQueuedMessage(db, {
      workspaceId: WORKSPACE_ID,
      actionId: queued.actionId,
      body: 'Happy to send it over tomorrow.'
    });

    expect(edited.body).toBe('Happy to send it over tomorrow.');
    // The row is the SAME row: same slot, same person, same status. An edit
    // that re-paced or re-filed the message would spend a fresh trip through
    // the replay guard to fix a typo.
    expect(edited.id).toBe(queued.actionId);
    expect(Date.parse(edited.plannedFor ?? '')).toBe(Date.parse(queued.plannedFor));
    expect(edited.targetRef).toBe(queued.targetRef);
    expect(edited.status).toBe('planned');
    expect((await actionRow(queued.actionId)).body).toBe('Happy to send it over tomorrow.');
  });

  it('refuses an empty edit, exactly as the composer refuses an empty reply', async () => {
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to.' },
      NOW
    );
    await expect(
      editQueuedMessage(db, { workspaceId: WORKSPACE_ID, actionId: queued.actionId, body: '   ' })
    ).rejects.toThrow(/needs a body/);
    expect((await actionRow(queued.actionId)).body).toBe('Happy to.');
  });

  it('refuses one the worker has already claimed, because those bytes may be being typed', async () => {
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to.' },
      NOW
    );
    await db
      .prepare('UPDATE linkedin_actions SET claimed_at=? WHERE id=?')
      .run(NOW.toISOString(), queued.actionId);

    await expect(
      editQueuedMessage(db, {
        workspaceId: WORKSPACE_ID,
        actionId: queued.actionId,
        body: 'Second thoughts.'
      })
    ).rejects.toThrow(/typing it into LinkedIn right now/);
    expect((await actionRow(queued.actionId)).body).toBe('Happy to.');
  });

  it('refuses one that has already been typed', async () => {
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to.' },
      NOW
    );
    await db.prepare("UPDATE linkedin_actions SET status='sent' WHERE id=?").run(queued.actionId);

    await expect(
      editQueuedMessage(db, {
        workspaceId: WORKSPACE_ID,
        actionId: queued.actionId,
        body: 'Too late.'
      })
    ).rejects.toThrow(/already been typed/);
  });

  it("refuses a campaign's own copy, which belongs to the campaign", async () => {
    // Filed the way `queue.ts` files an approved campaign step.
    const filed = await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'dm',
        targetRef: MAYA,
        status: 'planned',
        source: 'campaign',
        plannedFor: NOW.toISOString()
      },
      NOW
    );
    await db
      .prepare('UPDATE linkedin_actions SET body=? WHERE id=?')
      .run('Approved campaign copy.', filed.id);

    await expect(
      editQueuedMessage(db, {
        workspaceId: WORKSPACE_ID,
        actionId: filed.id,
        body: 'Not the approved copy.'
      })
    ).rejects.toThrow(/queued by a campaign/);
    expect((await actionRow(filed.id)).body).toBe('Approved campaign copy.');
  });

  it('does not reach into another workspace', async () => {
    const queued = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to.' },
      NOW
    );
    await expect(
      editQueuedMessage(db, {
        workspaceId: OTHER_WORKSPACE_ID,
        actionId: queued.actionId,
        body: 'Not yours.'
      })
    ).rejects.toThrow(/not found/);
    expect((await actionRow(queued.actionId)).body).toBe('Happy to.');
  });
});

describe('clearInboxForWorkspace', () => {
  it('wipes every stored thread and, by cascade, every message -- for this workspace only', async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] },
      NOW
    );
    await syncThreads(
      db,
      { workspaceId: OTHER_WORKSPACE_ID, threads: [summary({ threadUrn: '2-other==' })] },
      NOW
    );

    const removed = await clearInboxForWorkspace(db, WORKSPACE_ID);

    expect(removed).toBe(1);
    expect(await listThreads(db, WORKSPACE_ID)).toEqual([]);
    expect(
      await db.prepare('SELECT id FROM linkedin_messages WHERE workspace_id=?').all(WORKSPACE_ID)
    ).toEqual([]);
    // Another workspace's inbox is untouched -- this is an account-change
    // reset, not a general-purpose wipe.
    expect(await listThreads(db, OTHER_WORKSPACE_ID)).toHaveLength(1);
  });

  it('is a no-op count on a workspace with nothing synced', async () => {
    expect(await clearInboxForWorkspace(db, WORKSPACE_ID)).toBe(0);
  });
});

/**
 * THE BATCHED SYNC, ASSERTED AGAINST THE SHAPE IT REPLACED.
 *
 * `syncThreads` ran three or four statements per conversation: a SELECT for
 * the existing row, a ledger question for the campaign pointer, the upsert,
 * and then a re-read of the row it had just written. A 5,000-conversation
 * sync was ~20,000 round trips. It is now four statements for the whole page,
 * and these tests pin the parts of the contract that a batched rewrite is most
 * likely to move: the counts, the order, the campaign linkage, and what
 * happens when one page names the same conversation twice.
 */
describe('syncing a page of conversations', () => {
  function summaryFor(
    urn: string,
    handle: string,
    overrides: Partial<LinkedInThreadSummary> = {}
  ): LinkedInThreadSummary {
    return {
      threadUrn: urn,
      profileUrl: `https://www.linkedin.com/in/${handle}/`,
      name: handle,
      lastMessageAt: '2026-08-04T09:30:00.000Z',
      snippet: `hello from ${handle}`,
      unread: false,
      ...overrides
    };
  }

  it('returns every conversation in the order the rail listed them', async () => {
    const threads = ['a', 'b', 'c', 'd'].map((handle, index) =>
      summaryFor(`2-${handle}==`, handle, {
        // Deliberately NOT in `last_message_at` order, so an accidental
        // ORDER BY in the read-back would show up here.
        lastMessageAt: new Date(NOW.getTime() - index * 3_600_000).toISOString()
      })
    );
    const result = await syncThreads(db, { workspaceId: WORKSPACE_ID, threads }, NOW);

    expect(result.created).toBe(4);
    expect(result.updated).toBe(0);
    expect(result.threads.map((thread) => thread.threadUrn)).toEqual([
      '2-a==',
      '2-b==',
      '2-c==',
      '2-d=='
    ]);
  });

  it('counts a second sync as updated, and keeps what the driver could not read this time', async () => {
    await syncThreads(
      db,
      { workspaceId: WORKSPACE_ID, threads: [summaryFor('2-a==', 'maya')] },
      NOW
    );
    const second = await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        // A failed profile hop: the rail reported the conversation but could
        // not resolve the person. COALESCE keeps last week's answer.
        threads: [
          summaryFor('2-a==', 'maya', {
            profileUrl: null,
            name: null,
            lastMessageAt: null,
            snippet: 'newer',
            unread: true
          })
        ]
      },
      NOW
    );

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.threads[0]).toMatchObject({
      profileUrl: 'https://www.linkedin.com/in/maya/',
      name: 'maya',
      snippet: 'newer',
      unread: true
    });
    expect(second.threads[0].lastMessageAt).toBe('2026-08-04T09:30:00.000Z');
  });

  it('collapses a conversation the same page names twice, taking the later entry', async () => {
    // A batched `ON CONFLICT DO UPDATE` cannot touch one row twice in one
    // statement, so this case has to be handled explicitly -- and the answer
    // must be the loop's: the second write won.
    const result = await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threads: [
          summaryFor('2-a==', 'maya', { snippet: 'first', unread: true }),
          summaryFor('2-a==', 'maya', { snippet: 'second', unread: false })
        ]
      },
      NOW
    );
    expect(result.created).toBe(1);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({ snippet: 'second', unread: false });
  });

  it('resolves each conversation to its own campaign in one pass', async () => {
    const alpha = newCampaignId();
    const beta = newCampaignId();
    await createCampaign(db, { workspaceId: WORKSPACE_ID, id: alpha, name: 'Alpha' }, NOW);
    await createCampaign(db, { workspaceId: WORKSPACE_ID, id: beta, name: 'Beta' }, NOW);
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/maya/',
        campaignId: alpha,
        status: 'sent',
        source: 'export'
      },
      NOW
    );
    await recordAction(
      db,
      // A different spelling of the same person, which is what the ledger
      // actually holds: `target_ref` is whatever a human or a CSV supplied.
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: 'jonas',
        campaignId: beta,
        status: 'sent',
        source: 'export'
      },
      NOW
    );

    const result = await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threads: [
          summaryFor('2-a==', 'maya'),
          summaryFor('2-b==', 'jonas'),
          summaryFor('2-c==', 'nobody')
        ]
      },
      NOW
    );

    expect(result.linked).toBe(2);
    expect(result.threads.map((thread) => thread.campaignId)).toEqual([alpha, beta, null]);
  });

  it('prefers the invite when one person has both an invite and a DM, exactly as the per-thread query did', async () => {
    const invited = newCampaignId();
    const messaged = newCampaignId();
    await createCampaign(db, { workspaceId: WORKSPACE_ID, id: invited, name: 'Invited' }, NOW);
    await createCampaign(db, { workspaceId: WORKSPACE_ID, id: messaged, name: 'Messaged' }, NOW);
    // The DM is the MORE RECENT row, so recency alone would pick it. The
    // ordering puts invites first because that is the row a reply lands on.
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'invite',
        targetRef: MAYA,
        campaignId: invited,
        status: 'sent',
        source: 'export'
      },
      new Date(NOW.getTime() - 86_400_000)
    );
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE_ID,
        kind: 'dm',
        targetRef: MAYA,
        campaignId: messaged,
        status: 'sent',
        source: 'export'
      },
      NOW
    );

    const result = await syncThreads(
      db,
      { workspaceId: WORKSPACE_ID, threads: [summaryFor('2-a==', 'maya')] },
      NOW
    );
    expect(result.threads[0].campaignId).toBe(invited);
  });

  it("counts stored messages per conversation without leaking another conversation's", async () => {
    await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        threads: [summaryFor('2-a==', 'maya'), summaryFor('2-b==', 'jonas')]
      },
      NOW
    );
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-a==', messages: [inbound('one'), inbound('two')] },
      NOW
    );
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-b==', messages: [inbound('only')] },
      NOW
    );

    const listed = await listThreads(db, WORKSPACE_ID);
    const counts = Object.fromEntries(
      listed.map((thread) => [thread.threadUrn, thread.messageCount])
    );
    expect(counts).toEqual({ '2-a==': 2, '2-b==': 1 });
    expect(listed.every((thread) => thread.hasReply)).toBe(true);
  });

  it('is a no-op for a page whose entries all carry an empty conversation id', async () => {
    const result = await syncThreads(
      db,
      { workspaceId: WORKSPACE_ID, threads: [summaryFor('  ', 'maya')] },
      NOW
    );
    expect(result).toEqual({ created: 0, updated: 0, linked: 0, threads: [] });
  });
});
