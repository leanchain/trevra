import type { Db } from '../db.js';

const PROJECTION_NAME = 'commercial-entity-v1';

export async function runCommercialProjectionCycle(db: Db, batchSize = 1_000): Promise<number> {
  return db.transaction(async (tx) => {
    const checkpoint = await tx.prepare(`
      INSERT INTO projection_checkpoints (projection_name,last_position,updated_at)
      VALUES (?,0,?) ON CONFLICT (projection_name) DO UPDATE SET projection_name=excluded.projection_name
      RETURNING last_position
    `).get<{ last_position: number }>(PROJECTION_NAME,new Date().toISOString());
    const after = Number(checkpoint?.last_position ?? 0);
    const events = await tx.prepare(`
      SELECT * FROM commercial_entity_events WHERE position>? ORDER BY position ASC LIMIT ?
    `).all<Record<string, unknown>>(after,Math.max(1,Math.min(batchSize,10_000)));
    if (!events.length) return 0;
    for (const event of events) await applyProjectionEvent(tx,event);
    const last=Number(events.at(-1)?.position??after);
    await tx.prepare('UPDATE projection_checkpoints SET last_position=?,updated_at=? WHERE projection_name=?')
      .run(last,new Date().toISOString(),PROJECTION_NAME);
    return events.length;
  });
}

/**
 * Rebuild ONE tenant's projections, and only that tenant's.
 *
 * This used to take no workspace at all: it ran an unqualified
 * `DELETE FROM commercial_entity_projections`, reset the shared
 * `projection_checkpoints` row to 0, and replayed the whole event log. On a
 * hosted deployment that meant any member of any workspace could delete every
 * other customer's projections and force a full-log replay -- a cross-tenant
 * data wipe dressed up as a maintenance button.
 *
 * The workspace is now required and both halves are scoped to it:
 *
 * - The DELETE names the workspace, so nobody else's rows are touched.
 * - The replay reads only that workspace's events, in position order, straight
 *   into the projection table.
 *
 * The shared checkpoint is deliberately NOT reset. It belongs to the
 * incremental cycle, which is a single global tail over the event log; moving
 * it backwards for one tenant would make every other tenant's projections be
 * recomputed too, which is the same blast radius by a slower route. Replaying a
 * workspace's own history is enough to reconstruct its rows exactly, because
 * the upsert below is idempotent and guarded on `entity_version` -- an event
 * the global cycle later re-delivers cannot move a projection backwards.
 *
 * Batched so one enormous tenant cannot hold a single transaction open for the
 * length of its whole history; each batch commits on its own, and a crash
 * mid-rebuild leaves a partially rebuilt tenant that a re-run completes.
 */
export async function rebuildCommercialProjections(db: Db, workspaceId: string, batchSize = 5_000): Promise<number> {
  const workspace = workspaceId.trim();
  if (!workspace) throw new Error('rebuildCommercialProjections requires a workspace id');
  const limit = Math.max(1,Math.min(batchSize,10_000));
  await db.prepare('DELETE FROM commercial_entity_projections WHERE workspace_id=?').run(workspace);
  let total=0;
  let after=0;
  for(;;){
    const applied=await db.transaction(async (tx)=>{
      const events=await tx.prepare(`
        SELECT * FROM commercial_entity_events WHERE workspace_id=? AND position>? ORDER BY position ASC LIMIT ?
      `).all<Record<string, unknown>>(workspace,after,limit);
      if(!events.length)return 0;
      for(const event of events)await applyProjectionEvent(tx,event);
      after=Number(events.at(-1)?.position??after);
      return events.length;
    });
    total+=applied;
    if(applied<limit)return total;
  }
}

/**
 * One event -> one projection row, shared by the incremental cycle and the
 * per-tenant rebuild so the two can never drift into different state.
 *
 * The `entity_version` guard on the upsert is what makes replay safe: applying
 * an event twice, or applying an older one after a newer one, is a no-op.
 */
async function applyProjectionEvent(tx: Db, event: Record<string, unknown>): Promise<void> {
  const deletedAt = String(event.operation)==='delete'?String(event.occurred_at):null;
  await tx.prepare(`
    INSERT INTO commercial_entity_projections (
      workspace_id,entity_type,entity_id,entity_version,state_json,source_position,deleted_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id,entity_type,entity_id) DO UPDATE SET
      entity_version=excluded.entity_version,state_json=excluded.state_json,
      source_position=excluded.source_position,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at
    WHERE commercial_entity_projections.entity_version<excluded.entity_version
  `).run(
    String(event.workspace_id),String(event.entity_type),String(event.entity_id),Number(event.entity_version),
    JSON.stringify(parseObject(event.state_json)),Number(event.position),deletedAt,String(event.occurred_at)
  );
}

export async function listCommercialProjections(
  db: Db,
  workspaceId: string,
  filters: { entityType?: string; includeDeleted?: boolean; limit?: number }={}
){
  const clauses=['workspace_id=?'];const params:unknown[]=[workspaceId];
  if(filters.entityType){clauses.push('entity_type=?');params.push(filters.entityType);}
  if(!filters.includeDeleted)clauses.push('deleted_at IS NULL');
  params.push(Math.max(1,Math.min(filters.limit??200,1_000)));
  const rows=await db.prepare(`
    SELECT * FROM commercial_entity_projections WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC LIMIT ?
  `).all<Record<string,unknown>>(...params);
  return rows.map((row)=>({
    workspaceId:String(row.workspace_id),entityType:String(row.entity_type),entityId:String(row.entity_id),
    entityVersion:Number(row.entity_version),state:parseObject(row.state_json),sourcePosition:Number(row.source_position),
    deletedAt:row.deleted_at?String(row.deleted_at):null,updatedAt:String(row.updated_at)
  }));
}

function parseObject(value:unknown):Record<string,unknown>{
  if(typeof value==='object'&&value!==null&&!Array.isArray(value))return value as Record<string,unknown>;
  if(typeof value!=='string')return{};
  try{const parsed=JSON.parse(value);return typeof parsed==='object'&&parsed!==null&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};}catch{return{};}
}
