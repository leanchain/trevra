import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { countLeadContacts, createLeadList, deleteLeadList, getLeadList, importLeadCsv, importLeadSourceContacts, listLeadContacts, removeLeadContact, updateLeadContact } from './lead-lists.js';
import { createLeadSource } from './leads.js';
import { createManagedCampaign, listCampaignMembers, pauseManagedCampaign, startManagedCampaign } from './managed-campaigns.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

/**
 * NO BROWSER AND NO LINKEDIN. The harvest is written straight into
 * `linkedin_leads` here, because what is under test is the two things that
 * happen AFTER a walk: turning harvested rows into contacts a campaign can
 * enrol, and refusing to let one person become two contacts.
 */

let db: Db;

const NOW = new Date('2026-08-14T09:00:00.000Z');
const WORKSPACE_ID = 'ws_linkedin_lead_lists_test';
const SEARCH_URL = 'https://www.linkedin.com/search/results/people/?keywords=cto';
const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/';

async function harvest(
  sourceId: string,
  lead: {
    handle: string;
    name: string | null;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    postUrl?: string | null;
    interactionKind?: string | null;
  }
): Promise<void> {
  await db.prepare(`
    INSERT INTO linkedin_leads (id,workspace_id,source_id,profile_url,name,first_name,last_name,headline,company,post_url,interaction_kind,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id('llead'),
    WORKSPACE_ID,
    sourceId,
    `https://www.linkedin.com/in/${lead.handle}/`,
    lead.name,
    lead.firstName ?? null,
    lead.lastName ?? null,
    'Founder',
    lead.company ?? null,
    lead.postUrl ?? null,
    lead.interactionKind ?? null,
    NOW.toISOString()
  );
}

async function source(kind: 'search' | 'content' = 'search', url = SEARCH_URL): Promise<string> {
  const created = await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind, url }, NOW);
  return created.source.id;
}

async function contactCount(): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_lead_contacts WHERE workspace_id=?').get<{ total: number }>(WORKSPACE_ID);
  return Number(row?.total ?? 0);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Lead Lists Test', NOW.toISOString());
  for (const table of ['linkedin_leads', 'linkedin_lead_sources', 'linkedin_actions', 'linkedin_campaigns', 'linkedin_workflows', 'linkedin_lead_contacts', 'linkedin_lead_lists', 'linkedin_seats']) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE_ID);
  }
  // A managed campaign needs a seat to be created against, and the delete
  // paths below are only interesting when there is a campaign holding the list.
  await upsertSeat(db, WORKSPACE_ID, { label: 'Owner', timezone: 'Europe/Zurich' }, new Date('2026-01-01T09:00:00.000Z'));
});

afterEach(async () => {
  await db?.close();
});

describe('materialising a harvest into a campaign-usable list', () => {
  it('creates the list, scrubs and splits every name, and counts what it could not use', async () => {
    const sourceId = await source();
    await harvest(sourceId, { handle: 'maya', name: 'Dr. Maya \u{1F642} Chen, MBA', company: 'Acme' });
    await harvest(sourceId, { handle: 'jonas', name: 'Jonas Keller', firstName: 'Jonas', lastName: 'Keller' });
    // The card showed a link and nothing else. A campaign's first move is to
    // put a first name in a message, so "Hi ," is worse than one fewer lead.
    await harvest(sourceId, { handle: 'nameless', name: null });

    const result = await importLeadSourceContacts(db, { workspaceId: WORKSPACE_ID, sourceId }, NOW);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.list.sourceKind).toBe('linkedin_search');
    expect(result.list.sourceRef).toBe(SEARCH_URL);
    expect(result.list.leadCount).toBe(2);

    const contacts = await listLeadContacts(db, WORKSPACE_ID, result.list.id);
    const byUrl = Object.fromEntries(contacts.map((contact) => [contact.profileUrl, contact]));
    // THE CSV IMPORT'S RULES, NOT A SECOND SET.
    expect(byUrl['https://www.linkedin.com/in/maya/']).toMatchObject({ firstName: 'Maya', lastName: 'Chen', company: 'Acme' });
    expect(byUrl['https://www.linkedin.com/in/jonas/']).toMatchObject({ firstName: 'Jonas', lastName: 'Keller' });
  });

  it('carries a keyword-discovered lead into a list with no company at all', async () => {
    const sourceId = await source('content', 'https://www.linkedin.com/search/results/content/?keywords=rag');
    await harvest(sourceId, { handle: 'sofia', name: 'Sofia Rossi', postUrl: POST_URL, interactionKind: 'comment' });

    const result = await importLeadSourceContacts(db, { workspaceId: WORKSPACE_ID, sourceId, listName: 'RAG commenters' }, NOW);

    expect(result.inserted).toBe(1);
    expect(result.list.name).toBe('RAG commenters');
    expect(result.list.sourceKind).toBe('post_keyword');
    const [contact] = await listLeadContacts(db, WORKSPACE_ID, result.list.id);
    expect(contact).toMatchObject({ firstName: 'Sofia', lastName: 'Rossi', company: '' });
  });

  it('is idempotent: running the same source twice does not double the list', async () => {
    const sourceId = await source();
    await harvest(sourceId, { handle: 'maya', name: 'Maya Chen' });
    const first = await importLeadSourceContacts(db, { workspaceId: WORKSPACE_ID, sourceId }, NOW);
    const again = await importLeadSourceContacts(db, { workspaceId: WORKSPACE_ID, sourceId, listId: first.list.id }, NOW);

    expect(again.inserted).toBe(0);
    expect(again.duplicates).toBe(1);
    expect(await contactCount()).toBe(1);
  });
});

