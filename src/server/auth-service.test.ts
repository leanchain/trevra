import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const emailMock = vi.hoisted(() => ({
  sendOrganizationInvitationEmail: vi.fn(async () => undefined),
  sendMagicLinkEmail: vi.fn(
    async (_input: { to: string; signInUrl: string; expiresMinutes?: number }) => undefined
  ),
  sendInvitationAcceptedEmail: vi.fn(async () => undefined),
  sendWorkspaceAccessRemovedEmail: vi.fn(async () => undefined)
}));
vi.mock('./email.js', () => ({
  smtpConfigured: () => true,
  sendOrganizationInvitationEmail: emailMock.sendOrganizationInvitationEmail,
  sendMagicLinkEmail: emailMock.sendMagicLinkEmail,
  sendInvitationAcceptedEmail: emailMock.sendInvitationAcceptedEmail,
  sendWorkspaceAccessRemovedEmail: emailMock.sendWorkspaceAccessRemovedEmail
}));
import request from 'supertest';
import type { Express } from 'express';
import { randomBytes } from 'node:crypto';
import { DEMO_WORKSPACE_ID, id, openDatabase, type Db } from './db.js';
import { createApp } from './app.js';
import {
  assertOwnerChangeAllowed,
  auth as betterAuth,
  backfillWorkspaceOrganizations,
  closeAuthDatabase,
  migrateAuthDatabase
} from './auth-service.js';

/**
 * Team workspace access (docs/superpowers/specs/2026-08-13-team-workspace-
 * access-design.md).
 *
 * Real ephemeral Postgres and the real HTTP layer throughout, per this repo's
 * test harness: the load-bearing claims here are about better-auth's own
 * `organization`/`member` tables, `requireSession`'s resolution order, and
 * the credential route's gate as they actually behave wired together --
 * exactly the seam a mocked auth layer would paper over.
 */

let db: Db | undefined;

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
afterEach(async () => {
  emailMock.sendOrganizationInvitationEmail.mockClear();
  emailMock.sendMagicLinkEmail.mockClear();
  emailMock.sendInvitationAcceptedEmail.mockClear();
  emailMock.sendWorkspaceAccessRemovedEmail.mockClear();
  await db?.close();
  db = undefined;
});

async function freshDb(): Promise<Db> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  return db;
}

let emailSeq = 0;
function uniqueEmail(label: string): string {
  emailSeq += 1;
  return `${label}-${Date.now()}-${emailSeq}@example.test`;
}

interface SignedUp {
  agent: ReturnType<typeof request.agent>;
  userId: string;
  email: string;
}

/** Sign up a brand-new user through the REAL HTTP route (autoSignIn is on), returning a cookie-carrying agent. */
async function signUp(app: Express, label: string, name: string): Promise<SignedUp> {
  const email = uniqueEmail(label);
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct horse battery staple', name })
    .expect(200);
  return { agent, userId: (res.body as { user: { id: string } }).user.id, email };
}

interface SessionAuth {
  userId: string;
  workspaceId: string;
  email: string;
  role: 'owner' | 'member';
}

async function currentAuth(agent: ReturnType<typeof request.agent>): Promise<SessionAuth> {
  const res = await agent.get('/api/auth/session').expect(200);
  return (res.body as { auth: SessionAuth }).auth;
}

describe('magic-link sign-in', () => {
  it('emails a one-time sign-in URL and provisions a new workspace when it is followed', async () => {
    const database = await freshDb();
    const app = createApp(database);
    const email = uniqueEmail('magic');
    const agent = request.agent(app);

    await agent
      .post('/api/auth/sign-in/magic-link')
      .send({ email, callbackURL: '/', newUserCallbackURL: '/', errorCallbackURL: '/' })
      .expect(200);

    expect(emailMock.sendMagicLinkEmail).toHaveBeenCalledTimes(1);
    const sent = emailMock.sendMagicLinkEmail.mock.calls[0]![0];
    expect(sent.to).toBe(email);
    expect(sent.expiresMinutes).toBe(15);
    const signInUrl = new URL(sent.signInUrl);
    expect(signInUrl.pathname).toBe('/api/auth/magic-link/verify');

    await agent.get(`${signInUrl.pathname}${signInUrl.search}`).expect(302);
    const auth = await currentAuth(agent);
    expect(auth.email).toBe(email);
    expect(auth.role).toBe('owner');

    // Better Auth consumes the verification value atomically: the same link is
    // never a second login/session mint.
    const reused = await request(app).get(`${signInUrl.pathname}${signInUrl.search}`).expect(302);
    expect(String(reused.headers.location)).toContain('error=INVALID_TOKEN');
  });
});

