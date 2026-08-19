import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, LoaderCircle, Trash2, UserPlus } from 'lucide-react';
import { ApiError, addTeamMember } from './api';
import { authClient, useIsWorkspaceOwner } from './auth-client';
import { relativeTime } from './LinkedInScreen';
import { reloadOutreach } from './LinkedInSafety';
import { ConfirmDrawer } from './ui/dialog';
import type { Route } from './ui/route';

/**
 * `/setup/team` -- who is in this workspace, and the one owner-only control
 * over who joins or leaves it (docs/superpowers/specs/2026-08-13-team-
 * workspace-access-design.md).
 *
 * EVERYTHING ELSE ON THIS SCREEN IS READ-ONLY FOR A MEMBER, ON PURPOSE. The
 * design's access decision is full workspace parity for any member -- the
 * one and only role-gated action anywhere in this product is who manages the
 * stored LinkedIn credentials (already enforced server-side, see the save/
 * delete routes in app.ts) plus, by the same reasoning, who manages who is IN
 * the workspace at all. Hiding Add/Remove from a member here is a courtesy:
 * the boundary a member cannot cross is the server 403ing `/api/team/members`
 * and better-auth's own `beforeRemoveMember`/`beforeUpdateMemberRole` hooks
 * (`assertOwnerChangeAllowed` in auth-service.ts) rejecting the request
 * outright, not this screen choosing not to render a button.
 */

/* -------------------------------------------------------------------------
 * Who is in the active workspace -- one read, shared with every "queued by
 * <name>" label elsewhere (LinkedInInbox.tsx, LinkedInScreen.tsx's
 * OutreachQueue). `useActiveOrganization()` already reads better-auth's own
 * `/organization/get-full-organization`, which returns the workspace's
 * members -- each with `user.name`/`user.email` already joined -- in the same
 * read this screen needs for its own list. Nothing here is a second source of
 * truth for who is in the workspace; it is the one source, read once.
 * ---------------------------------------------------------------------- */

export interface WorkspaceMember {
  /** The `member` row's own id -- what `organization.removeMember` takes, not the user id. */
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
}

export function useWorkspaceMembers(): {
  members: WorkspaceMember[];
  /** null when nobody in the (already-read) member list has this user id -- never guessed at. */
  nameFor: (userId: string | null | undefined) => string | null;
} {
  const { data } = authClient.useActiveOrganization();
  const members = useMemo<WorkspaceMember[]>(() => {
    const rows =
      (
        data as {
          members?: Array<{
            id: string;
            userId: string;
            role: string;
            user?: { name?: string | null; email?: string | null };
          }>;
        } | null
      )?.members ?? [];
    return rows.map((member) => ({
      id: member.id,
      userId: member.userId,
      name: member.user?.name?.trim() || member.user?.email || 'A workspace member',
      email: member.user?.email ?? '',
      role: member.role
    }));
  }, [data]);

  const nameFor = useCallback(
    (userId: string | null | undefined): string | null => {
      if (!userId) return null;
      return members.find((member) => member.userId === userId)?.name ?? null;
    },
    [members]
  );

  return { members, nameFor };
}

interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
}

export function TeamSettingsView({
  route,
  setToast,
  reload,
  onNavigate
}: {
  route: Route;
  setToast: (message: string) => void;
  reload: () => Promise<void>;
  onNavigate: (path: string) => void;
}) {
  // `/setup/team/<invitationId>` -- the copyable link from "Pending
  // invitations" below, opened by the invitee. Not a member of this
  // workspace yet (that is the whole point), so it renders its own small
  // panel instead of the member list, which a non-member's own read of
  // `useActiveOrganization` would not even include this workspace in.
  if (route.id) {
    return (
      <AcceptInvitationPanel
        invitationId={route.id}
        setToast={setToast}
        reload={reload}
        onNavigate={onNavigate}
      />
    );
  }
  return <TeamMembersPanel setToast={setToast} />;
}

