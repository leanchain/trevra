import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { id } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { evaluatePolicy, policyAttributesFrom, type PolicyDecision } from '../control-plane/policy.js';
import { canonicalPayloadHash } from '../control-plane/payload.js';
import { executePreparedPlaybookAction } from '../control-plane/execution.js';
import { executeWorkspaceSkill, getWorkspaceSkillManifest } from '../skill-api.js';
import { notifyTemporalPlaybook, orchestrationMode } from '../orchestration/client.js';
import { getPlaybook, listWorkspacePlaybooks } from './registry.js';
import { resolveTemplate, type PlaybookTemplateContext } from './template.js';
import type {
  ActionPlaybookStep,
  ApprovalPlaybookStep,
  PlaybookDefinition,
  PlaybookRun,
  PlaybookRunStatus,
  PlaybookStep,
  PlaybookStepRun,
  SkillPlaybookStep
} from './types.js';

const TERMINAL_RUN_STATUSES = new Set<PlaybookRunStatus>(['completed', 'failed', 'cancelled']);
const LEASE_MS = 60_000;

export class PlaybookError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export async function startPlaybookRun(
  db: Db,
  input: {
    workspaceId: string;
    playbookId: string;
    version?: string;
    payload: unknown;
    actorType: 'agent' | 'user' | 'system';
    actorId: string | null;
  }
): Promise<PlaybookRun> {
  const playbook = getPlaybook(input.playbookId, input.version);
  if (!playbook) throw new PlaybookError(`Unknown playbook: ${input.playbookId}`, 404);
  await assertPlaybookEnabled(db, input.workspaceId, playbook);

  const parsedInput = playbook.inputSchema.parse(input.payload);
  const runId = id('pbr');
  const correlationId = id('corr');
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.prepare(`
      INSERT INTO playbook_runs (
        id,workspace_id,playbook_key,playbook_version,status,actor_type,actor_id,
        input_json,correlation_id,created_at,started_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      runId,input.workspaceId,playbook.id,playbook.version,'queued',input.actorType,input.actorId,
      JSON.stringify(parsedInput),correlationId,now,now,now
    );
    for (const step of playbook.steps) {
      await tx.prepare(`
        INSERT INTO playbook_step_runs (
          id,playbook_run_id,step_id,step_type,skill_id,status,attempt,available_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(id('pbs'),runId,step.id,step.type,step.type === 'skill' ? step.skillId : null,'pending',1,now,now);
    }
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'playbook_run',
      streamId: runId,
      eventType: 'playbook.run.started',
      actorType: input.actorType,
      actorId: input.actorId,
      correlationId,
      payload: { playbookId: playbook.id, playbookVersion: playbook.version, input: parsedInput }
    });
  });

  if (orchestrationMode() === 'temporal') {
    await notifyTemporalPlaybook({ workspaceId: input.workspaceId, runId });
    return (await getPlaybookRun(db, input.workspaceId, runId))!;
  }
  return advancePlaybookRun(db, input.workspaceId, runId);
}

