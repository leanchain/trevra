import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Db } from './db.js';
import { id } from './db.js';
import { appendDomainEvent } from './control-plane/events.js';
import {
  getInstalledCommunityModule,
  listWorkspaceCommunityModules
} from './registry/service.js';
import { runCommunityModule } from './sandbox/community-runtime.js';
import { getSkill, listSkills } from './skills/registry.js';
import { runSkill } from './skills/runner.js';
import type { SkillRun, SkillSideEffect } from './skills/types.js';

export class SkillApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export interface PublicSkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  sideEffect: SkillSideEffect;
  requiresApproval: boolean;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  runtime: 'builtin' | 'oci' | 'wasi' | 'remote';
  sourceType: 'builtin' | 'community';
  publisher?: { id: string; slug: string; verified: boolean; keyFingerprint: string };
}

export async function listWorkspaceSkills(db: Db, workspaceId?: string): Promise<PublicSkillManifest[]> {
  if (workspaceId) await ensureWorkspaceSkills(db, workspaceId);
  const rows = workspaceId
    ? await db.prepare('SELECT skill_id AS id,enabled FROM workspace_skills WHERE workspace_id=?').all<{ id: string; enabled: boolean | number }>(workspaceId)
    : [];
  const enabled = new Map(rows.map((row) => [row.id, Boolean(row.enabled)]));
  const builtins: PublicSkillManifest[] = listSkills().map((skill) => ({
    id: skill.manifest.id,
    name: skill.manifest.name,
    version: skill.manifest.version,
    description: skill.manifest.description,
    sideEffect: skill.manifest.sideEffect,
    requiresApproval: skill.manifest.requiresApproval,
    enabled: enabled.get(skill.manifest.id) ?? true,
    inputSchema: zodToJsonSchema(skill.manifest.inputSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none'
    }) as Record<string, unknown>,
    outputSchema: zodToJsonSchema(skill.manifest.outputSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none'
    }) as Record<string, unknown>,
    runtime: 'builtin',
    sourceType: 'builtin'
  }));
  if (!workspaceId) return builtins;
  const community = await listWorkspaceCommunityModules(db, workspaceId);
  const seen = new Set(builtins.map((skill) => skill.id));
  return [
    ...builtins,
    ...community.filter((module) => !seen.has(module.id)).map((module) => ({
      id: module.id,
      name: module.name,
      version: module.version,
      description: module.description,
      sideEffect: module.sideEffect,
      requiresApproval: module.requiresApproval,
      enabled: true,
      inputSchema: module.inputSchema,
      outputSchema: module.outputSchema,
      runtime: module.runtime,
      sourceType: 'community' as const,
      publisher: module.publisher
    }))
  ].sort((left, right) => left.id.localeCompare(right.id));
}

export async function getWorkspaceSkillManifest(db: Db, workspaceId: string, skillId: string): Promise<PublicSkillManifest | null> {
  const skills = await listWorkspaceSkills(db, workspaceId);
  return skills.find((skill) => skill.id === skillId) ?? null;
}

