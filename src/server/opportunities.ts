import { id, type Db } from './db.js';

export const OPPORTUNITY_STAGES = [
  'new',
  'qualified',
  'meeting',
  'proposal',
  'won',
  'lost'
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];
export type OpportunityOwnerType = 'user' | 'agent' | 'system';

export interface OpportunityRecord {
  id: string;
  workspaceId: string;
  personId: string | null;
  personName: string | null;
  personEmail: string | null;
  accountId: string | null;
  accountName: string | null;
  title: string;
  stage: OpportunityStage;
  ownerType: OpportunityOwnerType | null;
  ownerId: string | null;
  ownerName: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
  proposalSentAt: string | null;
  expectedResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export class OpportunityError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

const SELECT = `
  o.id,o.workspace_id,o.person_id,p.name AS person_name,p.email AS person_email,
  o.account_id,a.name AS account_name,o.title,o.stage,o.owner_type,o.owner_id,
  CASE
    WHEN o.owner_type='user' THEN u.name
    WHEN o.owner_type='agent' THEN ag.name
    WHEN o.owner_type='system' THEN 'Trevra'
    ELSE NULL
  END AS owner_name,
  o.next_action,o.next_action_at,o.proposal_sent_at,o.expected_response_at,
  o.created_at,o.updated_at,o.closed_at
`;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function serialize(row: Record<string, unknown>): OpportunityRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    personId: row.person_id ? String(row.person_id) : null,
    personName: row.person_name ? String(row.person_name) : null,
    personEmail: row.person_email ? String(row.person_email) : null,
    accountId: row.account_id ? String(row.account_id) : null,
    accountName: row.account_name ? String(row.account_name) : null,
    title: String(row.title),
    stage: String(row.stage) as OpportunityStage,
    ownerType: row.owner_type ? (String(row.owner_type) as OpportunityOwnerType) : null,
    ownerId: row.owner_id ? String(row.owner_id) : null,
    ownerName: row.owner_name ? String(row.owner_name) : null,
    nextAction: row.next_action ? String(row.next_action) : null,
    nextActionAt: iso(row.next_action_at),
    proposalSentAt: iso(row.proposal_sent_at),
    expectedResponseAt: iso(row.expected_response_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    closedAt: iso(row.closed_at)
  };
}

async function assertPerson(db: Db, workspaceId: string, personId: string | null): Promise<void> {
  if (!personId) return;
  const row = await db
    .prepare('SELECT 1 AS present FROM contacts WHERE workspace_id=? AND id=?')
    .get<{ present: number }>(workspaceId, personId);
  if (!row) throw new OpportunityError('Person not found in this workspace.', 400);
}

async function assertAccount(db: Db, workspaceId: string, accountId: string | null): Promise<void> {
  if (!accountId) return;
  const row = await db
    .prepare('SELECT 1 AS present FROM accounts WHERE workspace_id=? AND id=?')
    .get<{ present: number }>(workspaceId, accountId);
  if (!row) throw new OpportunityError('Account not found in this workspace.', 400);
}

async function assertOwner(
  db: Db,
  workspaceId: string,
  ownerType: OpportunityOwnerType | null,
  ownerId: string | null
): Promise<void> {
  if (!ownerType) {
    if (ownerId) throw new OpportunityError('ownerId requires ownerType.');
    return;
  }
  if (ownerType === 'system') {
    if (ownerId) throw new OpportunityError('System ownership does not take an ownerId.');
    return;
  }
  if (!ownerId) throw new OpportunityError(`${ownerType} ownership requires ownerId.`);
  const table = ownerType === 'user' ? 'users' : 'agents';
  const row = await db
    .prepare(`SELECT 1 AS present FROM ${table} WHERE workspace_id=? AND id=?`)
    .get<{ present: number }>(workspaceId, ownerId);
  if (!row)
    throw new OpportunityError(
      `${ownerType === 'user' ? 'User' : 'Agent'} owner not found in this workspace.`,
      400
    );
}

export async function listOpportunities(
  db: Db,
  workspaceId: string,
  filters: { stage?: OpportunityStage; limit?: number } = {}
): Promise<OpportunityRecord[]> {
  const params: unknown[] = [workspaceId];
  const clauses = ['o.workspace_id=?'];
  if (filters.stage) {
    clauses.push('o.stage=?');
    params.push(filters.stage);
  }
  params.push(Math.max(1, Math.min(filters.limit ?? 200, 500)));
  const rows = await db
    .prepare(
      `
    SELECT ${SELECT}
    FROM opportunities o
    LEFT JOIN contacts p ON p.workspace_id=o.workspace_id AND p.id=o.person_id
    LEFT JOIN accounts a ON a.workspace_id=o.workspace_id AND a.id=o.account_id
    LEFT JOIN users u ON o.owner_type='user' AND u.workspace_id=o.workspace_id AND u.id=o.owner_id
    LEFT JOIN agents ag ON o.owner_type='agent' AND ag.workspace_id=o.workspace_id AND ag.id=o.owner_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY CASE o.stage
      WHEN 'new' THEN 1 WHEN 'qualified' THEN 2 WHEN 'meeting' THEN 3
      WHEN 'proposal' THEN 4 WHEN 'won' THEN 5 ELSE 6 END,
      COALESCE(o.next_action_at,o.updated_at) ASC
    LIMIT ?
  `
    )
    .all<Record<string, unknown>>(...params);
  return rows.map(serialize);
}