export async function advancePlaybookRun(db: Db, workspaceId: string, runId: string): Promise<PlaybookRun> {
  await recoverStaleSteps(db, runId);

  for (let guard = 0; guard < 100; guard += 1) {
    const run = await getPlaybookRun(db, workspaceId, runId);
    if (!run) throw new PlaybookError('Playbook run not found', 404);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;

    const playbook = getPlaybook(run.playbookId, run.playbookVersion);
    if (!playbook) return failRun(db, run, `Playbook definition ${run.playbookId}@${run.playbookVersion} is unavailable`);
    const latest = new Map(run.steps.map((step) => [step.stepId, step]));

    const waiting = run.steps.find((step) => step.status === 'waiting_approval');
    if (waiting) {
      await setRunStatus(db, run, 'waiting_approval', waiting.stepId, null);
      return (await getPlaybookRun(db, workspaceId, runId))!;
    }

    const failed = run.steps.find((step) => step.status === 'failed');
    if (failed) return failRun(db, run, failed.error ?? `Step ${failed.stepId} failed`);

    const nextDefinition = playbook.steps.find((step) => {
      const state = latest.get(step.id);
      if (!state || state.status !== 'pending') return false;
      return (step.needs ?? []).every((dependency) => latest.get(dependency)?.status === 'completed');
    });

    if (!nextDefinition) {
      if (playbook.steps.every((step) => latest.get(step.id)?.status === 'completed')) {
        return completeRun(db, run, playbook, templateContext(run));
      }
      const pendingFuture = run.steps.some((step) => step.status === 'pending');
      if (pendingFuture) {
        await setRunStatus(db, run, 'queued', run.currentStepId, null);
        return (await getPlaybookRun(db, workspaceId, runId))!;
      }
      return failRun(db, run, 'Playbook is blocked because one or more dependencies cannot complete');
    }

    const stepRun = latest.get(nextDefinition.id)!;
    const claimed = await claimStep(db, stepRun.id);
    if (!claimed) continue;
    await setRunStatus(db, run, 'running', nextDefinition.id, null);
    await appendDomainEvent(db, {
      workspaceId,
      streamType: 'playbook_run',
      streamId: runId,
      eventType: 'playbook.step.started',
      actorType: run.actorType,
      actorId: run.actorId,
      correlationId: run.correlationId,
      payload: { stepId: nextDefinition.id, stepType: nextDefinition.type, attempt: stepRun.attempt }
    });

    const refreshed = await getPlaybookRun(db, workspaceId, runId);
    if (!refreshed) throw new PlaybookError('Playbook run disappeared', 500);
    const context = templateContext(refreshed);

    if (nextDefinition.type === 'approval') {
      await waitForApproval(db, refreshed, claimed, nextDefinition, context);
      return (await getPlaybookRun(db, workspaceId, runId))!;
    }

    if (nextDefinition.type === 'action') {
      const outcome = await runActionStep(db, refreshed, claimed, nextDefinition, context);
      if (outcome === 'scheduled') return (await getPlaybookRun(db, workspaceId, runId))!;
      continue;
    }

    const outcome = await runSkillStep(db, refreshed, claimed, nextDefinition, context);
    if (outcome === 'waiting' || outcome === 'scheduled') {
      return (await getPlaybookRun(db, workspaceId, runId))!;
    }
  }
  throw new PlaybookError('Playbook exceeded the maximum orchestration steps', 500);
}

