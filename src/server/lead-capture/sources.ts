import { randomBytes } from 'node:crypto';
import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import {
  openSecret,
  sealSecret,
  secretsConfigured,
  type SecretContext
} from '../secrets/crypto.js';
import type { CaptureSourceKind, CaptureSourceRecord } from './types.js';
import { LeadCaptureError } from './types.js';

const SECRET_PREFIX = 'trv_capture_';
const PREVIOUS_SECRET_OVERLAP_MS = 10 * 60 * 1000;

function sourceSecretContext(
  workspaceId: string,
  sourceId: string,
  slot: 'active' | 'previous'
): SecretContext {
  return {
    store: 'capture_source_secrets',
    workspaceId,
    seatKey: sourceId,
    kind: slot
  };
}

function toSource(row: Record<string, unknown>): CaptureSourceRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    key: String(row.key),
    kind: String(row.kind) as CaptureSourceKind,
    status: String(row.status) as 'active' | 'disabled',
    lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null,
    acceptedCount: Number(row.accepted_count ?? 0),
    rejectedCount: Number(row.rejected_count ?? 0),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

async function writeSecret(
  db: Db,
  workspaceId: string,
  sourceId: string,
  slot: 'active' | 'previous',
  plaintext: string,
  expiresAt: string | null,
  now: Date
): Promise<void> {
  const sealed = sealSecret(plaintext, sourceSecretContext(workspaceId, sourceId, slot));
  const at = now.toISOString();
  await db
    .prepare(
      `
      INSERT INTO capture_source_secrets (
        id,workspace_id,capture_source_id,slot,ciphertext,iv,auth_tag,key_version,key_id,expires_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (capture_source_id,slot) DO UPDATE SET
        ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,
        key_version=excluded.key_version,key_id=excluded.key_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at
    `
    )
    .run(
      id('css'),
      workspaceId,
      sourceId,
      slot,
      sealed.ciphertext,
      sealed.iv,
      sealed.authTag,
      sealed.keyVersion,
      sealed.keyId,
      expiresAt,
      at,
      at
    );
}

async function readSecret(
  db: Db,
  source: CaptureSourceRecord,
  slot: 'active' | 'previous',
  now: Date = new Date()
): Promise<string | null> {
  const row = await db
    .prepare(
      `
      SELECT ciphertext,iv,auth_tag,key_version,key_id,expires_at
      FROM capture_source_secrets
      WHERE workspace_id=? AND capture_source_id=? AND slot=?
    `
    )
    .get<Record<string, unknown>>(source.workspaceId, source.id, slot);
  if (!row) return null;
  if (
    slot === 'previous' &&
    row.expires_at &&
    new Date(String(row.expires_at)).getTime() <= now.getTime()
  )
    return null;
  return openSecret(
    {
      ciphertext: Buffer.from(row.ciphertext as Buffer),
      iv: Buffer.from(row.iv as Buffer),
      authTag: Buffer.from(row.auth_tag as Buffer),
      keyVersion: Number(row.key_version),
      keyId: row.key_id ? String(row.key_id) : null
    },
    sourceSecretContext(source.workspaceId, source.id, slot)
  );
}

