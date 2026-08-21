import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Copy, LoaderCircle, Pause, Play, Plus, Trash2, UserPlus } from 'lucide-react';
import {
  ApiError,
  addTeamMember,
  createAgent,
  getAgents,
  getAgentTokens,
  getWorkspaceSkills,
  updateAgent,
  type WorkspaceSkillManifest
} from './api';
import type { AgentPrincipal, AgentTokenSummary } from '../shared/types';
import { authClient, useIsWorkspaceOwner } from './auth-client';
import { relativeTime } from './LinkedInScreen';
import { reloadOutreach } from './LinkedInSafety';
import { ConfirmDrawer } from './ui/dialog';
import { Button, Field, Input, Select, Textarea } from './ui/primitives';
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

interface WorkspaceMember {
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
  return <TeamMembersPanel setToast={setToast} onNavigate={onNavigate} />;
}
function AgentSkillPicker({
  skills,
  selected,
  onToggle
}: {
  skills: WorkspaceSkillManifest[];
  selected: string[];
  onToggle: (skillId: string) => void;
}) {
  const enabled = skills.filter((skill) => skill.enabled);
  const disabledCount = skills.length - enabled.length;
  return (
    <details className="agent-skill-picker">
      <summary>
        Skills{' '}
        <span>
          {selected.length} of {enabled.length} selected
        </span>
      </summary>
      <div className="agent-skill-list">
        {enabled.map((skill) => (
          <label key={skill.id} className="agent-skill-option">
            <input
              type="checkbox"
              checked={selected.includes(skill.id)}
              onChange={() => onToggle(skill.id)}
            />
            <span>
              <strong>{skill.name}</strong>
              <small>{skill.description}</small>
              <small>
                {skill.sideEffect === 'none'
                  ? 'Computation only'
                  : skill.sideEffect === 'network-read'
                    ? 'Reads public network data'
                    : 'External write'}
                {skill.requiresApproval ? ' · approval required' : ''}
              </small>
            </span>
          </label>
        ))}
        {disabledCount > 0 && (
          <p className="empty-copy">
            {disabledCount} workspace skills are disabled and cannot be assigned.
          </p>
        )}
      </div>
    </details>
  );
}

