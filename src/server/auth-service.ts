import 'dotenv/config';
import type { IncomingHttpHeaders } from 'node:http';
import pg from 'pg';
import { APIError, betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import { organization } from 'better-auth/plugins';
import type { Db } from './db.js';
import { DEMO_WORKSPACE_ID, id } from './db.js';
import {
  sendInvitationAcceptedEmail,
  sendOrganizationInvitationEmail,
  sendWorkspaceAccessRemovedEmail,
  smtpConfigured
} from './email.js';
import { recordMarketingEvent } from './public-site.js';

const { Pool } = pg;
const production = process.env.NODE_ENV === 'production';
// Hosted launch remains OAuth-only: SMTP below covers organization invitations,
// not account ownership verification/password recovery yet. Self-hosted keeps
// local email/password auth unchanged.
export const emailPasswordAuthEnabled = process.env.TREVRA_DEPLOYMENT_MODE !== 'hosted';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required; Better Auth uses PostgreSQL only');

const secret = process.env.BETTER_AUTH_SECRET ?? (production ? '' : 'development-only-trevra-secret-change-before-production');
if (production && secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters in production');

const baseURL = (process.env.BETTER_AUTH_URL ?? process.env.APP_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:43173').replace(/\/$/, '');
const trustedOrigins = (process.env.APP_ORIGIN ?? 'http://localhost:43173,http://localhost:43887')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
  throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together');
}

const socialProviders = googleClientId && googleClientSecret
  ? {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        disableDefaultScope: true,
        scope: ['openid', 'email', 'profile'],
        prompt: 'select_account' as const,
        redirectURI: `${baseURL}/api/auth/callback/google`
      }
    }
  : undefined;

const authPool = new Pool({
  connectionString,
  max: Number(process.env.AUTH_DATABASE_POOL_MAX ?? 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'trevra-auth'
});
authPool.on('error', (error) => console.error('Unexpected Better Auth PostgreSQL pool error', error));

/* ===========================================================================
 * Team workspace access (docs/superpowers/specs/2026-08-13-team-workspace-
 * access-design.md). `workspaces` stays Trevra's own table -- ~15 business
 * tables key off `workspace_id` and none of those foreign keys change -- but
 * it becomes a SHADOW ROW of a better-auth `organization`: `workspaces.id`
 * and `organization.id` are made to be the SAME VALUE, so every existing
 * `workspace_id` column keeps working as the join key into membership without
 * a mapping table.
 *
 * WHETHER AN ORGANIZATION'S ID CAN BE PINNED TO A CALLER-CHOSEN VALUE was the
 * spec's flagged open question, and it is answered here, not assumed:
 * verified against the installed better-auth (1.6.25) by reading
 * `organization/routes/crud-org.mjs` and proving it against a real Postgres
 * container before writing any of this file. Two facts make it possible:
 *
 *   1. `organizationHooks.beforeCreateOrganization` may return `{ data: {...} }`
 *      and EVERY key in `data` is merged over the row about to be created --
 *      including `id`, which is not part of the public `/organization/create`
 *      request schema (so it cannot be smuggled in over the wire) but is not
 *      blocked from arriving via this hook, which is application code we own.
 *   2. The organization adapter's own `createOrganization` calls the base
 *      adapter's `.create()` with `forceAllowId: true` unconditionally -- so
 *      an `id` present in the data at that point is written verbatim, not
 *      regenerated.
 *
 * What was missing was a way to tell `beforeCreateOrganization` WHICH id to
 * pin, since the hook only receives `{ organization, user }` -- no caller
 * context. `metadata` is the side channel: it is part of the public create
 * schema (`z.record(...)`, passthrough), so whatever a caller puts in
 * `body.metadata` survives into the hook untouched. `PINNED_WORKSPACE_ID_KEY`
 * carries the id there and is stripped back out before the row is written, so
 * it never ends up duplicated in the organization's own persisted metadata.
 * ======================================================================== */

/** Side-channel metadata key: see the block comment above for why this exists at all. */
const PINNED_WORKSPACE_ID_KEY = 'trevraPinnedWorkspaceId';
/** Same side channel, for the plain display name `afterCreateOrganization` writes into `workspace_settings.sender_name`. */
const SENDER_NAME_KEY = 'trevraSenderName';

/**
 * Workspace ids the BACKFILL has explicitly authorised a pin for, for as long
 * as its own `createOrganization` call is in flight.
 *
 * The pin side channel rides on `metadata`, which is part of better-auth's
 * PUBLIC create schema -- so `POST /api/auth/organization/create` can carry a
 * `trevraPinnedWorkspaceId` of the caller's choosing and better-auth will
 * grant that caller `role:'owner'` on whatever organization it creates. The
 * only thing that stopped an arbitrary workspace being adopted this way was a
 * primary-key collision on `organization.id`, which protects a workspace only
 * once it already HAS an organization row -- not a workspace provisioned by
 * SQL, and not one in the window before the backfill reaches it.
 *
 * So the guard is made explicit rather than left to the database: a pin at an
 * id that already names a `workspaces` row is refused unless it came from the
 * backfill, which is the one caller whose whole job is to create an
 * organization for a workspace that already exists. The set is a module
 * variable rather than a request-scoped value for the same reason the pin
 * itself is metadata: the hook receives `{ organization, user }` and no caller
 * context at all.
 */
const backfillAuthorisedPins = new Set<string>();

/**
 * The `Db` handle `afterCreateOrganization`/the backfill use to write Trevra's
 * own tables (`workspaces`, `workspace_settings`, `automation_rules`,
 * `audit_events`). Better-auth's plugin config is built once at module load,
 * before any `Db` exists, so the hook cannot close over one directly --
 * `createApp` (the one place every server entrypoint, including tests, wires
 * a `Db` to the rest of the app) calls `configureAuthProvisioning` as its
 * first line instead.
 */
let provisioningDb: Db | null = null;

/** Called once per `Db` (idempotent -- safe to call from both `createApp` and the boot-time backfill). */
export function configureAuthProvisioning(db: Db): void {
  provisioningDb = db;
}

function requireProvisioningDb(): Db {
  if (!provisioningDb) {
    throw new Error('Auth provisioning database not configured; call configureAuthProvisioning(db) before serving requests');
  }
  return provisioningDb;
}

/**
 * True when `role` (a possibly comma-joined string, e.g. `'owner,admin'`)
 * includes the workspace owner role. Comma-joining is better-auth's own
 * representation for multi-role members (`parseRoles` in the plugin); this
 * workspace only ever assigns a single role per member (spec Non-goals: no
 * custom access-control statements), but a plain `===` check would silently
 * stop recognising ownership the day that stops being true, so this parses
 * the same way the plugin does.
 */
function hasOwnerRole(role: string): boolean {
  return role.split(',').map((part) => part.trim()).includes('owner');
}

/**
 * The last-owner guard, as a pure function so it can be unit-tested with a
 * plain array -- no database, no better-auth, no hook plumbing.
 *
 * Better-auth does not protect a workspace from losing its last owner on its
 * own (spec "Error handling & edge cases"); this is Trevra's guard, wired
 * into `organizationHooks.beforeRemoveMember` / `beforeUpdateMemberRole`
 * below so it runs for every removal or role change, including ones made
 * through better-auth's own auto-mounted `/api/auth/organization/*` routes --
 * not just a future bespoke Team-settings route.
 *
 * `targetRetainsOwnerRole` is what tells the same function apart for a
 * removal (always `false`: removing a member drops every role) and a role
 * update (`true` when the new role still includes `owner`, in which case
 * there is nothing to guard against no matter how many owners exist).
 */
export function assertOwnerChangeAllowed(
  members: ReadonlyArray<{ userId: string; role: string }>,
  targetUserId: string,
  targetRetainsOwnerRole: boolean
): void {
  if (targetRetainsOwnerRole) return;
  const owners = members.filter((member) => hasOwnerRole(member.role));
  const targetIsOwner = owners.some((owner) => owner.userId === targetUserId);
  if (targetIsOwner && owners.length <= 1) {
    throw new APIError('BAD_REQUEST', { message: 'Cannot remove or demote the only owner of a workspace' });
  }
}

/**
 * The organization's current members, read straight from better-auth's own
 * `member` table.
 *
 * Raw SQL against a better-auth-managed table, and deliberately so: this is a
 * READ of the table's oldest, most stable columns (`organizationId`,
 * `userId`, `role` have existed since the plugin's first release), used only
 * to feed the pure guard above. `organizationHooks.beforeRemoveMember` /
 * `beforeUpdateMemberRole` do not receive the full member list or a request
 * context (see their types in `better-auth/plugins/organization`), so there
 * is no `auth.api.listMembers`-shaped call available from inside a hook --
 * that endpoint requires session headers this code does not have. Every
 * WRITE this file makes to better-auth's tables still goes through
 * `auth.api.*`, never raw SQL -- see the block comment above.
 */
async function listOrganizationMembers(organizationId: string): Promise<Array<{ userId: string; role: string }>> {
  const result = await authPool.query<{ userId: string; role: string }>(
    'SELECT "userId","role" FROM member WHERE "organizationId"=$1',
    [organizationId]
  );
  return result.rows;
}

export const auth = betterAuth({
  appName: 'Trevra',
  database: authPool,
  secret,
  baseURL,
  basePath: '/api/auth',
  trustedOrigins,
  emailAndPassword: {
    enabled: emailPasswordAuthEnabled,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    autoSignIn: true
  },
  socialProviders,
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24
  },
  advanced: {
    cookiePrefix: 'trevra',
    // Production normally means Secure cookies. The one exception is the
    // loopback-only single-operator deployment validated in config.ts, where no
    // request leaves the machine and HTTP avoids requiring a private local CA.
    useSecureCookies: production && process.env.COOKIE_SECURE !== 'false'
  },
  plugins: [
    // Default roles only (owner / admin / member), no custom access-control
    // statements and no teams -- spec Non-goals. This workspace uses exactly
    // two of the three: 'owner' (the credential-management carve-out) and
    // 'member' (everyone else, full data parity).
    organization({
      ...(smtpConfigured() ? {
        sendInvitationEmail: async (data) => {
          try {
            await sendOrganizationInvitationEmail({
              to: data.email,
              inviteLink: `${baseURL}/setup/team/${encodeURIComponent(data.id)}`,
              inviterName: data.inviter.user.name,
              inviterEmail: data.inviter.user.email,
              organizationName: data.organization.name,
              role: data.role,
              expiresAt: data.invitation.expiresAt
            });
          } catch (error) {
            // The invitation itself remains usable through the copy-link fallback.
            // Do not turn a transient SMTP failure into a failed membership write.
            console.error('Failed to deliver Trevra organization invitation email', error);
          }
        }
      } : {}),
      organizationHooks: {
        // Pins `organization.id` to the workspace id the caller chose -- see the
        // block comment above this section for the full mechanism.
        beforeCreateOrganization: async ({ organization: orgData }) => {
          const metadata = (orgData.metadata ?? {}) as Record<string, unknown>;
          const pinnedId = typeof metadata[PINNED_WORKSPACE_ID_KEY] === 'string' ? (metadata[PINNED_WORKSPACE_ID_KEY] as string) : undefined;
          // Every call site in this codebase pins one (resolveBetterAuthIdentity's
          // first-sign-in path and the boot-time backfill); a call with no pinned
          // id would only come from something outside this file, which nothing
          // does today. Falling through to the plugin's default `generateId`
          // rather than throwing keeps that theoretical caller working instead of
          // breaking on a codepath this design never intended to constrain.
          if (!pinnedId) return;
          // AN EXISTING WORKSPACE MAY ONLY BE PINNED BY THE BACKFILL. See
          // `backfillAuthorisedPins`: every other caller that reaches here is
          // an HTTP `/organization/create`, and a request must not be able to
          // name a workspace somebody else already has.
          if (!backfillAuthorisedPins.has(pinnedId)) {
            const existing = await requireProvisioningDb()
              .prepare('SELECT id FROM workspaces WHERE id=?')
              .get<{ id: string }>(pinnedId);
            if (existing) throw new APIError('FORBIDDEN', { message: 'That workspace id is already in use' });
          }
          // SENDER_NAME_KEY is deliberately NOT stripped here (only the id is):
          // `afterCreateOrganization` below reads it back off the PERSISTED
          // organization's metadata to seed `workspace_settings.sender_name`,
          // and that hook only ever sees the metadata as it ends up stored --
          // stripping it here would mean nothing downstream could ever read it.
          const { [PINNED_WORKSPACE_ID_KEY]: _pinned, ...restMetadata } = metadata;
          return { data: { id: pinnedId, metadata: Object.keys(restMetadata).length > 0 ? restMetadata : undefined } };
        },
        // Does what resolveBetterAuthIdentity's hand-rolled transaction used to do
        // on first sign-in: insert `workspaces`, `workspace_settings`, the default
        // `automation_rules`, and the `workspace.created` audit + marketing events
        // -- now keyed by the organization's (pinned) id instead of a fresh one
        // minted in the same transaction.
        //
        // ALSO THE BACKFILL'S PROVISIONING STEP, for the SAME workspace id, and
        // that is exactly why the guard below exists: backfill creates an
        // organization for a workspace that already has a `workspaces` row (and
        // `workspace_settings`, and rules, and history) -- this hook must not
        // re-create any of that a second time for the backfilled case. One guard
        // ("does a workspaces row already exist for this id") correctly serves
        // both callers: absent means genuinely new (fresh sign-in), present means
        // backfill (skip everything below, the row already has all of this).
        afterCreateOrganization: async ({ organization: org, user }) => {
          const db = requireProvisioningDb();
          const now = new Date().toISOString();
          await db.transaction(async (tx) => {
            const already = await tx.prepare('SELECT id FROM workspaces WHERE id=?').get<{ id: string }>(org.id);
            if (already) return;

            const metadata = (org.metadata ?? {}) as Record<string, unknown>;
            const senderName = typeof metadata[SENDER_NAME_KEY] === 'string' ? (metadata[SENDER_NAME_KEY] as string) : org.name;

            await tx.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(org.id, org.name, now);
            await tx.prepare('INSERT INTO workspace_settings (workspace_id,currency,sender_name,timezone,demo_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
              .run(org.id, 'EUR', senderName, 'Europe/Zurich', 0, now, now);
            await createDefaultAutomationRules(tx, org.id, now);
            await tx.prepare('INSERT INTO audit_events (id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
              .run(id('audit'), org.id, 'system', null, 'workspace.created', 'workspace', org.id, JSON.stringify({ authUserId: user.id }), now);
            await recordMarketingEvent(tx, { eventName: 'signup_completed', workspaceId: org.id, metadata: { source: 'authenticated_identity' } });
          });
        },
        // Last-owner protection (spec "Error handling & edge cases"). Wired here
        // rather than only in a future bespoke route so it protects better-auth's
        // own auto-mounted `/organization/remove-member` and
        // `/organization/update-member-role` from day one -- see the doc comment
        // on `assertOwnerChangeAllowed`.
        afterAcceptInvitation: async ({ invitation, user, organization }) => {
          if (!smtpConfigured()) return;
          try {
            const inviter = await authPool.query<{ email: string; name: string }>(
              'SELECT email,name FROM "user" WHERE id=$1',
              [String(invitation.inviterId)]
            );
            const recipient = inviter.rows[0];
            if (!recipient?.email) return;
            await sendInvitationAcceptedEmail({
              to: recipient.email,
              memberName: user.name?.trim() || user.email,
              memberEmail: user.email,
              organizationName: organization.name,
              role: invitation.role,
              manageTeamUrl: `${baseURL}/setup/team`
            });
          } catch (error) {
            // Membership is already accepted at this point; notification failure
            // must never turn a successful join into an HTTP error.
            console.error('Failed to deliver Trevra invitation-accepted email', error);
          }
        },
        beforeRemoveMember: async ({ member, organization }) => {
          const members = await listOrganizationMembers(organization.id);
          assertOwnerChangeAllowed(members, member.userId, false);
        },
        afterRemoveMember: async ({ user, organization }) => {
          if (!smtpConfigured()) return;
          try {
            await sendWorkspaceAccessRemovedEmail({
              to: user.email,
              memberName: user.name?.trim() || user.email,
              organizationName: organization.name,
              signInUrl: baseURL,
              supportEmail: process.env.PUBLIC_SUPPORT_EMAIL
            });
          } catch (error) {
            // Access removal is the security action; notification is best effort
            // and must not resurrect or obscure the completed membership change.
            console.error('Failed to deliver Trevra workspace-access-removed email', error);
          }
        },
        beforeUpdateMemberRole: async ({ member, newRole, organization }) => {
          const members = await listOrganizationMembers(organization.id);
          assertOwnerChangeAllowed(members, member.userId, hasOwnerRole(newRole));
        }
      }
    })
  ]
});

export async function migrateAuthDatabase(): Promise<void> {
  const lockClient = await authPool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext('trevra-better-auth-migrations'))");
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('trevra-better-auth-migrations'))").catch(() => undefined);
    lockClient.release();
  }
}