export async function decidePlaybookApproval(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    stepId: string;
    userId: string;
    decision: 'approve' | 'reject';
    comment?: string;
  }
): Promise<PlaybookRun> {
  const run = await getPlaybookRun(db, input.workspaceId, input.runId);
  if (!run) throw new PlaybookError('Playbook run not found', 404);
  const step = run.steps.find((item) => item.stepId === input.stepId && item.status === 'waiting_approval');
  if (!step || !step.approvalPayloadHash) throw new PlaybookError('Approval step is not waiting for a decision', 409);
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    const locked = await tx.prepare(`
      SELECT id,status,approval_payload_hash FROM playbook_step_runs
      WHERE id=? FOR UPDATE
    `).get<{ id: string; status: string; approval_payload_hash: string | null }>(step.id);
    if (!locked || locked.status !== 'waiting_approval' || locked.approval_payload_hash !== step.approvalPayloadHash) {
      throw new PlaybookError('Approval state changed; reload before deciding', 409);
    }
    await tx.prepare(`
      INSERT INTO playbook_approvals (
        id,workspace_id,playbook_run_id,step_run_id,user_id,decision,payload_hash,comment,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      id('pba'),input.workspaceId,input.runId,step.id,input.userId,input.decision,
      step.approvalPayloadHash,input.comment?.trim() || null,now
    );

    if (input.decision === 'approve') {
      await tx.prepare(`
        UPDATE playbook_step_runs SET status='completed',output_json=?,finished_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=?
      `).run(JSON.stringify({ approved: true, approvedBy: input.userId, approvedAt: now, comment: input.comment ?? null }),now,now,step.id);
      await tx.prepare(`UPDATE playbook_runs SET status='running',current_step_id=NULL,updated_at=? WHERE id=?`).run(now,input.runId);
    } else {
      await tx.prepare(`
        UPDATE playbook_step_runs SET status='failed',error=?,finished_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=?
      `).run('Founder rejected the approval request',now,now,step.id);
      await tx.prepare(`UPDATE playbook_runs SET status='failed',error=?,finished_at=?,updated_at=? WHERE id=?`)
        .run('Founder rejected the approval request',now,now,input.runId);
    }

    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'playbook_run',
      streamId: input.runId,
      eventType: input.decision === 'approve' ? 'approval.granted' : 'approval.rejected',
      actorType: 'user',
      actorId: input.userId,
      correlationId: run.correlationId,
      payload: { stepId: input.stepId, payloadHash: step.approvalPayloadHash, comment: input.comment ?? null }
    });
  });

  if (input.decision === 'reject') return (await getPlaybookRun(db, input.workspaceId, input.runId))!;
  if (orchestrationMode() === 'temporal') {
    await notifyTemporalPlaybook({ workspaceId: input.workspaceId, runId: input.runId });
    return (await getPlaybookRun(db, input.workspaceId, input.runId))!;
  }
  return advancePlaybookRun(db, input.workspaceId, input.runId);
}

export async function listPlaybookRuns(
  db: Db,
  workspaceId: string,
  filters: { status?: PlaybookRunStatus; limit?: number } = {}
): Promise<PlaybookRun[]> {
  const clauses = ['workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.status) { clauses.push('status=?'); params.push(filters.status); }
  params.push(Math.max(1, Math.min(filters.limit ?? 50, 200)));
  const rows = await db.prepare(`
    SELECT id FROM playbook_runs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?
  `).all<{ id: string }>(...params);
  const runs = await Promise.all(rows.map((row) => getPlaybookRun(db, workspaceId, row.id)));
  return runs.filter((run): run is PlaybookRun => Boolean(run));
}

export async function getPlaybookRun(db: Db, workspaceId: string, runId: string): Promise<PlaybookRun | null> {
  const row = await db.prepare('SELECT * FROM playbook_runs WHERE id=? AND workspace_id=?')
    .get<Record<string, unknown>>(runId,workspaceId);
  if (!row) return null;
  const stepRows = await db.prepare(`
    SELECT DISTINCT ON (step_id) * FROM playbook_step_runs
    WHERE playbook_run_id=? ORDER BY step_id,attempt DESC
  `).all<Record<string, unknown>>(runId);
  const playbook = getPlaybook(String(row.playbook_key),String(row.playbook_version));
  const order = new Map((playbook?.steps ?? []).map((step,index) => [step.id,index]));
  const steps = stepRows.map(serializeStep).sort((a,b) => (order.get(a.stepId) ?? 999) - (order.get(b.stepId) ?? 999));
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    playbookId: String(row.playbook_key),
    playbookVersion: String(row.playbook_version),
    status: String(row.status) as PlaybookRunStatus,
    actorType: String(row.actor_type),
    actorId: row.actor_id ? String(row.actor_id) : null,
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    error: row.error ? String(row.error) : null,
    currentStepId: row.current_step_id ? String(row.current_step_id) : null,
    correlationId: String(row.correlation_id),
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    updatedAt: String(row.updated_at),
    steps
  };
}

export async function runReadyPlaybooks(db: Db): Promise<number> {
  if (orchestrationMode() === 'temporal') return 0;
  const rows = await db.prepare(`
    SELECT id,workspace_id FROM playbook_runs
    WHERE status IN ('queued','running') ORDER BY updated_at ASC LIMIT 100
  `).all<{ id: string; workspace_id: string }>();
  let processed = 0;
  for (const row of rows) {
    try { await advancePlaybookRun(db,row.workspace_id,row.id); processed += 1; }
    catch (error) { console.error('Playbook resume failed',row.id,error); }
  }
  return processed;
}

export { listWorkspacePlaybooks };

async function runActionStep(
  db: Db,
  run: PlaybookRun,
  stepRun: Record<string, unknown>,
  step: ActionPlaybookStep,
  context: PlaybookTemplateContext
): Promise<'completed' | 'scheduled'> {
  const payload = resolveTemplate(step.payload, context);
  const decision = await evaluatePolicy(db, {
    workspaceId: run.workspaceId,
    action: `action:${step.actionType}`,
    actorType: run.actorType,
    actorId: run.actorId,
    sideEffect: 'external-write',
    playbookId: run.playbookId,
    environment: process.env.NODE_ENV ?? 'development',
    // Without these, every amount/confidence/recipient condition a founder set
    // is unevaluable and the rule is resolved by its effect alone.
    attributes: policyAttributesFrom(payload)
  });
  const now = new Date().toISOString();
  await db.prepare(`UPDATE playbook_step_runs SET input_json=?,policy_decision_json=?,updated_at=? WHERE id=?`)
    .run(JSON.stringify(payload), JSON.stringify(decision), now, String(stepRun.id));

  if (decision.effect === 'deny') {
    await failStep(db, run, stepRun, decision.reason, decision);
    return 'completed';
  }

  const approvalStep = run.steps.find((candidate) => candidate.stepId === step.approvalStepId);
  const payloadHash = canonicalPayloadHash(payload);
  if (!approvalStep || approvalStep.status !== 'completed' || approvalStep.approvalPayloadHash !== payloadHash) {
    await failStep(
      db,
      run,
      stepRun,
      `Action ${step.actionType} does not match a completed exact-payload approval from step ${step.approvalStepId}`,
      decision
    );
    return 'completed';
  }
  const approval = await db.prepare(`
    SELECT id FROM playbook_approvals
    WHERE playbook_run_id=? AND step_run_id=? AND decision='approve' AND payload_hash=?
    ORDER BY created_at DESC LIMIT 1
  `).get<{ id: string }>(run.id, approvalStep.id, payloadHash);
  if (!approval) {
    await failStep(db, run, stepRun, 'No valid founder approval exists for the action payload', decision);
    return 'completed';
  }

  await appendDomainEvent(db, {
    workspaceId: run.workspaceId,
    streamType: 'playbook_run',
    streamId: run.id,
    eventType: 'action.execution_started',
    actorType: 'system',
    actorId: null,
    correlationId: run.correlationId,
    causationId: approval.id,
    payload: { stepId: step.id, actionType: step.actionType, payloadHash }
  });

  try {
    const delivery = await executePreparedPlaybookAction(db, {
      workspaceId: run.workspaceId,
      actionType: step.actionType,
      payload,
      payloadHash
    });
    const finishedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.prepare(`
        UPDATE playbook_step_runs SET status='completed',output_json=?,finished_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=?
      `).run(JSON.stringify(delivery), finishedAt, finishedAt, String(stepRun.id));
      await appendDomainEvent(tx, {
        workspaceId: run.workspaceId,
        streamType: 'playbook_run',
        streamId: run.id,
        eventType: 'action.executed',
        actorType: 'system',
        correlationId: run.correlationId,
        causationId: approval.id,
        payload: { stepId: step.id, payloadHash, ...delivery }
      });
    });
    return 'completed';
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const attempt = Number(stepRun.attempt);
    const maxAttempts = Math.max(1, step.retry?.maxAttempts ?? 3);
    if (attempt < maxAttempts) {
      const delaySeconds = Math.max(0, step.retry?.delaySeconds ?? 30);
      const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      const failedAt = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx.prepare(`
          UPDATE playbook_step_runs SET status='failed',error=?,finished_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?
        `).run(error, failedAt, failedAt, String(stepRun.id));
        await tx.prepare(`
          INSERT INTO playbook_step_runs (
            id,playbook_run_id,step_id,step_type,status,attempt,available_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?)
        `).run(id('pbs'), run.id, step.id, 'action', 'pending', attempt + 1, availableAt, failedAt);
        await tx.prepare(`UPDATE playbook_runs SET status='queued',current_step_id=?,error=NULL,updated_at=? WHERE id=?`)
          .run(step.id, failedAt, run.id);
        await appendDomainEvent(tx, {
          workspaceId: run.workspaceId,
          streamType: 'playbook_run',
          streamId: run.id,
          eventType: 'action.retry_scheduled',
          actorType: 'system',
          correlationId: run.correlationId,
          payload: { stepId: step.id, actionType: step.actionType, attempt: attempt + 1, availableAt, error }
        });
      });
      return 'scheduled';
    }
    await failStep(db, run, stepRun, error, decision);
    return 'completed';
  }
}

async function runSkillStep(
  db: Db,
  run: PlaybookRun,
  stepRun: Record<string, unknown>,
  step: SkillPlaybookStep,
  context: PlaybookTemplateContext
): Promise<'completed' | 'waiting' | 'scheduled'> {
  const skill = await getWorkspaceSkillManifest(db, run.workspaceId, step.skillId);
  if (!skill || !skill.enabled) {
    await failStep(db,run,stepRun,`Unknown or disabled skill: ${step.skillId}`,null);
    return 'completed';
  }
  const resolvedInput = resolveTemplate(step.input,context);
  if (skill.sideEffect === 'external-write') {
    const decision = await evaluatePolicy(db,{
      workspaceId: run.workspaceId,
      action: `skill:${step.skillId}`,
      actorType: run.actorType,
      actorId: run.actorId,
      sideEffect: skill.sideEffect,
      playbookId: run.playbookId,
      skillId: step.skillId,
      environment: process.env.NODE_ENV ?? 'development',
      attributes: policyAttributesFrom(resolvedInput)
    });
    await failStep(
      db,
      run,
      stepRun,
      `External-write skill ${step.skillId} requires a dedicated prepared-action execution step and cannot run through the generic playbook skill runner`,
      decision
    );
    return 'completed';
  }
  const decision = await evaluatePolicy(db,{
    workspaceId: run.workspaceId,
    action: `skill:${step.skillId}`,
    actorType: run.actorType,
    actorId: run.actorId,
    sideEffect: skill.sideEffect,
    playbookId: run.playbookId,
    skillId: step.skillId,
    environment: process.env.NODE_ENV ?? 'development',
    attributes: policyAttributesFrom(resolvedInput)
  });

  await db.prepare(`UPDATE playbook_step_runs SET input_json=?,policy_decision_json=?,skill_version=?,updated_at=? WHERE id=?`)
    .run(JSON.stringify(resolvedInput),JSON.stringify(decision),skill.version,new Date().toISOString(),String(stepRun.id));

  if (decision.effect === 'deny') {
    await failStep(db,run,stepRun,decision.reason,decision);
    return 'completed';
  }
  if (decision.effect === 'require_approval') {
    await placeStepBehindApproval(db,run,stepRun,step.id,resolvedInput,decision);
    return 'waiting';
  }

  // A $ref that resolves to `undefined` (most commonly: a prior step returned
  // zero items and this step indexes `.0` into that array -- an ordinary
  // "nothing qualified" outcome, not an anomaly) makes `resolvedInput` fail
  // the skill's input schema. `runSkill` deliberately THROWS for that --
  // it's a caller error, not a skill failure -- so it must be caught here.
  // Left uncaught, it propagates out of `advancePlaybookRun` as a raw Zod
  // error, the run is never marked failed, and it re-throws on every future
  // `runReadyPlaybooks` sweep forever.
  let result: Awaited<ReturnType<typeof executeWorkspaceSkill>>;
  try {
    result = await executeWorkspaceSkill(db,{
      workspaceId: run.workspaceId,
      skillId: step.skillId,
      payload: resolvedInput,
      actorType: run.actorType === 'agent' ? 'agent' : 'user',
      actorId: run.actorId
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Not retried: the same template resolves to the same missing field on
    // every attempt, so retrying would only repeat the failure.
    await failStep(db,run,stepRun,`Skill ${step.skillId} rejected its resolved input (check for a $ref into an empty prior-step result): ${message}`,decision);
    return 'completed';
  }
  const now = new Date().toISOString();
  if (result.run.status === 'ok') {
    await db.prepare(`
      UPDATE playbook_step_runs SET status='completed',skill_run_id=?,output_json=?,evidence_json=?,
        finished_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?
    `).run(result.run.id,JSON.stringify(result.run.output),JSON.stringify(result.run.evidence),now,now,String(stepRun.id));
    await appendDomainEvent(db,{
      workspaceId: run.workspaceId,streamType:'playbook_run',streamId:run.id,eventType:'playbook.step.completed',
      actorType:run.actorType,actorId:run.actorId,correlationId:run.correlationId,causationId:result.run.id,
      payload:{ stepId:step.id,skillId:step.skillId,skillRunId:result.run.id,evidence:result.run.evidence }
    });
    return 'completed';
  }

  const attempt = Number(stepRun.attempt);
  const maxAttempts = Math.max(1,step.retry?.maxAttempts ?? 1);
  if (attempt < maxAttempts) {
    const delaySeconds = Math.max(0,step.retry?.delaySeconds ?? 0);
    const availableAt = new Date(Date.now()+delaySeconds*1000).toISOString();
    await db.transaction(async (tx) => {
      await tx.prepare(`
        UPDATE playbook_step_runs SET status='failed',skill_run_id=?,output_json=?,error=?,finished_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?
      `).run(result.run.id,JSON.stringify(result.run.output),result.run.error,now,now,String(stepRun.id));
      await tx.prepare(`
        INSERT INTO playbook_step_runs (
          id,playbook_run_id,step_id,step_type,skill_id,skill_version,status,attempt,available_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(id('pbs'),run.id,step.id,'skill',step.skillId,skill.version,'pending',attempt+1,availableAt,now);
      await tx.prepare(`UPDATE playbook_runs SET status='queued',current_step_id=?,error=NULL,updated_at=? WHERE id=?`)
        .run(step.id,now,run.id);
      await appendDomainEvent(tx,{
        workspaceId:run.workspaceId,streamType:'playbook_run',streamId:run.id,eventType:'playbook.step.retry_scheduled',
        actorType:run.actorType,actorId:run.actorId,correlationId:run.correlationId,causationId:result.run.id,
        payload:{stepId:step.id,attempt:attempt+1,availableAt,error:result.run.error}
      });
    });
    if (delaySeconds === 0) return 'completed';
    return 'scheduled';
  }
  await failStep(db,run,stepRun,result.run.error ?? `Skill ${step.skillId} failed`,decision,result.run.id,result.run.output);
  return 'completed';
}

