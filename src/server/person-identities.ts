import { id, type Db } from './db.js';

export type PersonIdentityType = 'email' | 'phone' | 'profile_url' | 'handle' | string;

export function normalizePersonIdentity(identityType: PersonIdentityType, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  switch (identityType) {
    case 'email':
    case 'profile_url':
    case 'handle':
      return trimmed.toLowerCase();
    default:
      return trimmed;
  }
}

export async function upsertPersonIdentity(
  db: Db,
  input: {
    workspaceId: string;
    personId: string;
    provider: string;
    identityType: PersonIdentityType;
    identityValue: string;
  },
  now: Date = new Date()
): Promise<void> {
  const provider = input.provider.trim().toLowerCase();
  const identityType = String(input.identityType).trim().toLowerCase();
  const identityValue = input.identityValue.trim();
  const normalizedValue = normalizePersonIdentity(identityType, identityValue);
  if (!provider || !identityType || !normalizedValue) return;

  const existing = await db
    .prepare(
      `
      SELECT person_id FROM person_identities
      WHERE workspace_id=? AND provider=? AND identity_type=? AND normalized_value=?
      LIMIT 1
    `
    )
    .get<{ person_id: string }>(input.workspaceId, provider, identityType, normalizedValue);
  if (existing && existing.person_id !== input.personId) {
    throw new Error(
      `Person identity conflict: ${provider}/${identityType}/${normalizedValue} already belongs to another Person.`
    );
  }
  if (existing) return;

  await db
    .prepare(
      `
      INSERT INTO person_identities (
        id,workspace_id,person_id,provider,identity_type,identity_value,normalized_value,created_at
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (workspace_id,provider,identity_type,normalized_value) DO NOTHING
    `
    )
    .run(
      id('pid'),
      input.workspaceId,
      input.personId,
      provider,
      identityType,
      identityValue,
      normalizedValue,
      now.toISOString()
    );
}

export async function resolvePersonByIdentity(
  db: Db,
  input: {
    workspaceId: string;
    provider: string;
    identityType: PersonIdentityType;
    identityValue: string;
  }
): Promise<{ id: string; email: string | null } | null> {
  const provider = input.provider.trim().toLowerCase();
  const identityType = String(input.identityType).trim().toLowerCase();
  const normalizedValue = normalizePersonIdentity(identityType, input.identityValue);
  if (!provider || !identityType || !normalizedValue) return null;
  const row = await db
    .prepare(
      `
      SELECT p.id,p.email
      FROM person_identities i
      JOIN contacts p ON p.workspace_id=i.workspace_id AND p.id=i.person_id
      WHERE i.workspace_id=? AND i.provider=? AND i.identity_type=? AND i.normalized_value=?
      LIMIT 1
    `
    )
    .get<{ id: string; email: string | null }>(
      input.workspaceId,
      provider,
      identityType,
      normalizedValue
    );
  return row ?? null;
}

export async function accountForPerson(
  db: Db,
  workspaceId: string,
  personId: string | null
): Promise<string | null> {
  if (!personId) return null;
  const rows = await db
    .prepare(
      `
      SELECT account_id FROM account_contacts
      WHERE workspace_id=? AND contact_id=?
      ORDER BY updated_at DESC,account_id ASC
      LIMIT 2
    `
    )
    .all<{ account_id: string }>(workspaceId, personId);
  return rows.length === 1 ? rows[0]!.account_id : null;
}