/**
 * Who is signed in, and which workspace they OWN.
 *
 * "Own" is deliberate: this no longer resolves the workspace the caller is
 * currently OPERATING IN -- a member can operate in a workspace somebody else
 * owns -- it resolves identity (Trevra's own `users` row, kept for FK targets
 * that predate better-auth: `audit_events.actor_id`, `approvals.user_id`,
 * `putLinkedInCredentials`'s `actorUserId`, `linkedin_actions.queued_by_user_id`)
 * plus the one workspace this user's own account created, as a "home"
 * reference. `requireSession` (app.ts) is what turns this into the ACTIVE
 * workspace for a request, per the spec's "Active-workspace resolution":
 * reading `activeOrganizationId` off the session and falling back to the home
 * workspace returned here when it is absent or the membership behind it was
 * revoked.
 */
export async function resolveBetterAuthIdentity(db: Db, headers: IncomingHttpHeaders): Promise<{
  userId: string;
  email: string;
  homeWorkspaceId: string;
  activeOrganizationId: string | null;
} | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session?.user?.email) return null;

  const email = session.user.email.toLowerCase();
  const activeOrganizationId = session.session.activeOrganizationId ?? null;

  const existing = await db.prepare('SELECT id,workspace_id,email FROM users WHERE lower(email)=?')
    .get<{ id: string; workspace_id: string; email: string }>(email);
  if (existing) return { userId: existing.id, homeWorkspaceId: existing.workspace_id, email: existing.email, activeOrganizationId };

  const now = new Date().toISOString();
  const displayName = session.user.name?.trim() || email.split('@')[0];
  const workspaceId = id('ws');
  const userId = id('usr');

  // ORDER MATTERS, and it is the opposite of the old hand-rolled transaction's:
  // `users.workspace_id` is a NOT NULL foreign key into `workspaces`, so a
  // workspace row has to exist before anything can reference it. The
  // organization (and, via `afterCreateOrganization`, the matching
  // `workspaces`/`workspace_settings`/`automation_rules`/audit/marketing rows)
  // is therefore created FIRST. This is safe to do unconditionally, before
  // knowing whether this request will even end up being the one that creates
  // the `users` row below: `createOrganization` only returns once
  // `afterCreateOrganization` has already run and committed (it is `await`ed
  // inside the endpoint handler), so `workspaceId` is guaranteed to be a valid
  // FK target by the time the transaction below runs.
  //
  // `headers` carries this request's own valid session (`getSession` above
  // already proved that), so passing it lets better-auth resolve `user` from
  // the session itself.
  //
  // `keepCurrentActiveOrganization: true` -- WITHOUT it, `createOrganization`
  // unconditionally activates the org it just created on THIS session
  // (`if (ctx.context.session && !keepCurrentActiveOrganization) setActiveOrganization(...)`
  // in better-auth's own handler), which is wrong here in a case this
  // function cannot rule out: a better-auth `user`/session can already exist
  // -- with an `activeOrganizationId` already pointing at a workspace someone
  // ELSE added them to -- before this codebase's OWN `users` row for them
  // does (`addMember`/`setActiveOrganization` need only a better-auth user,
  // never a Trevra one). Unconditionally activating the freshly-created home
  // workspace would silently switch such a person OUT of the workspace they
  // were just added to, on their very next request. With the flag, a session
  // that already had an active org keeps it; a genuinely fresh session (no
  // active org yet) is picked up by `resolveActiveWorkspace`'s own fallback
  // (app.ts), which activates the new home workspace explicitly on this same
  // request -- so first-ever sign-in still lands there, just one step later.
  //
  // lc-debt: two concurrent first-ever sign-ins for the SAME brand-new email
  // can each reach this line and each create their own organization/workspace
  // before racing on the users-table unique(email) insert below; the loser's
  // organization/workspace is orphaned rather than cleaned up -- wasted rows,
  // not a reachable or referenced state (no `users` row ever points at it, and
  // nothing can sign into it). Upgrade path: a compensating
  // `auth.api.deleteOrganization` call in the catch block below, if this ever
  // shows up as real waste rather than a race on one specific fresh email.
  await auth.api.createOrganization({
    headers: fromNodeHeaders(headers),
    body: {
      name: `${displayName}'s Studio`,
      // Not a human-facing value (no UI reads an organization slug today) --
      // reusing the workspace id keeps it trivially unique with no extra
      // generation step.
      slug: workspaceId,
      keepCurrentActiveOrganization: true,
      metadata: { [PINNED_WORKSPACE_ID_KEY]: workspaceId, [SENDER_NAME_KEY]: displayName }
    }
  });

  // Trevra's own `users` row. The race guard (`SELECT ... FOR UPDATE`, then a
  // unique-violation catch) is unchanged from the pre-organization-plugin
  // version of this function: it still exists to avoid an unnecessary INSERT
  // (and the exception it would throw) when another concurrent request
  // already committed a users row for this email between the `existing` check
  // above and now.
  try {
    return await db.transaction(async (tx) => {
      const raced = await tx.prepare('SELECT id,workspace_id,email FROM users WHERE lower(email)=? FOR UPDATE')
        .get<{ id: string; workspace_id: string; email: string }>(email);
      if (raced) return { userId: raced.id, homeWorkspaceId: raced.workspace_id, email: raced.email, activeOrganizationId };
      await tx.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)').run(userId, workspaceId, email, displayName, now);
      return { userId, homeWorkspaceId: workspaceId, email, activeOrganizationId };
    });
  } catch (error) {
    const raced = await db.prepare('SELECT id,workspace_id,email FROM users WHERE lower(email)=?')
      .get<{ id: string; workspace_id: string; email: string }>(email);
    if (raced) return { userId: raced.id, homeWorkspaceId: raced.workspace_id, email: raced.email, activeOrganizationId };
    throw error;
  }
}