export async function createCaptureSource(
  db: Db,
  input: { workspaceId: string; actorUserId: string; name: string; kind: CaptureSourceKind },
  now: Date = new Date()
): Promise<{ source: CaptureSourceRecord; secret: string }> {
  if (!secretsConfigured())
    throw new LeadCaptureError(
      'This deployment cannot create capture secrets without TREVRA_SECRETS_KEY.',
      409
    );
  const sourceId = id('cap');
  const secret = `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  const at = now.toISOString();
  const source = await db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `
        INSERT INTO capture_sources (
          id,workspace_id,name,key,kind,status,created_by_user_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,'active',?,?,?) RETURNING *
      `
      )
      .get<Record<string, unknown>>(
        sourceId,
        input.workspaceId,
        input.name.trim(),
        sourceId,
        input.kind,
        input.actorUserId,
        at,
        at
      );
    if (!row) throw new Error('Capture source could not be created');
    await writeSecret(tx, input.workspaceId, sourceId, 'active', secret, null, now);
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'capture_source',
      streamId: sourceId,
      eventType: 'capture_source.created',
      actorType: 'human',
      actorId: input.actorUserId,
      payload: { name: input.name.trim(), kind: input.kind }
    });
    return toSource(row);
  });
  return { source, secret };
}

export async function getCaptureSourceById(
  db: Db,
  sourceId: string
): Promise<CaptureSourceRecord | null> {
  const row = await db
    .prepare('SELECT * FROM capture_sources WHERE id=? LIMIT 1')
    .get<Record<string, unknown>>(sourceId);
  return row ? toSource(row) : null;
}

export async function getWorkspaceCaptureSource(
  db: Db,
  workspaceId: string,
  sourceId: string
): Promise<CaptureSourceRecord | null> {
  const row = await db
    .prepare('SELECT * FROM capture_sources WHERE id=? AND workspace_id=? LIMIT 1')
    .get<Record<string, unknown>>(sourceId, workspaceId);
  return row ? toSource(row) : null;
}

export async function listCaptureSources(
  db: Db,
  workspaceId: string
): Promise<CaptureSourceRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM capture_sources WHERE workspace_id=? ORDER BY created_at DESC')
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(toSource);
}

export async function setCaptureSourceStatus(
  db: Db,
  input: {
    workspaceId: string;
    sourceId: string;
    status: 'active' | 'disabled';
    actorUserId: string;
  },
  now: Date = new Date()
): Promise<CaptureSourceRecord | null> {
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        'UPDATE capture_sources SET status=?,updated_at=? WHERE id=? AND workspace_id=? RETURNING *'
      )
      .get<Record<string, unknown>>(
        input.status,
        now.toISOString(),
        input.sourceId,
        input.workspaceId
      );
    if (!row) return null;
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'capture_source',
      streamId: input.sourceId,
      eventType: `capture_source.${input.status}`,
      actorType: 'human',
      actorId: input.actorUserId
    });
    return toSource(row);
  });
}

export async function rotateCaptureSourceSecret(
  db: Db,
  input: { workspaceId: string; sourceId: string; actorUserId: string },
  now: Date = new Date()
): Promise<{ source: CaptureSourceRecord; secret: string }> {
  if (!secretsConfigured())
    throw new LeadCaptureError(
      'This deployment cannot rotate capture secrets without TREVRA_SECRETS_KEY.',
      409
    );
  const source = await getWorkspaceCaptureSource(db, input.workspaceId, input.sourceId);
  if (!source) throw new LeadCaptureError('Capture source not found', 404);
  const current = await readSecret(db, source, 'active', now);
  if (!current) throw new LeadCaptureError('Capture source has no readable active secret', 409);
  const next = `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  const previousExpiresAt = new Date(now.getTime() + PREVIOUS_SECRET_OVERLAP_MS).toISOString();
  await db.transaction(async (tx) => {
    await writeSecret(
      tx,
      input.workspaceId,
      input.sourceId,
      'previous',
      current,
      previousExpiresAt,
      now
    );
    await writeSecret(tx, input.workspaceId, input.sourceId, 'active', next, null, now);
    await tx
      .prepare('UPDATE capture_sources SET updated_at=? WHERE id=? AND workspace_id=?')
      .run(now.toISOString(), input.sourceId, input.workspaceId);
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'capture_source',
      streamId: input.sourceId,
      eventType: 'capture_source.secret_rotated',
      actorType: 'human',
      actorId: input.actorUserId,
      payload: { previousSecretExpiresAt: previousExpiresAt }
    });
  });
  return {
    source: (await getWorkspaceCaptureSource(db, input.workspaceId, input.sourceId))!,
    secret: next
  };
}

export async function readCaptureSourceSigningSecrets(
  db: Db,
  source: CaptureSourceRecord,
  now: Date = new Date()
): Promise<string[]> {
  const active = await readSecret(db, source, 'active', now);
  const previous = await readSecret(db, source, 'previous', now);
  return [active, previous].filter((value): value is string => Boolean(value));
}

export async function recordCaptureSourceAccepted(
  db: Db,
  sourceId: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare(
      `
      UPDATE capture_sources
      SET accepted_count=accepted_count+1,last_seen_at=?,updated_at=?
      WHERE id=?
    `
    )
    .run(now.toISOString(), now.toISOString(), sourceId);
}

export async function recordCaptureSourceRejected(
  db: Db,
  sourceId: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare('UPDATE capture_sources SET rejected_count=rejected_count+1,updated_at=? WHERE id=?')
    .run(now.toISOString(), sourceId);
}
