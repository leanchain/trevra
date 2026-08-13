import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

/**
 * The `organization` plugin (docs/superpowers/specs/2026-08-13-team-
 * workspace-access-design.md): unlocks `authClient.organization.*` --
 * `list`, `setActive`, `listMembers`, `removeMember`, `listInvitations`,
 * `acceptInvitation`, `cancelInvitation` -- and the reactive hooks built off
 * the same atoms, `useListOrganizations()` and `useActiveOrganization()`
 * (the latter also carries `members`/`invitations` for the workspace the
 * session currently has active -- see `useWorkspaceMembers` in
 * TeamScreen.tsx, the one place this app reads that list).
 *
 * `organization.createInvitation` is NOT called from here: it is a
 * server-only endpoint in better-auth's own plugin (see `crud-invites.mjs`)
 * that needs the inviter's own session on the server, which is why
 * `POST /api/team/members` (src/server/app.ts) exists as a bespoke route.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [organizationClient()]
});
