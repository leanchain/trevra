import { id } from '../db.js';
import { getSkill } from './registry.js';
import type { SkillContext, SkillEvidence, SkillRetention, SkillRun, SkillRunStatus } from './types.js';

/**
 * Skill runner.
 *
 * Validates input, executes the skill, validates output, and records the run in
 * `skill_runs` whether it succeeded or failed. The ledger row is the point: an
 * agent-operated system is only auditable if every attempt leaves a trace,
 * including the ones that blew up.
 *
 * Error taxonomy, deliberately split:
 * - INPUT validation failure and unknown skill id THROW. Those are caller
 *   errors -- the run never started, so there is nothing to record.
 * - Skill exceptions and OUTPUT validation failures are RECORDED as
 *   `status: 'error'` and returned. `runSkill` never throws for them, so a
 *   batch of skill invocations cannot be derailed by one bad skill.
 *
 * `skill_runs.skill_id` intentionally carries no foreign key to `skills`: the
 * ledger is append-only history and must survive a skill leaving the registry.
 */

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** Lift a skill's `evidence` array into the ledger row when it publishes one. */
function extractEvidence(output: unknown): SkillEvidence[] {
  if (typeof output !== 'object' || output === null) return [];
  const evidence = (output as { evidence?: unknown }).evidence;
  if (!Array.isArray(evidence)) return [];
  return evidence.filter((item): item is SkillEvidence => typeof item === 'object' && item !== null);
}

/**
 * Read the output's `retention` declaration -- the same well-known-key
 * convention `extractEvidence` uses.
 */
function retentionOf(output: unknown): SkillRetention {
  if (typeof output !== 'object' || output === null) return 'default';
  return (output as { retention?: unknown }).retention === 'none' ? 'none' : 'default';
}

/**
 * What actually gets written to `skill_runs.output_json`.
 *
 * A `retention: 'none'` output is replaced by a stub. The row still records
 * that the run happened, under which skill and workspace, with what status --
 * the audit trail the ledger exists for is intact. Only the third-party
 * payload is dropped, because storing it is what the provider's licence
 * forbids. Suppressing the whole ROW instead would make a licensed lookup
 * invisible to an audit, which is a worse answer than an empty one.
 */
export function redactForLedger(output: unknown): unknown {
  if (retentionOf(output) !== 'none') return output;
  return {
    retention: 'none',
    withheld: "Provider terms do not permit storing this output. The run is recorded; the payload was returned to the caller in memory only."
  };
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch (cause) {
    return JSON.stringify({ unserializable: messageOf(cause) });
  }
}

export async function runSkill(skillId: string, input: unknown, ctx: SkillContext): Promise<SkillRun> {
  const skill = getSkill(skillId);
  if (!skill) throw new Error(`Unknown skill: ${skillId}`);

  // Caller error: throws before any ledger row exists.
  const parsedInput = skill.manifest.inputSchema.parse(input);

  const startedAt = ctx.now();
  let status: SkillRunStatus = 'ok';
  let output: unknown = null;
  let error: string | null = null;

  try {
    const result = await skill.run(parsedInput, ctx);
    const validated = skill.manifest.outputSchema.safeParse(result);
    if (validated.success) {
      output = validated.data;
    } else {
      status = 'error';
      error = `Skill ${skillId} produced an invalid output: ${validated.error.message}`;
      // Keep the raw result: an output-schema mismatch is exactly when you need to see it.
      output = result;
    }
  } catch (cause) {
    status = 'error';
    error = messageOf(cause);
    ctx.logger?.warn(`Skill ${skillId} failed`, cause);
  }

  const finishedAt = ctx.now();
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  const retention = status === 'ok' ? retentionOf(output) : 'default';
  // Evidence is derived FROM the output, so a non-storable output cannot leave
  // its evidence behind either -- that would persist the payload one field over.
  const evidence = status === 'ok' && retention === 'default' ? extractEvidence(output) : [];
  const runId = id('run');

  await ctx.db.prepare(`
    INSERT INTO skill_runs (
      id, skill_id, skill_version, workspace_id, status,
      input_json, output_json, error, evidence_json,
      started_at, finished_at, duration_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    runId,
    skill.manifest.id,
    skill.manifest.version,
    ctx.workspaceId,
    status,
    toJson(parsedInput) ?? '{}',
    toJson(redactForLedger(output)),
    error,
    toJson(evidence) ?? '[]',
    startedAt.toISOString(),
    finishedAt.toISOString(),
    durationMs
  );

  // No-op when the skill has not been seeded into `skills` yet; the ledger row still stands.
  await ctx.db.prepare('UPDATE skills SET last_run_at=?, run_count=run_count+1, updated_at=? WHERE id=?')
    .run(finishedAt.toISOString(), finishedAt.toISOString(), skill.manifest.id);

  return {
    id: runId,
    skillId: skill.manifest.id,
    skillVersion: skill.manifest.version,
    workspaceId: ctx.workspaceId,
    status,
    input: parsedInput,
    output,
    error,
    evidence,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs
  };
}
