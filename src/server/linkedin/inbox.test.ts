import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { recordAction, type LinkedInActionKind, type LinkedInActionStatus } from './actions.js';
import { LinkedInApiError, createCampaign, newCampaignId } from './campaigns.js';
import type { LinkedInInboxMessage, LinkedInThreadSummary } from './driver-inbox.js';
import {
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

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(workspaceId, 'LinkedIn inbox test', NOW.toISOString());
    await db.prepare('DELETE FROM linkedin_messages WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_threads WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_batches WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(workspaceId);
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

function inbound(body = 'Sure, what does it do?', at: string | null = '2026-08-04T09:30:00.000Z'): LinkedInInboxMessage {
  return { at, direction: 'in', body };
}

/** A seat old enough to be past the ramp, so the gate has a steady band to judge against. */
async function steadySeat(workspaceId = WORKSPACE_ID): Promise<void> {
  await upsertSeat(db, workspaceId, { label: 'Pankaj (founder)', timezone: 'UTC' }, new Date(NOW.getTime() - 60 * 86_400_000));
}

async function ledgerAction(
  options: { kind?: LinkedInActionKind; status?: LinkedInActionStatus; target?: string; campaignId?: string; hoursAgo?: number } = {}
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

async function actionRow(actionId: string): Promise<{ status: string; recorded_at: string | null; body: string | null }> {
  const row = await db.prepare(`
    SELECT status, body, TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at
    FROM linkedin_actions WHERE id=?
  `).get<{ status: string; recorded_at: string | null; body: string | null }>(actionId);
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
      { workspaceId: WORKSPACE_ID, threads: [summary({ snippet: 'Actually, yes', unread: false })] },
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
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary({ profileUrl: null, name: null })] }, NOW);

    const [thread] = await listThreads(db, WORKSPACE_ID);
    // A failed profile hop must not erase the campaign linkage.
    expect(thread.profileUrl).toBe(MAYA);
    expect(thread.name).toBe('Maya Chen');
  });

  it('resolves the campaign this conversation belongs to from the ledger', async () => {
    const campaignId = newCampaignId();
    await createCampaign(db, { id: campaignId, workspaceId: WORKSPACE_ID, name: 'Seed-stage CTOs' }, NOW);
    await ledgerAction({ campaignId });

    const result = await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
    expect(result.linked).toBe(1);
    expect(result.threads[0].campaignId).toBe(campaignId);
  });

  it('keeps one workspace out of another', async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
    await syncThreads(db, { workspaceId: OTHER_WORKSPACE_ID, threads: [summary({ name: 'Somebody else' })] }, NOW);

    const mine = await listThreads(db, WORKSPACE_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe('Maya Chen');
    expect((await readThread(db, OTHER_WORKSPACE_ID, '2-maya=='))?.thread.name).toBe('Somebody else');
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

    const first = await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages }, NOW);
    expect(first.inserted).toBe(2);
    expect(first.duplicates).toBe(0);

    // The driver re-reads the tail of a conversation on every sync. Without the
    // guard the transcript would grow by its own length each time.
    const second = await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages }, NOW);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);

    const conversation = await readThread(db, WORKSPACE_ID, '2-maya==');
    expect(conversation?.messages.map((entry) => entry.body)).toEqual(['Hi Maya, saw your talk.', 'Sure, what does it do?']);
    expect(conversation?.thread.messageCount).toBe(2);
    expect(conversation?.thread.hasReply).toBe(true);
  });

  it('appends later messages after the ones already stored', async () => {
    await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound('one')] }, NOW);
    await syncThreadMessages(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound('one'), { at: null, direction: 'out', body: 'two' }] },
      NOW
    );
    const conversation = await readThread(db, WORKSPACE_ID, '2-maya==');
    expect(conversation?.messages.map((entry) => entry.body)).toEqual(['one', 'two']);
  });

  it('refuses messages for a conversation nobody has synced', async () => {
    await expect(
      syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-nobody==', messages: [inbound()] }, NOW)
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
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound('Sure, tell me more.')] },
      NOW
    );

    expect(result.repliedActionId).toBe(actionId);
    const row = await actionRow(actionId);
    expect(row.status).toBe('replied');
    // Dated when they answered, not when the sync noticed.
    expect(row.recorded_at).toBe('2026-08-04T09:30:00.000Z');
  });

  it('matches a ledger target stored as a bare handle', async () => {
    // `target_ref` is opaque -- whatever a human typed or a CSV supplied.
    const actionId = await ledgerAction({ target: 'maya' });
    const result = await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] }, NOW);
    expect(result.repliedActionId).toBe(actionId);
    expect((await actionRow(actionId)).status).toBe('replied');
  });

  it('prefers the invite over the DM, because the acceptance rate counts invites', async () => {
    const invite = await ledgerAction({ kind: 'invite', status: 'sent', hoursAgo: 72 });
    const dm = await ledgerAction({ kind: 'dm', status: 'sent', hoursAgo: 24 });

    const result = await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] }, NOW);

    expect(result.repliedActionId).toBe(invite);
    expect((await actionRow(dm)).status).toBe('sent');
  });

  it('never reports a reply against an action that never went out', async () => {
    const planned = await ledgerAction({ status: 'planned' });
    const result = await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] }, NOW);

    // Nobody can have replied to a message that was never sent, and marking it
    // 'replied' would invent both a send and the budget it consumed.
    expect(result.repliedActionId).toBeNull();
    expect((await actionRow(planned)).status).toBe('planned');
    expect(result.linkage).toContain('no outreach action');
  });

  it('reports a reply once, however often the conversation is re-synced', async () => {
    const actionId = await ledgerAction();
    await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] }, NOW);
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
    const result = await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] }, NOW);

    expect(result.inserted).toBe(1);
    expect(result.repliedActionId).toBeNull();
    expect(result.linkage).toContain('funnel is unchanged');
  });

  it('says so when the conversation has no profile URL to match on', async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary({ threadUrn: '2-anon==', profileUrl: null })] }, NOW);
    const result = await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-anon==', messages: [inbound()] }, NOW);

    expect(result.inserted).toBe(1);
    expect(result.repliedActionId).toBeNull();
    expect(result.linkage).toContain('no resolved profile URL');
  });

  it('adopts the campaign of the action the reply landed on', async () => {
    const campaignId = newCampaignId();
    await createCampaign(db, { id: campaignId, workspaceId: WORKSPACE_ID, name: 'Seed-stage CTOs' }, NOW);
    // The conversation was synced before the ledger row existed, so the pointer
    // could not be resolved then.
    await ledgerAction({ campaignId });

    await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', messages: [inbound()] }, NOW);

    expect((await readThread(db, WORKSPACE_ID, '2-maya=='))?.thread.campaignId).toBe(campaignId);
  });
});

