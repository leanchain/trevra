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
 * `organization.addMember` and `organization.createInvitation` are NOT
 * called from here: both are server-only endpoints in better-auth's own
 * plugin (see `crud-members.mjs`/`crud-invites.mjs`), which is why
 * `POST /api/team/members` (src/server/app.ts) exists as a bespoke route --
 * it is the one piece of "look up by email, add or invite" logic the plugin
 * does not expose to a browser at all.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [organizationClient()]
});