/**
 * Boot-time backfill: every pre-existing `workspaces` row (created before
 * this change, by the old hand-rolled transaction) has no better-auth
 * `organization` row behind it yet. For each one, create an organization
 * pinned to that SAME id (see the block comment near the top of this file)
 * and an `owner` member row for the workspace's existing user.
 *
 * IDEMPOTENT, and safe to run on every boot, the same way `migrateAuthDatabase`
 * already is: the discovery query only returns workspaces with no matching
 * `organization.id`, so a workspace this already ran for simply will not be a
 * candidate the second time. `afterCreateOrganization`'s own "does a
 * `workspaces` row already exist" guard is a second, independent line of
 * defence against ever re-provisioning `workspace_settings`/`automation_rules`
 * for one, in case this function is ever called concurrently with itself.
 *
 * NOT RAW SQL FOR THE WRITE, per the spec ("needs better-auth's own API to
 * create matching organization/member rows correctly", since its tables are
 * migration-runner-managed): every organization/member row is created through
 * `auth.api.createOrganization`, the same call `resolveBetterAuthIdentity`
 * makes, exercised as a "system action" (a `userId` with no session headers --
 * `createOrganization`'s own documented server-only path). The DISCOVERY read
 * (which workspaces are missing an organization, and which better-auth `user`
 * row owns each one) is raw SQL against `organization` and `user` -- both
 * read-only lookups on the plugin's oldest, most stable columns (id; id +
 * email), not a write that could disagree with the plugin's own schema
 * invariants.
 *
 * A workspace whose owner has no matching better-auth `user` row (looked up
 * by email) is skipped rather than failing the whole backfill: every real
 * `users` row today was itself created by a prior better-auth sign-in (that is
 * the only way `users` rows are created), so this should not happen for
 * production data -- but the seeded demo workspace's user, `usr_demo`
 * (`DEMO_WORKSPACE_ID`), is explicitly excluded up front rather than relying
 * on that fallback, since it is reset by `resetDemoData` and was never meant
 * to carry a real identity.
 */
