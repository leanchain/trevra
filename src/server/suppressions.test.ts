import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from './db.js';
import { resolveContact } from './lead-capture/people.js';
import {
  assertNotSuppressed,
  createSuppression,
  findSuppression,
  liftSuppressionsBySource
} from './suppressions.js';

let db: Db;
const WORKSPACE = 'ws_suppressions_test';
const NOW = new Date('2026-08-21T00:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE, 'Suppression Test', NOW.toISOString());
  await db.prepare('DELETE FROM suppressions WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM contacts WHERE workspace_id=?').run(WORKSPACE);
});

afterEach(async () => {
  await db?.close();
});

describe('global GTM suppressions', () => {
  it('blocks a case-insensitive email at the execution boundary', async () => {
    await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'email',
        email: 'Stop@Example.com',
        reason: 'Unsubscribed',
        source: 'manual',
        sourceRef: 'test-1'
      },
      NOW
    );

    const found = await findSuppression(db, WORKSPACE, {
      channel: 'email',
      email: 'stop@example.com'
    });
    expect(found).toMatchObject({
      channel: 'email',
      email: 'stop@example.com',
      reason: 'Unsubscribed'
    });
    await expect(
      assertNotSuppressed(db, WORKSPACE, { channel: 'email', email: 'STOP@example.com' })
    ).rejects.toThrow(/Unsubscribed/);
  });

  it('lets all-channel and domain suppressions apply without leaking to another workspace', async () => {
    await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'all',
        domain: 'example.org',
        reason: 'Domain blocked',
        source: 'policy'
      },
      NOW
    );
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'person@example.org' })
    ).toMatchObject({ reason: 'Domain blocked' });
    expect(
      await findSuppression(db, 'another-workspace', {
        channel: 'email',
        email: 'person@example.org'
      })
    ).toBeNull();
  });

  it('resolves a Person-only suppression from a LinkedIn profile', async () => {
    const person = await resolveContact(db, WORKSPACE, {
      name: 'Maya',
      linkedinUrl: 'https://www.linkedin.com/in/maya-suppressed/'
    });
    await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'linkedin',
        personId: person.contact.id,
        reason: 'Do not contact',
        source: 'manual'
      },
      NOW
    );

    expect(
      await findSuppression(db, WORKSPACE, {
        channel: 'linkedin',
        linkedinUrl: 'https://linkedin.com/in/maya-suppressed/?trk=feed'
      })
    ).toMatchObject({ personId: person.contact.id, reason: 'Do not contact' });
  });

  it('lifts only the suppression created by the named source', async () => {
    await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'linkedin',
        linkedinUrl: 'https://www.linkedin.com/in/maya-source/',
        reason: 'Lead DNC',
        source: 'linkedin_lead',
        sourceRef: 'lead-1'
      },
      NOW
    );
    expect(
      await liftSuppressionsBySource(
        db,
        {
          workspaceId: WORKSPACE,
          source: 'linkedin_lead',
          sourceRef: 'lead-1',
          channel: 'linkedin',
          actorType: 'human',
          actorId: id('usr')
        },
        new Date(NOW.getTime() + 1_000)
      )
    ).toBe(1);
    expect(
      await findSuppression(db, WORKSPACE, {
        channel: 'linkedin',
        linkedinUrl: 'https://www.linkedin.com/in/maya-source/'
      })
    ).toBeNull();
  });
});