function AgentTeamPanel({
  isOwner,
  setToast,
  onNavigate
}: {
  isOwner: boolean;
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [agents, setAgents] = useState<AgentPrincipal[]>([]);
  const [tokens, setTokens] = useState<AgentTokenSummary[]>([]);
  const [skills, setSkills] = useState<WorkspaceSkillManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [instructions, setInstructions] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPurpose, setEditPurpose] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [editSkillIds, setEditSkillIds] = useState<string[]>([]);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextAgents, nextTokens] = await Promise.all([getAgents(), getAgentTokens()]);
      setAgents(nextAgents);
      setTokens(nextTokens);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read Agents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void getWorkspaceSkills()
      .then((next) => {
        setSkills(next);
        setSkillIds(next.filter((skill) => skill.enabled).map((skill) => skill.id));
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Unable to read workspace skills.')
      )
      .finally(() => setSkillsLoading(false));
  }, []);

  const enabledSkillIds = () => skills.filter((skill) => skill.enabled).map((skill) => skill.id);
  const assignedSkillIds = (agent: AgentPrincipal): string[] => {
    const configured = agent.config.skillIds;
    if (!Array.isArray(configured)) return enabledSkillIds();
    const enabled = new Set(enabledSkillIds());
    return configured.filter((skillId) => enabled.has(skillId));
  };
  const skillName = (skillId: string) =>
    skills.find((skill) => skill.id === skillId)?.name ?? skillId;
  const toggle = (current: string[], skillId: string) =>
    current.includes(skillId) ? current.filter((id) => id !== skillId) : [...current, skillId];

  const create = async () => {
    const agentName = name.trim();
    const agentPurpose = purpose.trim();
    if (!agentName || !agentPurpose) return;
    setBusy('create');
    setError('');
    try {
      const created = await createAgent({
        name: agentName,
        purpose: agentPurpose,
        instructions: instructions.trim(),
        skillIds
      });
      setName('');
      setPurpose('');
      setInstructions('');
      setSkillIds(enabledSkillIds());
      setShowCreate(false);
      setToast(`${created.name} joined the GTM team with ${skillIds.length} skills.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create that Agent.');
    } finally {
      setBusy('');
    }
  };

  const beginEdit = (agent: AgentPrincipal) => {
    setEditingId(agent.id);
    setEditName(agent.name);
    setEditPurpose(agent.purpose);
    setEditInstructions(agent.config.instructions ?? '');
    setEditSkillIds(assignedSkillIds(agent));
    setError('');
  };

  const saveEdit = async (agent: AgentPrincipal) => {
    if (!editName.trim() || !editPurpose.trim()) return;
    setBusy(`edit-${agent.id}`);
    setError('');
    try {
      const updated = await updateAgent(agent.id, {
        name: editName.trim(),
        purpose: editPurpose.trim(),
        instructions: editInstructions.trim(),
        skillIds: editSkillIds
      });
      setEditingId(null);
      setToast(`${updated.name} updated.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update that Agent.');
    } finally {
      setBusy('');
    }
  };

  const setStatus = async (agent: AgentPrincipal, status: AgentPrincipal['status']) => {
    setBusy(agent.id);
    setError('');
    try {
      const updated = await updateAgent(agent.id, { status });
      setToast(
        status === 'active'
          ? `${updated.name} can accept GTM work again.`
          : `${updated.name} is ${status}. Existing credentials can no longer act as this Agent.`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to change that Agent.');
    } finally {
      setBusy('');
    }
  };

  const authorityFor = (agentId: string): string => {
    const scopes = [
      ...new Set(
        tokens
          .filter((token) => token.agentId === agentId && !token.revokedAt)
          .flatMap((token) => token.scopes)
      )
    ];
    return scopes.length ? scopes.join(', ') : 'No active credential scopes';
  };

  return (
    <section className="page-panel" id="agent-team">
      <div className="section-heading">
        <div>
          <h3>Agents</h3>
          <p>Define each worker’s job, operating instructions, and the GTM skills it may use.</p>
        </div>
        <div className="mgr-actions">
          {!loading && <span className="status-pill">{agents.length} on team</span>}
          {isOwner && !showCreate && (
            <Button
              variant="secondary"
              onClick={() => {
                setEditingId(null);
                setSkillIds(enabledSkillIds());
                setShowCreate(true);
              }}
            >
              <Plus size={14} /> Add Agent
            </Button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading ? (
        <p className="empty-copy">
          <LoaderCircle className="spin" size={14} /> Reading Agents…
        </p>
      ) : agents.length === 0 ? (
        <p className="workspace-empty">No Agents yet. Use Add Agent to define the first worker.</p>
      ) : (
        <div className="workspace-agent-list">
          {agents.map((agent) => {
            const assigned = assignedSkillIds(agent);
            const editing = editingId === agent.id;
            return (
              <article className="workspace-agent-card" key={agent.id}>
                <div className="workspace-agent-head">
                  <div>
                    <div className="workspace-agent-name">
                      <strong>{agent.name}</strong>
                      {agent.isDefault && <span>Default</span>}
                      <span
                        className={`connection-status ${agent.status === 'active' ? 'connected' : ''}`}
                      >
                        {agent.status}
                      </span>
                    </div>
                    <p>{agent.purpose}</p>
                  </div>
                  {isOwner && (
                    <div className="mgr-actions">
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => beginEdit(agent)}
                      >
                        Edit
                      </button>
                      {agent.status === 'active' ? (
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={busy === agent.id}
                          onClick={() => void setStatus(agent, 'paused')}
                        >
                          {busy === agent.id ? (
                            <LoaderCircle className="spin" size={13} />
                          ) : (
                            <Pause size={13} />
                          )}
                          Pause
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={busy === agent.id}
                          onClick={() => void setStatus(agent, 'active')}
                        >
                          {busy === agent.id ? (
                            <LoaderCircle className="spin" size={13} />
                          ) : (
                            <Play size={13} />
                          )}
                          Resume
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {agent.config.instructions && (
                  <div className="workspace-agent-instructions">
                    <strong>Instructions</strong>
                    <p>{agent.config.instructions}</p>
                  </div>
                )}

                <div className="workspace-agent-meta">
                  <span>{assigned.length} skills</span>
                  <span>{agent.runCount} runs</span>
                  <span>{agent.activeTokenCount} active credentials</span>
                  <span>{agent.scheduleEnabled ? 'Scheduled' : 'No schedule'}</span>
                </div>

                <div className="workspace-agent-skills">
                  {skillsLoading ? (
                    <span className="empty-copy">Reading skills…</span>
                  ) : assigned.length === 0 ? (
                    <span className="empty-copy">No modular skills assigned.</span>
                  ) : (
                    <>
                      {assigned.slice(0, 6).map((skillId) => (
                        <span key={skillId}>{skillName(skillId)}</span>
                      ))}
                      {assigned.length > 6 && <span>+{assigned.length - 6} more</span>}
                    </>
                  )}
                </div>

                <details className="agent-access-details">
                  <summary>Credential access</summary>
                  <p>{authorityFor(agent.id)}</p>
                  <p>
                    Skills control which modular GTM tools this Agent can use. Credential scopes
                    separately control which Trevra API surfaces its token can reach.
                  </p>
                  {isOwner && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onNavigate('/setup')}
                    >
                      Manage credentials & schedule
                    </button>
                  )}
                </details>

                {agent.latestRunId && (
                  <button
                    type="button"
                    className="li-mini-button"
                    onClick={() => onNavigate(`/ledger/run/${agent.latestRunId}`)}
                  >
                    Latest run · {agent.latestRunStatus ?? 'unknown'}
                  </button>
                )}

                {editing && isOwner && (
                  <div className="workspace-agent-editor">
                    <Field label="Agent name">
                      <Input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                      />
                    </Field>
                    <Field label="Purpose" hint="A short description of the job this Agent owns.">
                      <Textarea
                        rows={3}
                        value={editPurpose}
                        onChange={(event) => setEditPurpose(event.target.value)}
                      />
                    </Field>
                    <Field
                      label="Operating instructions"
                      hint="Persistent instructions added to this Agent’s run prompt."
                    >
                      <Textarea
                        rows={6}
                        value={editInstructions}
                        onChange={(event) => setEditInstructions(event.target.value)}
                        placeholder="Prioritize qualified ecommerce accounts. Cite evidence. Do not draft outreach until the account is scored…"
                      />
                    </Field>
                    <AgentSkillPicker
                      skills={skills}
                      selected={editSkillIds}
                      onToggle={(skillId) => setEditSkillIds((current) => toggle(current, skillId))}
                    />
                    <div className="mgr-actions">
                      <Button variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        disabled={
                          busy === `edit-${agent.id}` || !editName.trim() || !editPurpose.trim()
                        }
                        onClick={() => void saveEdit(agent)}
                      >
                        {busy === `edit-${agent.id}` && <LoaderCircle className="spin" size={14} />}
                        Save Agent
                      </Button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {isOwner && showCreate && (
        <div className="workspace-subsection workspace-agent-create">
          <div className="workspace-subsection-heading">
            <div>
              <h4>Add Agent</h4>
              <p>
                Create a distinct worker with its own purpose, instructions, skills, credentials,
                runs, and schedule.
              </p>
            </div>
          </div>
          <div className="workspace-agent-editor">
            <Field label="Agent name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Scout"
              />
            </Field>
            <Field label="Purpose" hint="What job should this Agent own?">
              <Textarea
                rows={3}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="Research and qualify target accounts for the outbound team."
              />
            </Field>
            <Field
              label="Operating instructions"
              hint="Multiline guidance that is injected into every hosted or CLI run for this Agent."
            >
              <Textarea
                rows={6}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Start with account evidence and recent signals. Prefer first-party sources. Explain why an account qualifies before preparing the next action…"
              />
            </Field>
            <AgentSkillPicker
              skills={skills}
              selected={skillIds}
              onToggle={(skillId) => setSkillIds((current) => toggle(current, skillId))}
            />
            <div className="mgr-actions">
              <Button
                variant="ghost"
                disabled={busy === 'create'}
                onClick={() => {
                  setName('');
                  setPurpose('');
                  setInstructions('');
                  setSkillIds(enabledSkillIds());
                  setShowCreate(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy === 'create' || !name.trim() || !purpose.trim() || skillsLoading}
                onClick={() => void create()}
              >
                {busy === 'create' ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Bot size={14} />
                )}
                Create Agent
              </Button>
            </div>
          </div>
        </div>
      )}

      <p className="empty-copy">
        Skills are an Agent’s modular GTM tools. Credential scopes are separate access permissions.
        Agents still cannot approve their own consequential external actions.
      </p>
    </section>
  );
}
function TeamMembersPanel({
  setToast,
  onNavigate
}: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
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
  const [showInvite, setShowInvite] = useState(false);
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
      setShowInvite(false);
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
      <div className="workspace-team-grid">
        <div className="workspace-team-column">
          <AgentTeamPanel isOwner={isOwner} setToast={setToast} onNavigate={onNavigate} />
        </div>

        <div className="workspace-team-column">
          <section className="page-panel" id="team">
            <div className="section-heading">
              <div>
                <h3>People & access</h3>
                <p>See who can enter this workspace and invite the next teammate from one place.</p>
              </div>
              <div className="mgr-actions">
                {!isPending && <span className="status-pill">{members.length} people</span>}
                {isOwner && !showInvite && (
                  <Button variant="secondary" onClick={() => setShowInvite(true)}>
                    <UserPlus size={14} /> Invite person
                  </Button>
                )}
              </div>
            </div>

            {isPending ? (
              <p className="empty-copy">Reading the member list…</p>
            ) : members.length === 0 ? (
              <p className="workspace-empty">No workspace members were returned.</p>
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

            {isOwner && showInvite && (
              <div className="workspace-subsection">
                <div className="workspace-subsection-heading">
                  <div>
                    <h4>Invite someone</h4>
                    <p>They receive workspace access only after accepting the invitation.</p>
                  </div>
                </div>
                {addError && <div className="error-banner">{addError}</div>}
                <div className="li-filter-row">
                  <Field label="Email">
                    <Input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="teammate@example.com"
                    />
                  </Field>
                  <Field label="Role">
                    <Select
                      value={role}
                      onChange={(event) => setRole(event.target.value as 'owner' | 'member')}
                    >
                      <option value="member">Member</option>
                      <option value="owner">Owner</option>
                    </Select>
                  </Field>
                  <div className="mgr-actions">
                    <Button
                      variant="ghost"
                      disabled={addBusy}
                      onClick={() => {
                        setEmail('');
                        setRole('member');
                        setAddError('');
                        setShowInvite(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      disabled={addBusy || !email.trim()}
                      onClick={() => void addTeammate()}
                    >
                      {addBusy ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <UserPlus size={14} />
                      )}
                      Send invite
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {isOwner &&
              (invitationsLoading || Boolean(invitationsError) || invitations.length > 0) && (
                <div className="workspace-subsection">
                  <div className="workspace-subsection-heading">
                    <h4>Pending invitations</h4>
                    {!invitationsLoading && invitations.length > 0 && (
                      <span>{invitations.length} pending</span>
                    )}
                  </div>
                  {invitationsError && <div className="error-banner">{invitationsError}</div>}
                  {invitationsLoading ? (
                    <p className="empty-copy">Reading pending invitations…</p>
                  ) : invitations.length > 0 ? (
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
                  ) : null}
                </div>
              )}
          </section>
        </div>
      </div>

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