export async function executeWorkspaceSkill(
  db: Db,
  input: {
    workspaceId: string;
    skillId: string;
    payload: unknown;
    actorType: 'agent' | 'user';
    actorId: string | null;
  }
): Promise<{ run: SkillRun; approvalRequired: boolean; sideEffect: SkillSideEffect }> {
  const builtin = getSkill(input.skillId);
  let sideEffect: SkillSideEffect;
  let requiresApproval: boolean;
  let run: SkillRun;

  if (builtin) {
    await ensureWorkspaceSkills(db, input.workspaceId);
    const configured = await db.prepare('SELECT enabled FROM workspace_skills WHERE workspace_id=? AND skill_id=?')
      .get<{ enabled: boolean | number }>(input.workspaceId, input.skillId);
    if (configured && !Boolean(configured.enabled)) {
      throw new SkillApiError(`Skill is disabled: ${input.skillId}`, 403);
    }
    sideEffect = builtin.manifest.sideEffect;
    requiresApproval = builtin.manifest.requiresApproval;
    if (sideEffect === 'external-write') throwExternalWrite(input.skillId);
    try {
      run = await runSkill(input.skillId, input.payload, {
        db,
        workspaceId: input.workspaceId,
        now: () => new Date(),
        logger: { warn: (message, meta) => console.warn(message, meta) }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SkillApiError(message, message.startsWith('Unknown skill:') ? 404 : 400);
    }
  } else {
    const module = await getInstalledCommunityModule(db, input.workspaceId, input.skillId);
    if (!module) throw new SkillApiError(`Unknown or uninstalled skill: ${input.skillId}`, 404);
    sideEffect = module.sideEffect;
    requiresApproval = module.requiresApproval;
    if (sideEffect === 'external-write') throwExternalWrite(input.skillId);
    try {
      run = await runCommunityModule(db, module, input.payload, {
        workspaceId: input.workspaceId,
        actorType: input.actorType,
        actorId: input.actorId
      });
    } catch (error) {
      throw new SkillApiError(error instanceof Error ? error.message : String(error), 400);
    }
  }

  await db.prepare(`
    INSERT INTO audit_events (
      id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    id('audit'),
    input.workspaceId,
    input.actorType,
    input.actorId,
    'skill.run',
    'skill_run',
    run.id,
    JSON.stringify({
      skillId: run.skillId,
      skillVersion: run.skillVersion,
      status: run.status,
      sideEffect,
      requiresApproval
    }),
    new Date().toISOString()
  );
  await appendDomainEvent(db, {
    workspaceId: input.workspaceId,
    streamType: 'skill_run',
    streamId: run.id,
    eventType: run.status === 'ok' ? 'skill.run.completed' : 'skill.run.failed',
    actorType: input.actorType,
    actorId: input.actorId,
    causationId: run.id,
    correlationId: run.id,
    payload: {
      skillId: run.skillId,
      skillVersion: run.skillVersion,
      status: run.status,
      sideEffect,
      requiresApproval,
      evidence: run.evidence,
      error: run.error
    }
  });

  return { run, approvalRequired: requiresApproval, sideEffect };
}

export async function listWorkspaceSkillRuns(
  db: Db,
  workspaceId: string,
  filters: { skillId?: string; status?: 'ok' | 'error'; limit?: number } = {}
): Promise<SkillRun[]> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const clauses = ['workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.skillId) {
    clauses.push('skill_id=?');
    params.push(filters.skillId);
  }
  if (filters.status) {
    clauses.push('status=?');
    params.push(filters.status);
  }
  params.push(limit);
  const rows = await db.prepare(`
    SELECT * FROM skill_runs
    WHERE ${clauses.join(' AND ')}
    ORDER BY started_at DESC
    LIMIT ?
  `).all<Record<string, unknown>>(...params);
  return rows.map(serializeRun);
}

export async function getWorkspaceSkillRun(db: Db, workspaceId: string, runId: string): Promise<SkillRun | null> {
  const row = await db.prepare('SELECT * FROM skill_runs WHERE id=? AND workspace_id=?')
    .get<Record<string, unknown>>(runId, workspaceId);
  return row ? serializeRun(row) : null;
}

function serializeRun(row: Record<string, unknown>): SkillRun {
  return {
    id: String(row.id),
    skillId: String(row.skill_id),
    skillVersion: String(row.skill_version),
    workspaceId: String(row.workspace_id),
    status: String(row.status) as SkillRun['status'],
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    error: row.error ? String(row.error) : null,
    evidence: parseJson(row.evidence_json) as SkillRun['evidence'],
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
    durationMs: Number(row.duration_ms ?? 0)
  };
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

async function ensureWorkspaceSkills(db: Db, workspaceId: string): Promise<void> {
  const now = new Date().toISOString();
  for (const skill of listSkills()) {
    await db.prepare(`
      INSERT INTO workspace_skills (workspace_id,skill_id,enabled,config_json,created_at,updated_at)
      VALUES (?,?,TRUE,'{}'::jsonb,?,?) ON CONFLICT (workspace_id,skill_id) DO NOTHING
    `).run(workspaceId,skill.manifest.id,now,now);
  }
}

function throwExternalWrite(skillId: string): never {
  throw new SkillApiError(
    `Skill ${skillId} changes an external system and must be executed through a prepared, approved Trevra action`,
    409
  );
}