describe('first sign-in (organization plugin routed, single-user flow unchanged)', () => {
  it('gives a brand-new email its own workspace, settings, default automation rules, audit event and marketing event', async () => {
    const database = await freshDb();
    const app = createApp(database);
    const { agent } = await signUp(app, 'solo', 'Solo Operator');

    const auth = await currentAuth(agent);
    expect(auth.role).toBe('owner');

    const settings = await database
      .prepare('SELECT sender_name,currency FROM workspace_settings WHERE workspace_id=?')
      .get<{ sender_name: string; currency: string }>(auth.workspaceId);
    expect(settings).toEqual({ sender_name: 'Solo Operator', currency: 'EUR' });

    const rules = await database
      .prepare('SELECT COUNT(*)::int AS n FROM automation_rules WHERE workspace_id=?')
      .get<{ n: number }>(auth.workspaceId);
    expect(rules?.n).toBe(4);

    const audit = await database
      .prepare(
        "SELECT COUNT(*)::int AS n FROM audit_events WHERE workspace_id=? AND event_type='workspace.created'"
      )
      .get<{ n: number }>(auth.workspaceId);
    expect(audit?.n).toBe(1);

    const marketing = await database
      .prepare(
        "SELECT COUNT(*)::int AS n FROM marketing_events WHERE workspace_id=? AND event_name='signup_completed'"
      )
      .get<{ n: number }>(auth.workspaceId);
    expect(marketing?.n).toBe(1);

    // The pinned-id architecture's whole point: the organization IS the workspace.
    const org = await database
      .prepare('SELECT id FROM organization WHERE id=?')
      .get<{ id: string }>(auth.workspaceId);
    expect(org?.id).toBe(auth.workspaceId);
    const member = await database
      .prepare(
        'SELECT role FROM member WHERE "organizationId"=? AND "userId"=(SELECT id FROM "user" WHERE lower(email)=?)'
      )
      .get<{ role: string }>(auth.workspaceId, auth.email.toLowerCase());
    expect(member?.role).toBe('owner');
  });
});

describe('two users, one workspace', () => {
  it("a member added to another workspace sees that workspace's data through the normal request flow", async () => {
    const database = await freshDb();
    const app = createApp(database);

    const owner = await signUp(app, 'owner', 'Owner Person');
    const ownerAuth = await currentAuth(owner.agent);

    const teammate = await signUp(app, 'teammate', 'Teammate Person');
    const teammateHome = await currentAuth(teammate.agent);
    expect(teammateHome.workspaceId).not.toBe(ownerAuth.workspaceId);

    await betterAuth.api.addMember({
      body: { userId: teammate.userId, organizationId: ownerAuth.workspaceId, role: 'member' }
    });
    await teammate.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: ownerAuth.workspaceId })
      .expect(200);

    const teammateNow = await currentAuth(teammate.agent);
    expect(teammateNow.workspaceId).toBe(ownerAuth.workspaceId);
    expect(teammateNow.role).toBe('member');

    const ownerDashboard = await owner.agent.get('/api/dashboard').expect(200);
    const teammateDashboard = await teammate.agent.get('/api/dashboard').expect(200);
    expect((teammateDashboard.body.workspace as { id: string }).id).toBe(ownerAuth.workspaceId);
    expect((teammateDashboard.body.workspace as { id: string }).id).toBe(
      (ownerDashboard.body.workspace as { id: string }).id
    );
  });
});