describe('one person, one contact row, per workspace', () => {
  const csv = (url: string) => `First Name,Last Name,Company,LinkedIn URL\nMaya,Chen,Acme,${url}`;

  it('reuses the existing contact when the same person is imported into a second list', async () => {
    const first = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'Batch one' }, NOW);
    const second = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'Batch two' }, NOW);

    const one = await importLeadCsv(db, { workspaceId: WORKSPACE_ID, listId: first.id, csv: csv('https://www.linkedin.com/in/maya/') }, NOW);
    // The same human, spelled the way LinkedIn's own share link spells them.
    const two = await importLeadCsv(db, { workspaceId: WORKSPACE_ID, listId: second.id, csv: csv('https://LinkedIn.com/in/maya') }, NOW);

    expect(one.inserted).toBe(1);
    expect(two.inserted).toBe(0);
    expect(two.duplicates).toBe(1);
    // COUNTED APART: "already one of your leads, and now in this list too" is a
    // different sentence from "you uploaded them twice".
    expect(two.reused).toBe(1);
    // THE ASSERTION THAT MATTERS. Two contact ids for one person is two
    // campaign claims for one person, which defeats the one-active index.
    expect(await contactCount()).toBe(1);
    // AND THE ASSERTION THAT USED TO SAY `[]`. Finding the existing row was
    // the end of the story, so the person stayed in whichever list they landed
    // in first: importing 500 into a list where 200 were already known built a
    // 300-row list, and the campaign on it could never reach the other 200.
    // One person, one row, MANY LISTS.
    expect((await listLeadContacts(db, WORKSPACE_ID, second.id)).map((contact) => contact.firstName)).toEqual(['Maya']);
    expect((await listLeadContacts(db, WORKSPACE_ID, first.id)).map((contact) => contact.firstName)).toEqual(['Maya']);
    // The list count is membership, so both lists report the person they hold.
    expect((await getLeadList(db, WORKSPACE_ID, second.id))?.leadCount).toBe(1);
    expect(await countLeadContacts(db, WORKSPACE_ID, second.id)).toBe(1);
    // The contact reports the list it was asked for, not the one it landed in.
    expect((await listLeadContacts(db, WORKSPACE_ID, second.id))[0].listId).toBe(second.id);
  });

  it('deduplicates a lead that has only an email, across lists as well as inside one', async () => {
    const first = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'Emails one' }, NOW);
    const second = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'Emails two' }, NOW);
    const emailCsv = 'First Name,Last Name,Company,Email\nMaya,Chen,Acme,maya@example.com';

    await importLeadCsv(db, { workspaceId: WORKSPACE_ID, listId: first.id, csv: emailCsv }, NOW);
    // The same address, spelled the way a second export spells it.
    const two = await importLeadCsv(db, { workspaceId: WORKSPACE_ID, listId: second.id, csv: emailCsv.replace('maya@example.com', 'MAYA@Example.com') }, NOW);

    // 048's workspace-wide uniqueness is partial on `profile_url IS NOT NULL`,
    // so a lead with only an email deduplicated PER LIST and became two contact
    // ids -- and `idx_linkedin_campaign_members_one_active`, keyed on
    // contact_id, saw two different people and would enrol both.
    // `leadDedupeKey` had been computing this identity all along.
    expect(two.inserted).toBe(0);
    expect(two.reused).toBe(1);
    expect(await contactCount()).toBe(1);
    expect(await countLeadContacts(db, WORKSPACE_ID, second.id)).toBe(1);
  });

  it('names a name-and-company collision instead of raising a bare constraint', async () => {
    const list = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'No URLs' }, NOW);
    await importLeadCsv(
      db,
      { workspaceId: WORKSPACE_ID, listId: list.id, csv: 'First Name,Last Name,Company\nMaya,Chen,Acme\nJonas,Keller,Acme' },
      NOW
    );
    const jonas = (await listLeadContacts(db, WORKSPACE_ID, list.id)).find((contact) => contact.firstName === 'Jonas')!;

    // Neither row has a profile URL, so the old pre-check -- which only ever
    // looked at `profile_url` -- did not fire and the raw 23505 surfaced as the
    // generic "that LinkedIn manager name or active lead claim already exists".
    await expect(
      updateLeadContact(db, { workspaceId: WORKSPACE_ID, contactId: jonas.id, firstName: 'Maya', lastName: 'Chen', company: 'Acme' }, NOW)
    ).rejects.toThrow(/Maya Chen at Acme is already a lead/i);
    expect(await contactCount()).toBe(2);
  });

  it('reuses across a CSV upload and a harvest of the same person', async () => {
    const list = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'Uploaded' }, NOW);
    await importLeadCsv(db, { workspaceId: WORKSPACE_ID, listId: list.id, csv: csv('https://www.linkedin.com/in/maya/') }, NOW);

    const sourceId = await source();
    await harvest(sourceId, { handle: 'maya', name: 'Maya Chen', company: 'Acme' });
    const materialised = await importLeadSourceContacts(db, { workspaceId: WORKSPACE_ID, sourceId }, NOW);

    expect(materialised.inserted).toBe(0);
    expect(materialised.reused).toBe(1);
    expect(await contactCount()).toBe(1);
  });

  it('refuses to edit one contact into being another one', async () => {
    const list = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'Batch' }, NOW);
    await importLeadCsv(
      db,
      {
        workspaceId: WORKSPACE_ID,
        listId: list.id,
        csv: 'First Name,Last Name,Company,LinkedIn URL\nMaya,Chen,Acme,https://www.linkedin.com/in/maya/\nJonas,Keller,Acme,https://www.linkedin.com/in/jonas/'
      },
      NOW
    );
    const contacts = await listLeadContacts(db, WORKSPACE_ID, list.id);
    const jonas = contacts.find((contact) => contact.firstName === 'Jonas')!;

    await expect(
      updateLeadContact(
        db,
        { workspaceId: WORKSPACE_ID, contactId: jonas.id, firstName: 'Jonas', lastName: 'Keller', company: 'Acme', profileUrl: 'https://www.linkedin.com/in/maya/' },
        NOW
      )
      // The refusal names the rule rather than surfacing a constraint code.
    ).rejects.toThrow(/one lead row/i);
    expect(await contactCount()).toBe(2);
  });
});