export async function getOpportunity(
  db: Db,
  workspaceId: string,
  opportunityId: string
): Promise<OpportunityRecord | null> {
  const row = await db
    .prepare(
      `
    SELECT ${SELECT}
    FROM opportunities o
    LEFT JOIN contacts p ON p.workspace_id=o.workspace_id AND p.id=o.person_id
    LEFT JOIN accounts a ON a.workspace_id=o.workspace_id AND a.id=o.account_id
    LEFT JOIN users u ON o.owner_type='user' AND u.workspace_id=o.workspace_id AND u.id=o.owner_id
    LEFT JOIN agents ag ON o.owner_type='agent' AND ag.workspace_id=o.workspace_id AND ag.id=o.owner_id
    WHERE o.workspace_id=? AND o.id=?
  `
    )
    .get<Record<string, unknown>>(workspaceId, opportunityId);
  return row ? serialize(row) : null;
}

export async function createOpportunity(
  db: Db,
  input: {
    workspaceId: string;
    personId?: string | null;
    accountId?: string | null;
    title: string;
    stage?: OpportunityStage;
    ownerType?: OpportunityOwnerType | null;
    ownerId?: string | null;
    nextAction?: string | null;
    nextActionAt?: string | null;
  },
  now: Date = new Date()
): Promise<OpportunityRecord> {
  const personId = input.personId?.trim() || null;
  const accountId = input.accountId?.trim() || null;
  if (!personId && !accountId)
    throw new OpportunityError('Opportunity requires a Person or Account.');
  const title = input.title.trim();
  if (!title) throw new OpportunityError('Opportunity title is required.');
  await Promise.all([
    assertPerson(db, input.workspaceId, personId),
    assertAccount(db, input.workspaceId, accountId),
    assertOwner(db, input.workspaceId, input.ownerType ?? null, input.ownerId?.trim() || null)
  ]);
  const at = now.toISOString();
  const opportunityId = id('opp');
  await db
    .prepare(
      `
    INSERT INTO opportunities (
      id,workspace_id,person_id,account_id,title,stage,owner_type,owner_id,
      next_action,next_action_at,created_at,updated_at,closed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `
    )
    .run(
      opportunityId,
      input.workspaceId,
      personId,
      accountId,
      title,
      input.stage ?? 'new',
      input.ownerType ?? null,
      input.ownerId?.trim() || null,
      input.nextAction?.trim() || null,
      input.nextActionAt ?? null,
      at,
      at,
      ['won', 'lost'].includes(input.stage ?? '') ? at : null
    );
  return (await getOpportunity(db, input.workspaceId, opportunityId))!;
}

export async function updateOpportunity(
  db: Db,
  workspaceId: string,
  opportunityId: string,
  patch: Partial<{
    personId: string | null;
    accountId: string | null;
    title: string;
    stage: OpportunityStage;
    ownerType: OpportunityOwnerType | null;
    ownerId: string | null;
    nextAction: string | null;
    nextActionAt: string | null;
  }>,
  now: Date = new Date()
): Promise<OpportunityRecord | null> {
  const current = await getOpportunity(db, workspaceId, opportunityId);
  if (!current) return null;
  const personId = patch.personId === undefined ? current.personId : patch.personId?.trim() || null;
  const accountId =
    patch.accountId === undefined ? current.accountId : patch.accountId?.trim() || null;
  if (!personId && !accountId)
    throw new OpportunityError('Opportunity requires a Person or Account.');
  const ownerType = patch.ownerType === undefined ? current.ownerType : patch.ownerType;
  const ownerId = patch.ownerId === undefined ? current.ownerId : patch.ownerId?.trim() || null;
  await Promise.all([
    assertPerson(db, workspaceId, personId),
    assertAccount(db, workspaceId, accountId),
    assertOwner(db, workspaceId, ownerType, ownerId)
  ]);
  const title = patch.title === undefined ? current.title : patch.title.trim();
  if (!title) throw new OpportunityError('Opportunity title is required.');
  const stage = patch.stage ?? current.stage;
  const at = now.toISOString();
  const closedAt = ['won', 'lost'].includes(stage) ? (current.closedAt ?? at) : null;
  await db
    .prepare(
      `
    UPDATE opportunities SET
      person_id=?,account_id=?,title=?,stage=?,owner_type=?,owner_id=?,
      next_action=?,next_action_at=?,closed_at=?,updated_at=?
    WHERE workspace_id=? AND id=?
  `
    )
    .run(
      personId,
      accountId,
      title,
      stage,
      ownerType,
      ownerId,
      patch.nextAction === undefined ? current.nextAction : patch.nextAction?.trim() || null,
      patch.nextActionAt === undefined ? current.nextActionAt : patch.nextActionAt,
      closedAt,
      at,
      workspaceId,
      opportunityId
    );
  return getOpportunity(db, workspaceId, opportunityId);
}