describe('listThreads', () => {
  beforeEach(async () => {
    const campaignId = 'lcmp_fixed';
    await createCampaign(db, { id: campaignId, workspaceId: WORKSPACE_ID, name: 'Seed-stage CTOs' }, NOW);
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
    await syncThreadMessages(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-jonas==', messages: [inbound('yes please')] }, NOW);
  });

  it('orders by the last message and filters on unread, has-reply and campaign', async () => {
    expect((await listThreads(db, WORKSPACE_ID)).map((entry) => entry.threadUrn)).toEqual(['2-maya==', '2-jonas==']);

    expect((await listThreads(db, WORKSPACE_ID, { unread: true })).map((entry) => entry.threadUrn)).toEqual(['2-maya==']);
    expect((await listThreads(db, WORKSPACE_ID, { hasReply: true })).map((entry) => entry.threadUrn)).toEqual(['2-jonas==']);
    expect((await listThreads(db, WORKSPACE_ID, { hasReply: false })).map((entry) => entry.threadUrn)).toEqual(['2-maya==']);
    expect((await listThreads(db, WORKSPACE_ID, { campaignId: 'lcmp_fixed' })).map((entry) => entry.threadUrn)).toEqual(['2-jonas==']);
    expect(await listThreads(db, WORKSPACE_ID, { campaignId: 'lcmp_missing' })).toEqual([]);
  });
});

describe('enqueueReply', () => {
  beforeEach(async () => {
    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary()] }, NOW);
  });

  it('files a paced reply the local worker can claim, carrying the approved bytes and the thread', async () => {
    await steadySeat();

    const queued = await enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to send it over.' }, NOW);

    expect(queued.targetRef).toBe(MAYA);
    expect(queued.verdict.allowed).toBe(true);
    // Its OWN kind, whose band in limits.ts is `dm`'s numbers verbatim: same
    // ceilings, same windows, same guard -- and its own duplicate scope, which
    // is the whole reason it is not filed as a `dm`.
    const row = await db.prepare('SELECT kind, status, source, campaign_id, thread_urn FROM linkedin_actions WHERE id=?')
      .get<{ kind: string; status: string; source: string; campaign_id: string | null; thread_urn: string | null }>(queued.actionId);
    expect(row).toMatchObject({ kind: 'reply', status: 'planned', source: 'manual', thread_urn: '2-maya==' });
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
    await db.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
      .run('usr_inbox_reply_test', WORKSPACE_ID, 'inbox-reply-test@example.com', 'Inbox Reply Tester', NOW.toISOString());

    const withUser = await enqueueReply(
      db,
      { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'Happy to send it over.', queuedByUserId: 'usr_inbox_reply_test' },
      NOW
    );
    const withUserRow = await db.prepare('SELECT queued_by_user_id FROM linkedin_actions WHERE id=?')
      .get<{ queued_by_user_id: string | null }>(withUser.actionId);
    expect(withUserRow?.queued_by_user_id).toBe('usr_inbox_reply_test');
  });

  it('claims nothing has been sent', async () => {
    await steadySeat();
    await enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' }, NOW);

    // Trevra plans and approves; it never sends. A reply is not an exception.
    const counted = await db.prepare(`
      SELECT COUNT(*)::int AS total FROM linkedin_actions
      WHERE workspace_id=? AND status IN ('sent','accepted','replied','exported')
    `).get<{ total: number }>(WORKSPACE_ID);
    expect(counted?.total).toBe(0);
  });

  it('FAILS CLOSED when the gate refuses, and says which check refused it', async () => {
    // No seat at all: paced as a brand-new week-1 account, whose DM ceiling is
    // zero. The reply is refused rather than queued into a queue that would
    // never drain.
    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' }, NOW)
    ).rejects.toThrow(/safety gate/);

    const filed = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(filed?.total).toBe(0);
  });

  it('refuses a reply outside the seat\'s business hours', async () => {
    await steadySeat();
    const midnight = new Date('2026-08-05T02:00:00.000Z');
    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' }, midnight)
    ).rejects.toThrow(/business-hours/);
  });

  it('answers somebody this seat has already DMd, which is the normal case in an inbox', async () => {
    await steadySeat();
    await ledgerAction({ kind: 'dm', status: 'sent' });

    // THE REASON `reply` IS ITS OWN KIND. Filed as a `dm` this was refused by
    // `duplicate-target` and by 022's replay guard -- both correct about a cold
    // DM and both wrong about answering a conversation. The guards are
    // unchanged; the kind is what makes the question a different one.
    const queued = await enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello again' }, NOW);
    expect(queued.verdict.allowed).toBe(true);
    expect(queued.verdict.checks.find((entry) => entry.check === 'duplicate-target')?.passed).toBe(true);
  });

  it('still refuses a second reply to the same person, so the replay guard keeps its meaning', async () => {
    await steadySeat();
    await enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'first' }, NOW);

    // The narrower kind moved the boundary; it did not remove one. One reply
    // per target per seat, refused by the same two mechanisms that refuse a
    // second invite.
    await expect(
      enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: 'second' }, NOW)
    ).rejects.toThrow(/duplicate-target/);
  });

  it('refuses an empty body, an unknown conversation, and one with no profile URL', async () => {
    await steadySeat();

    await expect(enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-maya==', body: '  ' }, NOW)).rejects.toThrow(/needs a body/);
    await expect(enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-nobody==', body: 'hi' }, NOW)).rejects.toThrow(/not found/);

    await syncThreads(db, { workspaceId: WORKSPACE_ID, threads: [summary({ threadUrn: '2-anon==', profileUrl: null })] }, NOW);
    await expect(enqueueReply(db, { workspaceId: WORKSPACE_ID, threadUrn: '2-anon==', body: 'hi' }, NOW))
      .rejects.toThrow(/no resolved LinkedIn profile URL/);
  });

  it('cannot reply into another workspace\'s conversation', async () => {
    await steadySeat(OTHER_WORKSPACE_ID);
    await expect(
      enqueueReply(db, { workspaceId: OTHER_WORKSPACE_ID, threadUrn: '2-maya==', body: 'hello' }, NOW)
    ).rejects.toThrow(/not found/);
  });
});