describe('POST /api/team/members (add teammate: always a real invitation, must be accepted)', () => {
  it('files a pending invitation for an existing account exactly like one for an email that has never signed in -- neither joins until they accept it themselves', async () => {
    const database = await freshDb();
    const app = createApp(database);

    const owner = await signUp(app, 'team-owner', 'Team Owner');
    const ownerAuth = await currentAuth(owner.agent);
    const teammate = await signUp(app, 'team-existing', 'Team Existing');

    // An email with an existing Trevra account gets a pending invitation, not
    // instant membership (design doc decision #3, superseded: nobody joins a
    // workspace without accepting it themselves, existing account or not).
    const invitedExisting = await owner.agent
      .post('/api/team/members')
      .send({ email: teammate.email });
    expect(invitedExisting.status).toBe(201);
    expect((invitedExisting.body as { status: string }).status).toBe('invited');
    const noMemberYet = await database
      .prepare(
        'SELECT role FROM member WHERE "organizationId"=? AND "userId"=(SELECT id FROM "user" WHERE lower(email)=?)'
      )
      .get<{ role: string }>(ownerAuth.workspaceId, teammate.email.toLowerCase());
    expect(noMemberYet).toBeUndefined();
    const invitationId = (invitedExisting.body as { invitation: { id: string } }).invitation.id;

    // An email that has never signed in still gets a real invitation --
    // identically shaped, so the adder learns nothing about which case it was.
    const neverSeenEmail = uniqueEmail('never-signed-in');
    const invited = await owner.agent.post('/api/team/members').send({ email: neverSeenEmail });
    expect(invited.status).toBe(201);
    expect((invited.body as { status: string }).status).toBe('invited');
    const invitationRow = await database
      .prepare('SELECT email,role,status FROM invitation WHERE "organizationId"=? AND email=?')
      .get<{ email: string; role: string; status: string }>(
        ownerAuth.workspaceId,
        neverSeenEmail.toLowerCase()
      );
    expect(invitationRow?.status).toBe('pending');

    // The existing-account teammate only joins once THEY accept it, with
    // their own session -- the same `organization.acceptInvitation` route the
    // never-seen-before case relies on (TeamScreen.tsx's AcceptInvitationPanel).
    const accept = await teammate.agent
      .post('/api/auth/organization/accept-invitation')
      .send({ invitationId })
      .expect(200);
    expect((accept.body as { member: { role: string } }).member.role).toBe('member');
    const memberRow = await database
      .prepare(
        'SELECT role FROM member WHERE "organizationId"=? AND "userId"=(SELECT id FROM "user" WHERE lower(email)=?)'
      )
      .get<{ role: string }>(ownerAuth.workspaceId, teammate.email.toLowerCase());
    expect(memberRow?.role).toBe('member');
    expect(emailMock.sendInvitationAcceptedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: owner.email,
        memberEmail: teammate.email,
        role: 'member'
      })
    );
  });

  it('is owner-only: a member operating in this workspace cannot add teammates to it', async () => {
    const database = await freshDb();
    const app = createApp(database);

    const owner = await signUp(app, 'team-gate-owner', 'Team Gate Owner');
    const ownerAuth = await currentAuth(owner.agent);
    const member = await signUp(app, 'team-gate-member', 'Team Gate Member');

    await betterAuth.api.addMember({
      body: { userId: member.userId, organizationId: ownerAuth.workspaceId, role: 'member' }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: ownerAuth.workspaceId })
      .expect(200);
    expect((await currentAuth(member.agent)).role).toBe('member');

    const attempt = await member.agent
      .post('/api/team/members')
      .send({ email: uniqueEmail('irrelevant') });
    expect(attempt.status).toBe(403);
  });
});

describe('companion member permissions', () => {
  const previousSecretsKey = process.env.TREVRA_SECRETS_KEY;

  afterEach(() => {
    if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
    else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
  });

  it('lets a member use and disconnect the paired computer but not pair or replace it', async () => {
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    const database = await freshDb();
    const app = createApp(database);

    const owner = await signUp(app, 'companion-owner', 'Companion Owner');
    const ownerAuth = await currentAuth(owner.agent);
    const member = await signUp(app, 'companion-member', 'Companion Member');
    await betterAuth.api.addMember({
      body: { userId: member.userId, organizationId: ownerAuth.workspaceId, role: 'member' }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: ownerAuth.workspaceId })
      .expect(200);
    expect((await currentAuth(member.agent)).role).toBe('member');

    const pairing = await owner.agent.post('/api/linkedin/companion/pair').send({}).expect(201);
    const exchange = await request(app)
      .post('/api/linkedin/companion/exchange')
      .send({
        code: pairing.body.code,
        label: 'Shared laptop'
      })
      .expect(201);

    const status = await member.agent.get('/api/linkedin/companion').expect(200);
    expect(status.body).toMatchObject({ canManage: false, canUse: true, canDisconnect: true });

    await member.agent.post('/api/linkedin/companion/pair').send({}).expect(403);
    await member.agent
      .delete(`/api/linkedin/companion/devices/${exchange.body.deviceId}`)
      .expect(200, { revoked: true });
  });
});