async function waitForApproval(
  db: Db,
  run: PlaybookRun,
  stepRun: Record<string, unknown>,
  step: ApprovalPlaybookStep,
  context: PlaybookTemplateContext
): Promise<void> {
  const payload = resolveTemplate(step.payload,context);
  const decision: PolicyDecision = {
    effect:'require_approval',policyId:null,policyName:'Playbook approval step',
    reason:step.title,evaluatedAt:new Date().toISOString()
  };
  await placeStepBehindApproval(db,run,stepRun,step.id,payload,decision);
}

async function placeStepBehindApproval(
  db: Db,
  run: PlaybookRun,
  stepRun: Record<string, unknown>,
  stepId: string,
  payload: unknown,
  decision: PolicyDecision
): Promise<void> {
  const now = new Date().toISOString();
  const payloadHash = canonicalPayloadHash(payload);
  await db.transaction(async (tx) => {
    await tx.prepare(`
      UPDATE playbook_step_runs SET status='waiting_approval',input_json=?,policy_decision_json=?,approval_payload_hash=?,
        updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?
    `).run(JSON.stringify(payload),JSON.stringify(decision),payloadHash,now,String(stepRun.id));
    await tx.prepare(`UPDATE playbook_runs SET status='waiting_approval',current_step_id=?,updated_at=? WHERE id=?`)
      .run(stepId,now,run.id);
    await appendDomainEvent(tx,{
      workspaceId:run.workspaceId,streamType:'playbook_run',streamId:run.id,eventType:'approval.requested',
      actorType:run.actorType,actorId:run.actorId,correlationId:run.correlationId,
      payload:{stepId,payloadHash,payload,policy:decision}
    });
  });
}

