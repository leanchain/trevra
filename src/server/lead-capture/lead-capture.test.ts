import { createHmac, randomBytes } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { registerLeadCaptureIntake } from './http.js';
import {
  createCaptureSource,
  rotateCaptureSourceSecret,
  setCaptureSourceStatus
} from './sources.js';
import { listContacts, resolveContact } from './people.js';
import { persistImportedPeople } from './import.js';
import { createAccount } from '../accounts/store.js';
import { resealSecrets, secretsCustodyReport } from '../secrets/custody.js';
import { listInboundSubmissions } from './submissions.js';

let db: Db;
let app: Express;
let sourceId = '';
let sourceSecret = '';
const WORKSPACE_A = 'ws_capture_a';
const WORKSPACE_B = 'ws_capture_b';
const USER_A = 'usr_capture_a';
const USER_B = 'usr_capture_b';
const previousSecretsKey = process.env.TREVRA_SECRETS_KEY;

function sign(secret: string, timestamp: number, key: string, body: string): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${key}.`, 'utf8'), Buffer.from(body, 'utf8')]))
    .digest('hex');
}

function intake(
  secret: string,
  key: string,
  body: Record<string, unknown>,
  timestamp = Math.floor(Date.now() / 1000),
  source = sourceId
) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/intake/v1/submissions')
    .set('Content-Type', 'application/json')
    .set('X-Trevra-Source', source)
    .set('X-Trevra-Timestamp', String(timestamp))
    .set('X-Trevra-Idempotency-Key', key)
    .set('X-Trevra-Signature', `sha256=${sign(secret, timestamp, key, raw)}`)
    .send(raw);
}

async function seedWorkspace(workspaceId: string, userId: string, email: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(workspaceId, workspaceId, now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(userId, workspaceId, email, userId, now);
}

beforeAll(async () => {
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await seedWorkspace(WORKSPACE_A, USER_A, 'capture-a@trevra.test');
  await seedWorkspace(WORKSPACE_B, USER_B, 'capture-b@trevra.test');
  await db
    .prepare('DELETE FROM inbound_submissions WHERE workspace_id IN (?,?)')
    .run(WORKSPACE_A, WORKSPACE_B);
  await db
    .prepare('DELETE FROM account_contacts WHERE workspace_id IN (?,?)')
    .run(WORKSPACE_A, WORKSPACE_B);
  await db
    .prepare('DELETE FROM contact_external_identities WHERE workspace_id IN (?,?)')
    .run(WORKSPACE_A, WORKSPACE_B);
  await db
    .prepare('DELETE FROM capture_source_secrets WHERE workspace_id IN (?,?)')
    .run(WORKSPACE_A, WORKSPACE_B);
  await db
    .prepare('DELETE FROM capture_sources WHERE workspace_id IN (?,?)')
    .run(WORKSPACE_A, WORKSPACE_B);
  await db
    .prepare('DELETE FROM contacts WHERE workspace_id IN (?,?)')
    .run(WORKSPACE_A, WORKSPACE_B);
  await db
    .prepare('DELETE FROM accounts WHERE workspace_id IN (?,?)')
    .run(WORKSPACE_A, WORKSPACE_B);

  const created = await createCaptureSource(db, {
    workspaceId: WORKSPACE_A,
    actorUserId: USER_A,
    name: 'Website',
    kind: 'website'
  });
  sourceId = created.source.id;
  sourceSecret = created.secret;
  app = express();
  registerLeadCaptureIntake(app, db);
});

afterAll(async () => {
  if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
  await db?.close();
});

describe('generic lead capture', () => {
  it('deduplicates People deterministically without requiring an Account', async () => {
    const first = await resolveContact(db, WORKSPACE_A, {
      name: 'Ada One',
      email: 'ADA@example.com'
    });
    const second = await resolveContact(db, WORKSPACE_A, {
      name: 'Different submitted name',
      email: 'ada@example.com',
      phone: '+41441234567'
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.contact.id).toBe(first.contact.id);
    expect(second.contact.name).toBe('Ada One');
    expect(second.contact.phone).toBe('+41441234567');
    expect(second.conflicts).toEqual([
      { field: 'name', canonical: 'Ada One', submitted: 'Different submitted name' }
    ]);
    expect(
      (await listContacts(db, WORKSPACE_A)).filter((person) => person.email === 'ADA@example.com')
    ).toHaveLength(1);
  });

  it('uses LinkedIn profile as deterministic Person identity and refuses contradictory identity merges', async () => {
    const byLinkedIn = await resolveContact(db, WORKSPACE_A, {
      name: 'Linked Person',
      linkedinUrl: 'https://linkedin.com/in/linked-person/?trk=feed'
    });
    const again = await resolveContact(db, WORKSPACE_A, {
      linkedinUrl: 'https://www.linkedin.com/in/linked-person/'
    });
    expect(again.contact.id).toBe(byLinkedIn.contact.id);
    expect(again.contact.linkedinUrl).toBe('https://www.linkedin.com/in/linked-person/');

    const byEmail = await resolveContact(db, WORKSPACE_A, {
      email: 'identity-conflict@example.com'
    });
    const otherLinkedIn = await resolveContact(db, WORKSPACE_A, {
      linkedinUrl: 'https://www.linkedin.com/in/identity-conflict/'
    });
    expect(byEmail.contact.id).not.toBe(otherLinkedIn.contact.id);
    await expect(
      resolveContact(db, WORKSPACE_A, {
        email: 'identity-conflict@example.com',
        linkedinUrl: 'https://www.linkedin.com/in/identity-conflict/'
      })
    ).rejects.toThrow(/different existing People/i);
  });

  it('persists explicit imported Person evidence and never creates a Person from a name alone', async () => {
    await createAccount(db, WORKSPACE_A, {
      domain: 'imported.example',
      name: 'Imported',
      source: 'csv'
    });
    const result = await persistImportedPeople(
      db,
      WORKSPACE_A,
      [
        {
          accountDomain: 'imported.example',
          name: 'Named only',
          sourcePath: 'shops/imported/domain_summary.json'
        },
        {
          accountDomain: 'imported.example',
          name: 'Ada Import',
          email: 'ada-import@example.com',
          sourcePath: 'shops/imported/domain_summary.json#contacts[0]'
        }
      ],
      { type: 'human', id: USER_A }
    );
    expect(result).toEqual({ created: 1, matched: 0, linked: 1, skipped: 1 });
    const person = await db
      .prepare('SELECT id,name FROM contacts WHERE workspace_id=? AND email_normalized=?')
      .get<{ id: string; name: string }>(WORKSPACE_A, 'ada-import@example.com');
    expect(person?.name).toBe('Ada Import');
    const namedOnly = await db
      .prepare('SELECT id FROM contacts WHERE workspace_id=? AND name=?')
      .get(WORKSPACE_A, 'Named only');
    expect(namedOnly).toBeUndefined();
    const link = await db
      .prepare(
        'SELECT source,source_detail FROM account_contacts WHERE workspace_id=? AND contact_id=?'
      )
      .get<{ source: string; source_detail: string }>(WORKSPACE_A, person!.id);
    expect(link).toEqual({
      source: 'import',
      source_detail: 'shops/imported/domain_summary.json#contacts[0]'
    });
    const importEvents = await db
      .prepare(
        'SELECT actor_type,actor_id,payload_json FROM domain_events WHERE workspace_id=? AND stream_id=? ORDER BY position'
      )
      .all<{ actor_type: string; actor_id: string; payload_json: unknown }>(
        WORKSPACE_A,
        person!.id
      );
    expect(importEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ actor_type: 'human', actor_id: USER_A })])
    );
    expect(JSON.stringify(importEvents)).toContain(
      'shops/imported/domain_summary.json#contacts[0]'
    );
  });

  it('keeps the same email separate across workspaces and matches source-scoped external IDs deterministically', async () => {
    const inA = await resolveContact(db, WORKSPACE_A, { email: 'shared@example.com' });
    const inB = await resolveContact(db, WORKSPACE_B, { email: 'shared@example.com' });
    expect(inA.contact.id).not.toBe(inB.contact.id);

    const externalFirst = await resolveContact(db, WORKSPACE_A, {
      externalId: 'form-user-42',
      captureSourceId: sourceId,
      name: 'External Person'
    });
    const externalAgain = await resolveContact(db, WORKSPACE_A, {
      externalId: 'form-user-42',
      captureSourceId: sourceId,
      name: 'Different Name'
    });
    expect(externalAgain.contact.id).toBe(externalFirst.contact.id);
    expect(externalAgain.contact.name).toBe('External Person');
    expect(externalAgain.conflicts).toEqual([
      { field: 'name', canonical: 'External Person', submitted: 'Different Name' }
    ]);
    await expect(resolveContact(db, WORKSPACE_A, { name: 'Name only' })).rejects.toThrow(
      'Person requires email'
    );
  });

  it('accepts a signed submission, creates optional explicit Account linkage, and makes identical retries stable', async () => {
    const body = {
      kind: 'demo_request',
      person: { name: 'Kim', email: 'kim@example.com', role: 'Founder' },
      company: { domain: 'acme.com', name: 'Acme' },
      message: 'Can we talk?',
      attribution: { utm_source: 'google', utm_campaign: 'brand' },
      consent: { privacyAccepted: true },
      properties: { team_size: '11-50' }
    };
    const first = await intake(sourceSecret, 'idem-demo-001', body).expect(202);
    expect(first.body).toMatchObject({ duplicate: false });
    expect(first.body.personId).toMatch(/^con_/);
    expect(first.body.accountId).toMatch(/^acc_/);

    const duplicate = await intake(sourceSecret, 'idem-demo-001', body).expect(200);
    expect(duplicate.body).toEqual({ ...first.body, duplicate: true });

    const submissions = await listInboundSubmissions(db, WORKSPACE_A);
    const storedSubmission = submissions.find(
      (submission) => submission.id === first.body.submissionId
    );
    expect(storedSubmission).toMatchObject({
      kind: 'demo_request',
      person: { name: 'Kim', email: 'kim@example.com', role: 'Founder' },
      company: { domain: 'acme.com', name: 'Acme' },
      attribution: { utm_source: 'google', utm_campaign: 'brand' }
    });
    const accountLink = await db
      .prepare(
        'SELECT source,confidence FROM account_contacts WHERE workspace_id=? AND contact_id=?'
      )
      .get<{ source: string; confidence: string }>(WORKSPACE_A, first.body.personId);
    expect(accountLink).toEqual({ source: 'capture', confidence: 'explicit' });
  });

  it('does not derive an Account from an email domain and cannot link a foreign-workspace Account', async () => {
    await createAccount(db, WORKSPACE_B, {
      domain: 'foreign.example',
      name: 'Foreign',
      source: 'manual'
    });
    const emailOnly = await intake(sourceSecret, 'idem-email-only-001', {
      kind: 'contact_message',
      person: { email: 'founder@no-account.example' }
    }).expect(202);
    expect(emailOnly.body.accountId).toBeNull();
    const inferred = await db
      .prepare('SELECT id FROM accounts WHERE workspace_id=? AND domain=?')
      .get(WORKSPACE_A, 'no-account.example');
    expect(inferred).toBeUndefined();

    const explicit = await intake(sourceSecret, 'idem-foreign-account-001', {
      kind: 'contact_message',
      person: { email: 'founder@foreign.example' },
      company: { domain: 'foreign.example' }
    }).expect(202);
    const linked = await db
      .prepare('SELECT workspace_id FROM accounts WHERE id=?')
      .get<{ workspace_id: string }>(explicit.body.accountId);
    expect(linked?.workspace_id).toBe(WORKSPACE_A);
  });

  it('returns 409 when an idempotency key is reused for a different payload', async () => {
    await intake(sourceSecret, 'idem-conflict-001', {
      kind: 'contact_message',
      person: { email: 'conflict@example.com' },
      message: 'first'
    }).expect(202);
    const response = await intake(sourceSecret, 'idem-conflict-001', {
      kind: 'contact_message',
      person: { email: 'conflict@example.com' },
      message: 'second'
    }).expect(409);
    expect(response.body.error).toContain('different payload');
  });

  it('derives the workspace only from the Capture Source and rejects body routing fields', async () => {
    const response = await intake(sourceSecret, 'idem-workspace-001', {
      kind: 'contact_message',
      workspaceId: WORKSPACE_B,
      person: { email: 'route@example.com' }
    }).expect(400);
    expect(response.body.error).toBeTruthy();
    const leaked = await db
      .prepare('SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=?')
      .get(WORKSPACE_B, 'route@example.com');
    expect(leaked).toBeUndefined();
  });

  it('bounds custom payloads and keeps message/property content out of GTM event payloads', async () => {
    await intake(sourceSecret, 'idem-nested-properties-001', {
      kind: 'contact_message',
      person: { email: 'nested@example.com' },
      properties: { nested: { arbitrary: true } }
    }).expect(400);
    await intake(sourceSecret, 'idem-honeypot-field-001', {
      kind: 'contact_message',
      person: { email: 'honeypot@example.com' },
      website: 'bot-filled-field'
    }).expect(400);

    const accepted = await intake(sourceSecret, 'idem-reserved-properties-001', {
      kind: 'contact_message',
      person: { email: 'safe-properties@example.com' },
      message: 'private lead body that must not enter event analytics',
      properties: { workspaceId: WORKSPACE_B, status: 'won' }
    }).expect(202);
    expect(accepted.body.accountId).toBeNull();
    const events = await db
      .prepare('SELECT payload_json FROM domain_events WHERE workspace_id=? AND correlation_id=?')
      .all<{ payload_json: unknown }>(WORKSPACE_A, accepted.body.submissionId);
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain('private lead body');
    expect(serializedEvents).not.toContain(WORKSPACE_B);
  });

  it('rejects bad signatures, stale timestamps and generic telemetry kinds', async () => {
    const now = Math.floor(Date.now() / 1000);
    await intake('trv_capture_wrong', 'idem-badsig-001', {
      kind: 'contact_message',
      person: { email: 'bad@example.com' }
    }).expect(401);
    await intake(
      sourceSecret,
      'idem-stale-001',
      { kind: 'contact_message', person: { email: 'stale@example.com' } },
      now - 600
    ).expect(401);
    await intake(sourceSecret, 'idem-telemetry-001', {
      kind: 'page_view',
      person: { email: 'telemetry@example.com' }
    }).expect(400);
  });

  it('concurrent identical deliveries produce one immutable submission', async () => {
    const body = {
      kind: 'contact_message',
      person: { email: 'concurrent@example.com' },
      message: 'same bytes'
    };
    const [one, two] = await Promise.all([
      intake(sourceSecret, 'idem-concurrent-001', body),
      intake(sourceSecret, 'idem-concurrent-001', body)
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 202]);
    expect(one.body.submissionId).toBe(two.body.submissionId);
    const count = await db
      .prepare(
        'SELECT COUNT(*)::int AS count FROM inbound_submissions WHERE capture_source_id=? AND idempotency_key=?'
      )
      .get<{ count: number }>(sourceId, 'idem-concurrent-001');
    expect(count?.count).toBe(1);
  });

  it('accepts the previous secret during rotation and stops immediately when disabled', async () => {
    const oldSecret = sourceSecret;
    const rotated = await rotateCaptureSourceSecret(db, {
      workspaceId: WORKSPACE_A,
      sourceId,
      actorUserId: USER_A
    });
    sourceSecret = rotated.secret;

    await intake(oldSecret, 'idem-old-secret-001', {
      kind: 'contact_message',
      person: { email: 'rotation@example.com' }
    }).expect(202);
    await intake(sourceSecret, 'idem-new-secret-001', {
      kind: 'contact_message',
      person: { email: 'rotation2@example.com' }
    }).expect(202);

    await db
      .prepare(
        "UPDATE capture_source_secrets SET expires_at=? WHERE capture_source_id=? AND slot='previous'"
      )
      .run(new Date(Date.now() - 1000).toISOString(), sourceId);
    await intake(oldSecret, 'idem-expired-old-secret-001', {
      kind: 'contact_message',
      person: { email: 'rotation-expired@example.com' }
    }).expect(401);

    await setCaptureSourceStatus(db, {
      workspaceId: WORKSPACE_A,
      sourceId,
      status: 'disabled',
      actorUserId: USER_A
    });
    await intake(sourceSecret, 'idem-disabled-001', {
      kind: 'contact_message',
      person: { email: 'disabled@example.com' }
    }).expect(401);
    await setCaptureSourceStatus(db, {
      workspaceId: WORKSPACE_A,
      sourceId,
      status: 'active',
      actorUserId: USER_A
    });
  });

  it('includes Capture Source secrets in deployment key-rotation custody', async () => {
    const oldKey = process.env.TREVRA_SECRETS_KEY!;
    const nextKey = randomBytes(32).toString('base64');
    const env = {
      ...process.env,
      TREVRA_SECRETS_KEY: nextKey,
      TREVRA_SECRETS_KEY_PREVIOUS: oldKey
    };
    const before = await secretsCustodyReport(db, env, { workspaceId: WORKSPACE_A });
    expect(before.outstanding.some((row) => row.store === 'capture_source_secrets')).toBe(true);
    const resealed = await resealSecrets(db, { env, workspaceId: WORKSPACE_A });
    expect(resealed.resealed).toBeGreaterThan(0);
    const after = await secretsCustodyReport(db, env, { workspaceId: WORKSPACE_A });
    expect(after.complete).toBe(true);
    process.env.TREVRA_SECRETS_KEY = nextKey;
  });

  it('rejects an unknown source without creating data', async () => {
    const body = { kind: 'contact_message', person: { email: 'unknown@example.com' } };
    const raw = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const key = 'idem-unknown-001';
    const response = await request(app)
      .post('/api/intake/v1/submissions')
      .set('Content-Type', 'application/json')
      .set('X-Trevra-Source', 'cap_missing')
      .set('X-Trevra-Timestamp', String(timestamp))
      .set('X-Trevra-Idempotency-Key', key)
      .set('X-Trevra-Signature', `sha256=${sign(sourceSecret, timestamp, key, raw)}`)
      .send(raw)
      .expect(404);
    expect(response.body.error).toContain('not found');
  });
});