describe('removing a lead', () => {
  /** A campaign, a member row for `contactId`, and the actions planned for it. */
  async function enrol(contactId: string): Promise<{ memberId: string }> {
    const iso = NOW.toISOString();
    const campaignId = id('lcmp');
    const memberId = id('lcmem');
    await db.prepare(`INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,created_at,updated_at) VALUES (?,?,?,?,?::jsonb,?,?)`)
      .run(campaignId, WORKSPACE_ID, 'Removal test', 'running', '{}', iso, iso);
    await db.prepare(`INSERT INTO linkedin_campaign_members (id,workspace_id,campaign_id,contact_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(memberId, WORKSPACE_ID, campaignId, contactId, 'active', iso, iso);
    return { memberId };
  }

  // Two ledger rows for one person means two KINDS: the replay guard's unique
  // index is per (target, kind) and rightly refuses a second planned invite.
  async function action(memberId: string, actionId: string, kind: string, claimedAt: string | null): Promise<void> {
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,campaign_member_id,status,planned_for,claimed_at,source,created_at)
      VALUES (?,?,'owner',?,?,?,'planned',?,?,'export',?)
    `).run(actionId, WORKSPACE_ID, kind, 'https://www.linkedin.com/in/maya/', memberId, NOW.toISOString(), claimedAt, NOW.toISOString());
  }

  async function statusOf(actionId: string): Promise<string> {
    const row = await db.prepare('SELECT status FROM linkedin_actions WHERE id=?').get<{ status: string }>(actionId);
    return String(row?.status);
  }

  it('skips the invites still planned for that person instead of leaving them to fire', async () => {
    const list = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'To prune' }, NOW);
    await importLeadCsv(db, { workspaceId: WORKSPACE_ID, listId: list.id, csv: 'First Name,Last Name,Company,LinkedIn URL\nMaya,Chen,Acme,https://www.linkedin.com/in/maya/' }, NOW);
    const [maya] = await listLeadContacts(db, WORKSPACE_ID, list.id);
    const { memberId } = await enrol(maya.id);
    await action(memberId, 'lact_unclaimed', 'invite', null);
    await action(memberId, 'lact_claimed', 'dm', NOW.toISOString());

    expect(await removeLeadContact(db, WORKSPACE_ID, maya.id)).toBe(true);

    // THE BUG THIS EXISTS FOR. `linkedin_campaign_members` and
    // `linkedin_manual_tasks` cascade away with the contact, which reads like
    // the whole cleanup -- but `linkedin_actions.campaign_member_id` has no
    // foreign key, so a planned invite survived with a dangling member id and
    // the worker sent it to the person the operator had just deleted.
    expect(await statusOf('lact_unclaimed')).toBe('skipped');
    // A row a worker has already claimed is mid-flight and is the ledger's to
    // reconcile -- the same line `removeCampaignMember` draws.
    expect(await statusOf('lact_claimed')).toBe('planned');
    expect(await contactCount()).toBe(0);
  });
});