describe('credential route gate', () => {
  const previousDeploymentMode = process.env.TREVRA_DEPLOYMENT_MODE;
  const previousSecretsKey = process.env.TREVRA_SECRETS_KEY;

  afterEach(() => {
    if (previousDeploymentMode === undefined) delete process.env.TREVRA_DEPLOYMENT_MODE;
    else process.env.TREVRA_DEPLOYMENT_MODE = previousDeploymentMode;
    if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
    else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
  });

  it('403s a member and lets the owner through (200, or a deployment-fact 409 -- never 403)', async () => {
    delete process.env.TREVRA_DEPLOYMENT_MODE;
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');

    const database = await freshDb();
    const app = createApp(database);

    const owner = await signUp(app, 'cred-owner', 'Cred Owner');
    const ownerAuth = await currentAuth(owner.agent);

    const member = await signUp(app, 'cred-member', 'Cred Member');
    await betterAuth.api.addMember({
      body: { userId: member.userId, organizationId: ownerAuth.workspaceId, role: 'member' }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: ownerAuth.workspaceId })
      .expect(200);

    const memberAttempt = await member.agent
      .post('/api/linkedin/seat/credentials')
      .send({ email: 'seat@example.com', password: 'seat-password-123' });
    expect(memberAttempt.status).toBe(403);

    const ownerAttempt = await owner.agent
      .post('/api/linkedin/seat/credentials')
      .send({ email: 'seat@example.com', password: 'seat-password-123' });
    expect(ownerAttempt.status).toBe(200);
    expect(ownerAttempt.body).toEqual({ hasCredentials: true, maskedEmail: 's•••@example.com' });

    const memberDelete = await member.agent.delete('/api/linkedin/seat/credentials');
    expect(memberDelete.status).toBe(403);

    const ownerDelete = await owner.agent.delete('/api/linkedin/seat/credentials');
    expect(ownerDelete.status).toBe(200);
  });
});

describe('active-workspace resolution', () => {
  it("falls back to the removed member's own workspace on their next request -- no 500, no leaked access to the removed workspace", async () => {
    const database = await freshDb();
    const app = createApp(database);

    const owner = await signUp(app, 'switch-owner', 'Switch Owner');
    const ownerAuth = await currentAuth(owner.agent);

    const member = await signUp(app, 'switch-member', 'Switch Member');
    const memberHome = await currentAuth(member.agent);

    await betterAuth.api.addMember({
      body: { userId: member.userId, organizationId: ownerAuth.workspaceId, role: 'member' }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: ownerAuth.workspaceId })
      .expect(200);
    expect((await currentAuth(member.agent)).workspaceId).toBe(ownerAuth.workspaceId);

    await owner.agent
      .post('/api/auth/organization/remove-member')
      .send({ memberIdOrEmail: member.email, organizationId: ownerAuth.workspaceId })
      .expect(200);
    expect(emailMock.sendWorkspaceAccessRemovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: member.email,
        organizationName: expect.any(String)
      })
    );

    const afterRemoval = await member.agent.get('/api/auth/session');
    expect(afterRemoval.status).toBe(200);
    const auth = (afterRemoval.body as { auth: SessionAuth }).auth;
    expect(auth.workspaceId).toBe(memberHome.workspaceId);
    expect(auth.workspaceId).not.toBe(ownerAuth.workspaceId);
    expect(auth.role).toBe('owner');

    // The fallback stuck: the NEXT request does not re-derive it from scratch
    // and land somewhere else.
    const again = await currentAuth(member.agent);
    expect(again.workspaceId).toBe(memberHome.workspaceId);
  });
});