function TeamMembersPanel({ setToast }: { setToast: (message: string) => void }) {
  const { data: activeOrg, isPending, refetch: refetchOrg } = authClient.useActiveOrganization();
  const isOwner = useIsWorkspaceOwner();
  const { members } = useWorkspaceMembers();

  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(true);
  const [invitationsError, setInvitationsError] = useState('');

  const loadInvitations = useCallback(async () => {
    setInvitationsLoading(true);
    const result = await authClient.organization.listInvitations();
    if (result.error) {
      setInvitationsError(result.error.message ?? 'Unable to read pending invitations.');
    } else {
      setInvitations(
        ((result.data ?? []) as unknown as PendingInvitation[]).filter(
          (entry) => entry.status === 'pending'
        )
      );
      setInvitationsError('');
    }
    setInvitationsLoading(false);
  }, []);

  useEffect(() => {
    void loadInvitations();
  }, [loadInvitations]);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'member'>('member');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');

  const addTeammate = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setAddBusy(true);
    setAddError('');
    try {
      // Always a real invitation now -- no email joins instantly, existing
      // Trevra account or not. When transactional SMTP is configured, Better
      // Auth emails the same invitation id automatically; the pending list
      // keeps a copy-link fallback for delivery failures or manual sharing.
      await addTeamMember({ email: trimmed, role });
      setEmail('');
      setRole('member');
      setToast(
        `Invitation created for ${trimmed}. Trevra will email it automatically when SMTP is configured.`
      );
      await loadInvitations();
    } catch (err) {
      setAddError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : 'Unable to add that teammate.'
      );
    } finally {
      setAddBusy(false);
    }
  };

  const [confirmRemove, setConfirmRemove] = useState<WorkspaceMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const removeMember = async () => {
    if (!confirmRemove || !activeOrg) return;
    setRemoveBusy(true);
    setRemoveError('');
    // The one error this button has to show plainly rather than as a generic
    // failure: better-auth's own `beforeRemoveMember` hook
    // (`assertOwnerChangeAllowed`, auth-service.ts) rejects removing the sole
    // remaining owner, and `result.error.message` is that rejection's own
    // sentence, rendered verbatim -- the same posture the LinkedIn screens take
    // on a safety-gate refusal: a decision, not a crash.
    const result = await authClient.organization.removeMember({
      memberIdOrEmail: confirmRemove.id,
      organizationId: (activeOrg as { id: string }).id
    });
    setRemoveBusy(false);
    if (result.error) {
      setRemoveError(result.error.message ?? 'Unable to remove that member.');
      return;
    }
    setConfirmRemove(null);
    setToast(`${confirmRemove.name} removed from this workspace.`);
    await refetchOrg();
  };

  const copyInviteLink = async (invitationId: string) => {
    const link = `${window.location.origin}/setup/team/${invitationId}`;
    try {
      await navigator.clipboard.writeText(link);
      setToast('Invite link copied. Use it as a fallback if email delivery is unavailable.');
    } catch {
      // No clipboard permission (or none in this browser): the toast becomes
      // the copy surface instead of a silent no-op.
      setToast(`Copy this link by hand: ${link}`);
    }
  };

  const [confirmCancelInvite, setConfirmCancelInvite] = useState<PendingInvitation | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState('');

  const cancelInvite = async () => {
    if (!confirmCancelInvite) return;
    setCancelBusy(true);
    setCancelError('');
    const result = await authClient.organization.cancelInvitation({
      invitationId: confirmCancelInvite.id
    });
    setCancelBusy(false);
    if (result.error) {
      setCancelError(result.error.message ?? 'Unable to cancel that invitation.');
      return;
    }
    setConfirmCancelInvite(null);
    setToast(`Invitation to ${confirmCancelInvite.email} canceled.`);
    await loadInvitations();
  };

  return (
    <div className="page-stack">
      <section className="page-panel" id="team">
        <div className="section-heading">
          <div>
            <h3>Who is in this workspace</h3>
          </div>
        </div>

        {isPending ? (
          <p className="empty-copy">Reading the member list…</p>
        ) : (
          <div className="li-table-scroll compact">
            <table className="li-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  {isOwner && <th />}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>{member.name}</td>
                    <td>{member.email}</td>
                    <td>{member.role}</td>
                    {isOwner && (
                      <td>
                        {member.role !== 'owner' && (
                          <button
                            className="li-mini-button li-mini-danger"
                            type="button"
                            disabled={removeBusy}
                            onClick={() => setConfirmRemove(member)}
                          >
                            <Trash2 size={13} /> Remove
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Owner-only, per the design doc's credential-management carve-out
        extended to "who is in the workspace at all" -- see the file header. A
        member simply does not see this section; the server 403 on
        `/api/team/members` is the actual boundary. */}
      {isOwner && (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3>Add a teammate</h3>
            </div>
          </div>

          {addError && <div className="error-banner">{addError}</div>}

          <div className="li-filter-row">
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@example.com"
              />
            </label>
            <label>
              Role
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as 'owner' | 'member')}
              >
                <option value="member">Member</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={addBusy || !email.trim()}
              onClick={() => void addTeammate()}
            >
              {addBusy ? <LoaderCircle className="spin" size={14} /> : <UserPlus size={14} />} Add
              teammate
            </button>
          </div>
        </section>
      )}

      {isOwner && (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3>Pending invitations</h3>
            </div>
          </div>

          {invitationsError && <div className="error-banner">{invitationsError}</div>}

          {invitationsLoading ? (
            <p className="empty-copy">Reading pending invitations…</p>
          ) : invitations.length === 0 ? (
            <p className="empty-copy">Nothing pending.</p>
          ) : (
            <div className="li-table-scroll compact">
              <table className="li-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>{invitation.email}</td>
                      <td>{invitation.role === 'owner' ? 'Owner' : 'Member'}</td>
                      <td>{relativeTime(invitation.expiresAt)}</td>
                      <td>
                        <div className="li-row-actions">
                          <button
                            className="li-mini-button"
                            type="button"
                            onClick={() => void copyInviteLink(invitation.id)}
                          >
                            <Copy size={13} /> Copy invite link
                          </button>
                          <button
                            className="li-mini-button li-mini-danger"
                            type="button"
                            disabled={cancelBusy}
                            onClick={() => setConfirmCancelInvite(invitation)}
                          >
                            <Trash2 size={13} /> Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {confirmRemove && (
        <ConfirmDrawer
          title={`Remove ${confirmRemove.name}?`}
          tone="danger"
          body={
            <>
              <p>
                {confirmRemove.name} loses access to this workspace immediately -- the inbox,
                campaigns, CRM, and everything else they could see here.
              </p>
              <p>
                They keep their own separate Trevra account and any other workspace they belong to.
              </p>
            </>
          }
          confirmLabel={`Remove ${confirmRemove.name}`}
          busy={removeBusy}
          error={removeError || null}
          onCancel={() => {
            if (!removeBusy) {
              setConfirmRemove(null);
              setRemoveError('');
            }
          }}
          onConfirm={() => void removeMember()}
        />
      )}

      {confirmCancelInvite && (
        <ConfirmDrawer
          title={`Cancel the invitation to ${confirmCancelInvite.email}?`}
          tone="danger"
          body={
            <p>
              The invite link stops working immediately. {confirmCancelInvite.email} will need a
              fresh invitation to join.
            </p>
          }
          confirmLabel="Cancel invitation"
          busy={cancelBusy}
          error={cancelError || null}
          onCancel={() => {
            if (!cancelBusy) {
              setConfirmCancelInvite(null);
              setCancelError('');
            }
          }}
          onConfirm={() => void cancelInvite()}
        />
      )}
    </div>
  );
}

interface InvitationDetail {
  id: string;
  email: string;
  role: string;
  organizationName?: string;
  status: string;
}

/**
 * The far end of a copied invite link -- signed in already (this route is
 * inside the authenticated shell), reading the one invitation named in the
 * URL and deciding whether to join.
 */
function AcceptInvitationPanel({
  invitationId,
  setToast,
  reload,
  onNavigate
}: {
  invitationId: string;
  setToast: (message: string) => void;
  reload: () => Promise<void>;
  onNavigate: (path: string) => void;
}) {
  const [invitation, setInvitation] = useState<InvitationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void authClient.organization.getInvitation({ query: { id: invitationId } }).then((result) => {
      if (!active) return;
      if (result.error)
        setError(result.error.message ?? 'This invitation link is no longer valid.');
      else setInvitation(result.data as unknown as InvitationDetail);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [invitationId]);

  const accept = async () => {
    setBusy('accept');
    setError('');
    const result = await authClient.organization.acceptInvitation({ invitationId });
    setBusy(null);
    if (result.error) {
      setError(result.error.message ?? 'Unable to accept this invitation.');
      return;
    }
    setToast(`Joined ${invitation?.organizationName ?? 'the workspace'}. Switched into it now.`);
    // Accepting sets this as the active organization server-side (better-auth's
    // own `acceptInvitation` handler) -- the same "everything downstream is
    // stale" event a workspace switch is, so it gets the same broadcast: the
    // shell's own dashboard read, plus every mounted LinkedIn screen.
    await reload();
    await reloadOutreach();
    onNavigate('/setup/team');
  };

  const reject = async () => {
    setBusy('reject');
    setError('');
    const result = await authClient.organization.rejectInvitation({ invitationId });
    setBusy(null);
    if (result.error) {
      setError(result.error.message ?? 'Unable to decline this invitation.');
      return;
    }
    setToast('Invitation declined.');
    onNavigate('/setup/team');
  };

  return (
    <div className="page-stack">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3>Join a workspace</h3>
          </div>
        </div>

        {loading && <p className="empty-copy">Reading this invitation…</p>}

        {!loading && error && <div className="error-banner">{error}</div>}

        {!loading && !error && invitation && (
          <>
            <dl className="field-list">
              <div className="field-row">
                <dt>Workspace</dt>
                <dd>{invitation.organizationName ?? 'This workspace'}</dd>
              </div>
              <div className="field-row">
                <dt>Role</dt>
                <dd>{invitation.role}</dd>
              </div>
            </dl>
            <div className="panel-footer">
              <span>Nothing here is shared until you accept.</span>
              <span style={{ display: 'flex', gap: 10 }}>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void reject()}
                >
                  {busy === 'reject' ? <LoaderCircle className="spin" size={14} /> : 'Decline'}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void accept()}
                >
                  {busy === 'accept' ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    'Accept and switch to it'
                  )}
                </button>
              </span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