async function claimStep(db: Db, stepRunId: string): Promise<Record<string, unknown> | null> {
  const now = new Date();
  const leaseOwner = `worker_${randomUUID()}`;
  const claimed = await db.prepare(`
    UPDATE playbook_step_runs SET status='running',lease_owner=?,lease_expires_at=?,started_at=COALESCE(started_at,?),updated_at=?
    WHERE id=? AND status='pending' AND available_at<=?
    RETURNING *
  `).get<Record<string, unknown>>(
    leaseOwner,new Date(now.getTime()+LEASE_MS).toISOString(),now.toISOString(),now.toISOString(),stepRunId,now.toISOString()
  );
  return claimed ?? null;
}

async function recoverStaleSteps(db: Db, runId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE playbook_step_runs SET status='pending',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
    WHERE playbook_run_id=? AND status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
  `).run(now,runId,now);
}

async function failStep(
  db: Db,
  run: PlaybookRun,
  stepRun: Record<string, unknown>,
  error: string,
  decision: PolicyDecision | null,
  skillRunId?: string,
  output?: unknown
): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.prepare(`
      UPDATE playbook_step_runs SET status='failed',skill_run_id=?,output_json=?,error=?,policy_decision_json=COALESCE(?,policy_decision_json),
        finished_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?
    `).run(skillRunId ?? null,output === undefined ? null : JSON.stringify(output),error,decision ? JSON.stringify(decision) : null,now,now,String(stepRun.id));
    await tx.prepare(`UPDATE playbook_runs SET status='failed',error=?,current_step_id=?,finished_at=?,updated_at=? WHERE id=?`)
      .run(error,String(stepRun.step_id),now,now,run.id);
    await appendDomainEvent(tx,{
      workspaceId:run.workspaceId,streamType:'playbook_run',streamId:run.id,eventType:'playbook.step.failed',
      actorType:run.actorType,actorId:run.actorId,correlationId:run.correlationId,causationId:skillRunId ?? null,
      payload:{stepId:String(stepRun.step_id),error,policy:decision}
    });
  });
}

async function failRun(db: Db, run: PlaybookRun, error: string): Promise<PlaybookRun> {
  if (run.status !== 'failed') {
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.prepare(`UPDATE playbook_runs SET status='failed',error=?,finished_at=?,updated_at=? WHERE id=?`)
        .run(error,now,now,run.id);
      await appendDomainEvent(tx,{
        workspaceId:run.workspaceId,streamType:'playbook_run',streamId:run.id,eventType:'playbook.run.failed',
        actorType:run.actorType,actorId:run.actorId,correlationId:run.correlationId,payload:{error}
      });
    });
  }
  return (await getPlaybookRun(db,run.workspaceId,run.id))!;
}

async function completeRun(
  db: Db,
  run: PlaybookRun,
  playbook: PlaybookDefinition,
  context: PlaybookTemplateContext
): Promise<PlaybookRun> {
  const output = playbook.output ? resolveTemplate(playbook.output,context) : Object.fromEntries(
    Object.entries(context.steps).map(([key,value]) => [key,value.output])
  );
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.prepare(`UPDATE playbook_runs SET status='completed',output_json=?,error=NULL,current_step_id=NULL,finished_at=?,updated_at=? WHERE id=?`)
      .run(JSON.stringify(output),now,now,run.id);
    await appendDomainEvent(tx,{
      workspaceId:run.workspaceId,streamType:'playbook_run',streamId:run.id,eventType:'playbook.run.completed',
      actorType:run.actorType,actorId:run.actorId,correlationId:run.correlationId,payload:{output}
    });
  });
  return (await getPlaybookRun(db,run.workspaceId,run.id))!;
}

async function setRunStatus(
  db: Db,
  run: PlaybookRun,
  status: PlaybookRunStatus,
  currentStepId: string | null,
  error: string | null
): Promise<void> {
  if (run.status === status && run.currentStepId === currentStepId && run.error === error) return;
  await db.prepare(`UPDATE playbook_runs SET status=?,current_step_id=?,error=?,updated_at=? WHERE id=?`)
    .run(status,currentStepId,error,new Date().toISOString(),run.id);
}

function templateContext(run: PlaybookRun): PlaybookTemplateContext {
  return {
    input:run.input,
    steps:Object.fromEntries(run.steps.map((step) => [step.stepId,{
      input:step.input,output:step.output,evidence:step.evidence,status:step.status
    }]))
  };
}

function serializeStep(row: Record<string, unknown>): PlaybookStepRun {
  return {
    id:String(row.id),stepId:String(row.step_id),stepType:String(row.step_type) as PlaybookStepRun['stepType'],
    skillId:row.skill_id ? String(row.skill_id) : null,skillVersion:row.skill_version ? String(row.skill_version) : null,
    skillRunId:row.skill_run_id ? String(row.skill_run_id) : null,status:String(row.status) as PlaybookStepRun['status'],
    attempt:Number(row.attempt),input:parseJson(row.input_json),output:parseJson(row.output_json),
    evidence:Array.isArray(parseJson(row.evidence_json)) ? parseJson(row.evidence_json) as unknown[] : [],
    error:row.error ? String(row.error) : null,policyDecision:parseJson(row.policy_decision_json),
    approvalPayloadHash:row.approval_payload_hash ? String(row.approval_payload_hash) : null,
    startedAt:row.started_at ? String(row.started_at) : null,finishedAt:row.finished_at ? String(row.finished_at) : null,
    updatedAt:String(row.updated_at)
  };
}

async function assertPlaybookEnabled(db: Db, workspaceId: string, playbook: PlaybookDefinition): Promise<void> {
  const available = await listWorkspacePlaybooks(db,workspaceId);
  const entry = available.find((item) => item.id === playbook.id && item.version === playbook.version);
  if (!entry || !entry.enabled) throw new PlaybookError(`Playbook is disabled: ${playbook.id}@${playbook.version}`,403);
  if (entry.pinnedVersion && entry.pinnedVersion !== playbook.version) {
    throw new PlaybookError(`Workspace pins ${playbook.id} to ${entry.pinnedVersion}`,409);
  }
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