describe('backfill', () => {
  it('creates an organization + owner member for a pre-existing workspace, and is idempotent on a second run', async () => {
    const database = await freshDb();

    // Simulate a workspace that predates the organization plugin: a real
    // better-auth `user` (so an email lookup succeeds) plus a hand-inserted
    // Trevra `workspaces`/`users` row -- exactly the shape every workspace had
    // before this change, and never touched by resolveBetterAuthIdentity
    // (which only runs on an authenticated REQUEST, not from this direct call).
    const email = uniqueEmail('backfill');
    const signedUp = await betterAuth.api.signUpEmail({
      body: { email, password: 'correct horse battery staple', name: 'Backfill Owner' }
    });
    const workspaceId = id('ws');
    const userId = id('usr');
    const now = new Date().toISOString();
    await database
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, "Backfill Owner's Studio", now);
    await database
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(userId, workspaceId, email, 'Backfill Owner', now);
    // A pre-existing workspace already has its OWN settings row from before
    // this migration -- backfill's job is only to add the missing
    // organization/member, never to touch this.
    await database
      .prepare(
        'INSERT INTO workspace_settings (workspace_id,currency,sender_name,timezone,demo_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(workspaceId, 'EUR', 'Backfill Owner', 'Europe/Zurich', 0, now, now);

    const first = await backfillWorkspaceOrganizations(database);
    expect(first.created).toBeGreaterThanOrEqual(1);

    const org = await database
      .prepare('SELECT id,name FROM organization WHERE id=?')
      .get<{ id: string; name: string }>(workspaceId);
    expect(org?.id).toBe(workspaceId);
    const members = await database
      .prepare('SELECT role FROM member WHERE "organizationId"=?')
      .all<{ role: string }>(workspaceId);
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe('owner');

    // Provisioning did NOT re-run for this workspace (it already existed):
    // still exactly the one pre-existing workspace_settings row, untouched.
    const settings = await database
      .prepare('SELECT sender_name FROM workspace_settings WHERE workspace_id=?')
      .get<{ sender_name: string }>(workspaceId);
    expect(settings?.sender_name).toBe('Backfill Owner');

    const second = await backfillWorkspaceOrganizations(database);
    expect(second.created).toBe(0);

    const orgsAfterSecondRun = await database
      .prepare('SELECT COUNT(*)::int AS n FROM organization WHERE id=?')
      .get<{ n: number }>(workspaceId);
    expect(orgsAfterSecondRun?.n).toBe(1);
    const membersAfterSecondRun = await database
      .prepare('SELECT COUNT(*)::int AS n FROM member WHERE "organizationId"=?')
      .get<{ n: number }>(workspaceId);
    expect(membersAfterSecondRun?.n).toBe(1);

    // The workspace's own id never moved -- the whole point of pinning.
    const workspaceRow = await database
      .prepare('SELECT id FROM workspaces WHERE id=?')
      .get<{ id: string }>(workspaceId);
    expect(workspaceRow?.id).toBe(workspaceId);
  });

  it('skips the seeded demo workspace', async () => {
    const database = await freshDb();
    await backfillWorkspaceOrganizations(database);
    const demoOrg = await database
      .prepare('SELECT id FROM organization WHERE id=?')
      .get<{ id: string }>(DEMO_WORKSPACE_ID);
    expect(demoOrg).toBeUndefined();
  });
});

describe('last-owner protection', () => {
  it('rejects removing the sole owner', () => {
    const members = [{ userId: 'usr_a', role: 'owner' }];
    expect(() => assertOwnerChangeAllowed(members, 'usr_a', false)).toThrow(/only owner/i);
  });

  it('rejects demoting the sole owner away from the owner role', () => {
    const members = [
      { userId: 'usr_a', role: 'owner' },
      { userId: 'usr_b', role: 'member' }
    ];
    expect(() => assertOwnerChangeAllowed(members, 'usr_a', false)).toThrow(/only owner/i);
  });

  it('allows removing one of several owners', () => {
    const members = [
      { userId: 'usr_a', role: 'owner' },
      { userId: 'usr_b', role: 'owner' }
    ];
    expect(() => assertOwnerChangeAllowed(members, 'usr_a', false)).not.toThrow();
  });

  it('allows removing a plain member regardless of how many owners exist', () => {
    const members = [
      { userId: 'usr_a', role: 'owner' },
      { userId: 'usr_b', role: 'member' }
    ];
    expect(() => assertOwnerChangeAllowed(members, 'usr_b', false)).not.toThrow();
  });

  it('allows a role change that keeps the sole owner an owner (e.g. owner,admin)', () => {
    const members = [{ userId: 'usr_a', role: 'owner' }];
    expect(() => assertOwnerChangeAllowed(members, 'usr_a', true)).not.toThrow();
  });

  it("is wired into better-auth's own remove-member route, not only reachable from a future bespoke one", async () => {
    const database = await freshDb();
    const app = createApp(database);
    const owner = await signUp(app, 'last-owner', 'Last Owner');
    const ownerAuth = await currentAuth(owner.agent);

    const selfRemoval = await owner.agent
      .post('/api/auth/organization/remove-member')
      .send({ memberIdOrEmail: owner.email, organizationId: ownerAuth.workspaceId });
    expect(selfRemoval.status).toBeGreaterThanOrEqual(400);

    const stillMember = await database
      .prepare(
        'SELECT role FROM member WHERE "organizationId"=? AND "userId"=(SELECT id FROM "user" WHERE lower(email)=?)'
      )
      .get<{ role: string }>(ownerAuth.workspaceId, owner.email.toLowerCase());
    expect(stillMember?.role).toBe('owner');
  });
});