describe('importing only what the operator selected', () => {
  it('imports just the chosen rows, and the whole source when none are chosen', async () => {
    const sourceId = await source();
    await harvest(sourceId, { handle: 'maya', name: 'Maya Chen' });
    await harvest(sourceId, { handle: 'jonas', name: 'Jonas Keller' });
    await harvest(sourceId, { handle: 'sofia', name: 'Sofia Rossi' });
    const rows = await db.prepare('SELECT id,profile_url FROM linkedin_leads WHERE workspace_id=? ORDER BY profile_url').all<{ id: string; profile_url: string }>(WORKSPACE_ID);
    const chosen = rows.filter((row) => !row.profile_url.includes('/sofia/')).map((row) => row.id);

    // The leads screen has always had working row selection and no way to send
    // it anywhere, so Save wrote all three regardless of what was ticked.
    const selected = await importLeadSourceContacts(db, { workspaceId: WORKSPACE_ID, sourceId, listName: 'Picked', leadIds: chosen }, NOW);
    expect(selected.inserted).toBe(2);
    expect((await listLeadContacts(db, WORKSPACE_ID, selected.list.id)).map((contact) => contact.firstName).sort()).toEqual(['Jonas', 'Maya']);

    // Absent, every existing caller and the worker still import everything.
    const all = await importLeadSourceContacts(db, { workspaceId: WORKSPACE_ID, sourceId, listName: 'Everyone' }, NOW);
    expect(await countLeadContacts(db, WORKSPACE_ID, all.list.id)).toBe(3);
    // And the two already known were REUSED into the new list, not copied.
    expect(all.inserted).toBe(1);
    expect(all.reused).toBe(2);
    expect(await contactCount()).toBe(3);
  });
});