export async function backfillWorkspaceOrganizations(db: Db): Promise<{ created: number; skipped: number }> {
  configureAuthProvisioning(db);

  const candidates = await db.prepare(`
    SELECT w.id AS workspace_id, w.name AS workspace_name, u.email AS user_email
    FROM workspaces w
    JOIN users u ON u.workspace_id = w.id
    WHERE w.id <> ?
      AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = w.id)
  `).all<{ workspace_id: string; workspace_name: string; user_email: string }>(DEMO_WORKSPACE_ID);

  let created = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const authUser = await authPool.query<{ id: string }>('SELECT id FROM "user" WHERE lower(email)=$1', [candidate.user_email.toLowerCase()]);
    const authUserId = authUser.rows[0]?.id;
    if (!authUserId) {
      // No better-auth account for this email yet -- nothing to backfill until
      // they actually sign in, at which point resolveBetterAuthIdentity's
      // `existing` branch finds the pre-existing `users` row and this workspace
      // is simply not a backfill candidate any more (the org gets created by a
      // future backfill run using the by-then-created auth user, or the
      // operator signs in and it is created by the normal sign-in path if the
      // email matches).
      skipped += 1;
      continue;
    }

    // The one caller allowed to pin at a workspace that already exists, and it
    // says so for exactly the length of its own call -- see
    // `backfillAuthorisedPins` and the guard in `beforeCreateOrganization`.
    backfillAuthorisedPins.add(candidate.workspace_id);
    try {
      await auth.api.createOrganization({
        body: {
          name: candidate.workspace_name,
          slug: candidate.workspace_id,
          userId: authUserId,
          // No live session here (system action, no headers), so better-auth's
          // own auto-activate side effect never fires regardless -- set
          // explicitly anyway so this call's intent matches the identical one in
          // resolveBetterAuthIdentity rather than relying on that being true.
          keepCurrentActiveOrganization: true,
          metadata: { [PINNED_WORKSPACE_ID_KEY]: candidate.workspace_id }
        }
      });
    } finally {
      backfillAuthorisedPins.delete(candidate.workspace_id);
    }
    created += 1;
  }

  return { created, skipped };
}

export async function closeAuthDatabase(): Promise<void> {
  await authPool.end();
}

async function createDefaultAutomationRules(db: Db, workspaceId: string, now: string): Promise<void> {
  const defaults = [
    ['stale_proposal', 'prepare', 0.85, 25000, 0, 1],
    ['overdue_invoice', 'prepare', 0.95, 5000, 0, 1],
    ['scope_creep', 'suggest', 0.9, 5000, 0, 1],
    ['unbilled_milestone', 'prepare', 0.95, 10000, 0, 1]
  ] as const;
  for (const rule of defaults) {
    await db.prepare('INSERT INTO automation_rules (id,workspace_id,recommendation_type,mode,min_confidence,max_amount,delay_minutes,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id('rule'), workspaceId, ...rule, now, now);
  }
}
