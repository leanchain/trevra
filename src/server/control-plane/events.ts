import type { Db } from '../db.js';
import { id } from '../db.js';

export interface DomainEventInput {
  workspaceId: string;
  streamType: string;
  streamId: string;
  eventType: string;
  actorType: string;
  actorId?: string | null;
  causationId?: string | null;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface DomainEvent {
  position: number;
  id: string;
  workspaceId: string;
  streamType: string;
  streamId: string;
  streamVersion: number;
  eventType: string;
  actorType: string;
  actorId: string | null;
  causationId: string | null;
  correlationId: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export async function appendDomainEvent(db: Db, input: DomainEventInput): Promise<DomainEvent> {
  const eventId = id('evt');
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();
  const row = await db.prepare(`
    WITH next_version AS (
      INSERT INTO event_streams (workspace_id,stream_type,stream_id,current_version,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT (workspace_id,stream_type,stream_id)
      DO UPDATE SET current_version=event_streams.current_version+1,updated_at=excluded.updated_at
      RETURNING current_version
    )
    INSERT INTO domain_events (
      id,workspace_id,stream_type,stream_id,stream_version,event_type,
      actor_type,actor_id,causation_id,correlation_id,payload_json,metadata_json,occurred_at
    )
    SELECT ?,?,?,?,next_version.current_version,?,?,?,?,?,?,?,?
    FROM next_version
    RETURNING *
  `).get<Record<string, unknown>>(
    input.workspaceId,
    input.streamType,
    input.streamId,
    1,
    occurredAt,
    eventId,
    input.workspaceId,
    input.streamType,
    input.streamId,
    input.eventType,
    input.actorType,
    input.actorId ?? null,
    input.causationId ?? null,
    input.correlationId ?? null,
    JSON.stringify(input.payload ?? {}),
    JSON.stringify(input.metadata ?? {}),
    occurredAt
  );
  if (!row) throw new Error('Domain event could not be appended');
  return serializeDomainEvent(row);
}

export async function listDomainEvents(
  db: Db,
  workspaceId: string,
  filters: { streamType?: string; streamId?: string; correlationId?: string; afterPosition?: number; limit?: number } = {}
): Promise<DomainEvent[]> {
  const clauses = ['workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.streamType) { clauses.push('stream_type=?'); params.push(filters.streamType); }
  if (filters.streamId) { clauses.push('stream_id=?'); params.push(filters.streamId); }
  if (filters.correlationId) { clauses.push('correlation_id=?'); params.push(filters.correlationId); }
  if (filters.afterPosition !== undefined) { clauses.push('position>?'); params.push(filters.afterPosition); }
  params.push(Math.max(1, Math.min(filters.limit ?? 100, 500)));
  const rows = await db.prepare(`
    SELECT * FROM domain_events
    WHERE ${clauses.join(' AND ')}
    ORDER BY position ASC LIMIT ?
  `).all<Record<string, unknown>>(...params);
  return rows.map(serializeDomainEvent);
}

function serializeDomainEvent(row: Record<string, unknown>): DomainEvent {
  return {
    position: Number(row.position),
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    streamType: String(row.stream_type),
    streamId: String(row.stream_id),
    streamVersion: Number(row.stream_version),
    eventType: String(row.event_type),
    actorType: String(row.actor_type),
    actorId: row.actor_id ? String(row.actor_id) : null,
    causationId: row.causation_id ? String(row.causation_id) : null,
    correlationId: row.correlation_id ? String(row.correlation_id) : null,
    payload: parseObject(row.payload_json),
    metadata: parseObject(row.metadata_json),
    occurredAt: String(row.occurred_at)
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