/* ---------------------------------------------------------------------------
 * Deletion: of one person, and of a whole list.
 *
 * Everything below is about the same failure seen twice. `linkedin_actions`
 * rows are not reachable by any foreign key -- `campaign_member_id` is a plain
 * attribution column (migration 046) -- so a cascade that removes a person
 * leaves their queued outreach behind, and something later sends it. The
 * status that made this newly dangerous is 'held' (migration 051): a paused
 * campaign's whole queue sits in it, and `startManagedCampaign` restores
 * EVERY held row of a campaign to 'planned' in one statement, orphans
 * included.
 * ------------------------------------------------------------------------ */

async function listWith(name: string, handles: readonly string[]): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WORKSPACE_ID, name }, NOW);
  const csv = ['First Name,Last Name,Company,LinkedIn URL']
    .concat(handles.map((handle) => `${handle},Person,Acme,https://www.linkedin.com/in/${handle}/`))
    .join('\n');
  await importLeadCsv(db, { workspaceId: WORKSPACE_ID, listId: list.id, csv }, NOW);
  return list.id;
}

async function workflowId(name = 'Connect'): Promise<string> {
  return (await saveWorkflow(db, {
    workspaceId: WORKSPACE_ID,
    name,
    steps: [{ id: 'invite', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{first_name}}' } }]
  }, NOW)).id;
}

/** A queued ledger row attributed to a member, the way the runner writes one. */
async function queueFor(campaignId: string, memberId: string, handle: string, status: 'planned' | 'held'): Promise<string> {
  const actionId = `lact_${handle}`;
  await db.prepare(`
    INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,campaign_id,campaign_member_id,status,planned_for,source,replay_scope,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(actionId, WORKSPACE_ID, 'owner', 'invite', `https://www.linkedin.com/in/${handle}/`, campaignId, memberId, status, NOW.toISOString(), 'campaign', `${memberId}:invite`, NOW.toISOString());
  return actionId;
}

async function actionStatus(actionId: string): Promise<string | undefined> {
  return (await db.prepare('SELECT status FROM linkedin_actions WHERE workspace_id=? AND id=?')
    .get<{ status: string }>(WORKSPACE_ID, actionId))?.status;
}

describe('deleting a lead who is in a PAUSED campaign', () => {
  /**
   * The worst outcome this subsystem can produce, and it needed no unusual
   * input: pause a campaign, delete one lead, resume. The invite went out from
   * the customer's own account, to somebody they had explicitly deleted, days
   * after they deleted them, and LinkedIn cannot recall it.
   */
  it('skips the held rows too, so resuming the campaign cannot message them', async () => {
    const listId = await listWith('Paused list', ['maya']);
    const created = await createManagedCampaign(db, { workspaceId: WORKSPACE_ID, name: 'Paused', leadListId: listId, workflowId: await workflowId() }, NOW);
    await startManagedCampaign(db, WORKSPACE_ID, created.campaign.id, NOW);
    const [member] = await listCampaignMembers(db, WORKSPACE_ID, created.campaign.id);
    const actionId = await queueFor(created.campaign.id, member.id, 'maya', 'planned');

    await pauseManagedCampaign(db, WORKSPACE_ID, created.campaign.id, NOW);
    expect(await actionStatus(actionId)).toBe('held');

    expect(await removeLeadContact(db, WORKSPACE_ID, member.contactId)).toBe(true);
    expect(await actionStatus(actionId)).toBe('skipped');

    // The resume is the statement that used to hand the orphan back to the
    // worker. It restores every held row of the campaign in one UPDATE and has
    // no way to know which of them lost their person.
    await startManagedCampaign(db, WORKSPACE_ID, created.campaign.id, NOW);
    expect(await actionStatus(actionId)).toBe('skipped');
  });
});

describe('deleting a lead list', () => {
  it('refuses while a running campaign is built on it, and says which one', async () => {
    const listId = await listWith('Live list', ['maya']);
    const created = await createManagedCampaign(db, { workspaceId: WORKSPACE_ID, name: 'Still running', leadListId: listId, workflowId: await workflowId() }, NOW);
    await startManagedCampaign(db, WORKSPACE_ID, created.campaign.id, NOW);

    await expect(deleteLeadList(db, WORKSPACE_ID, listId)).rejects.toThrow(/Still running/);
    expect(await getLeadList(db, WORKSPACE_ID, listId)).toBeDefined();
  });

  it('refuses while a PAUSED campaign is built on it, because a pause is resumable', async () => {
    const listId = await listWith('Paused list', ['maya']);
    const created = await createManagedCampaign(db, { workspaceId: WORKSPACE_ID, name: 'Merely paused', leadListId: listId, workflowId: await workflowId() }, NOW);
    await startManagedCampaign(db, WORKSPACE_ID, created.campaign.id, NOW);
    await pauseManagedCampaign(db, WORKSPACE_ID, created.campaign.id, NOW);

    await expect(deleteLeadList(db, WORKSPACE_ID, listId)).rejects.toThrow(/Merely paused/);
  });

  /**
   * The reason there was no route for this at all. Migration 046 made
   * `list_id` NOT NULL ON DELETE CASCADE, so the database's answer to "delete
   * this list" was "delete every person who first arrived through it" --
   * including the ones sitting in other lists, which is exactly what migration
   * 052 made possible and warned about in writing.
   */
  it('deletes the list and its memberships, and NOT the people in it', async () => {
    const origin = await listWith('Origin', ['maya', 'jonas']);
    const second = await createLeadList(db, { workspaceId: WORKSPACE_ID, name: 'Second' }, NOW);
    // The same two people, added to a second list rather than copied into it.
    const reuse = await importLeadCsv(db, {
      workspaceId: WORKSPACE_ID,
      listId: second.id,
      csv: 'First Name,Last Name,Company,LinkedIn URL\nmaya,Person,Acme,https://www.linkedin.com/in/maya/\njonas,Person,Acme,https://www.linkedin.com/in/jonas/'
    }, NOW);
    expect(reuse.reused).toBe(2);

    const report = await deleteLeadList(db, WORKSPACE_ID, origin);

    expect(report).toMatchObject({ name: 'Origin', membershipsRemoved: 2, contactsDetached: 2, campaignsDetached: 0, membersRemoved: 0, actionsSkipped: 0 });
    expect(await getLeadList(db, WORKSPACE_ID, origin)).toBeUndefined();
    // Both people are still leads, still in the other list, and no longer
    // record an origin -- which is the true answer, not a repointed one.
    expect(await contactCount()).toBe(2);
    expect(await countLeadContacts(db, WORKSPACE_ID, second.id)).toBe(2);
    const orphaned = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_lead_contacts WHERE workspace_id=? AND list_id IS NULL')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(orphaned?.total).toBe(2);
  });

  it('releases the planned AND held work of every campaign it detaches', async () => {
    const listId = await listWith('Draft list', ['maya', 'jonas']);
    const created = await createManagedCampaign(db, { workspaceId: WORKSPACE_ID, name: 'Never started', leadListId: listId, workflowId: await workflowId() }, NOW);
    const members = await listCampaignMembers(db, WORKSPACE_ID, created.campaign.id);
    const planned = await queueFor(created.campaign.id, members[0].id, 'maya', 'planned');
    const held = await queueFor(created.campaign.id, members[1].id, 'jonas', 'held');
    await db.prepare(`
      INSERT INTO linkedin_manual_tasks (id,workspace_id,campaign_id,member_id,contact_id,seat_key,workflow_step_id,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run('litask_draft', WORKSPACE_ID, created.campaign.id, members[0].id, members[0].contactId, 'owner', 'invite', 'pending', NOW.toISOString());

    const report = await deleteLeadList(db, WORKSPACE_ID, listId);

    expect(report).toMatchObject({ campaignsDetached: 1, membersRemoved: 2, tasksCancelled: 1, actionsSkipped: 2, membershipsRemoved: 2, contactsDetached: 2 });
    expect(await actionStatus(planned)).toBe('skipped');
    expect(await actionStatus(held)).toBe('skipped');
    // The campaign survives with no list, rather than being deleted with it.
    const campaign = await db.prepare('SELECT lead_list_id FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
      .get<{ lead_list_id: string | null }>(WORKSPACE_ID, created.campaign.id);
    expect(campaign?.lead_list_id).toBeNull();
    expect(await contactCount()).toBe(2);
  });

  it('answers undefined for a list this workspace does not have', async () => {
    expect(await deleteLeadList(db, WORKSPACE_ID, 'lilst_nope')).toBeUndefined();
  });
});
