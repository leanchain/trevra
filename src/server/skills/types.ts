import type { z } from 'zod';
import type { Db } from '../db.js';

/**
 * The skill contract.
 *
 * A skill is a small, deterministic, independently testable unit of
 * go-to-market work. Trevra registers skills, runs them through `runner.ts`,
 * and records every run -- input, output, error, evidence -- in `skill_runs`.
 * An agent (Claude Code, Codex, or any MCP client) picks a skill by manifest and never has to
 * know how it is implemented.
 */

/**
 * What a skill does to the world outside this process.
 *
 * - `none` -- pure computation. Safe to run speculatively, any number of times.
 * - `network-read` -- reads a third party over the network (DNS, HTTP GET).
 *   Idempotent, but rate-limited and observable by the target.
 * - `external-write` -- changes state somewhere Trevra does not own (sends an
 *   email, writes to a CRM). Never speculative.
 */
export type SkillSideEffect = 'none' | 'network-read' | 'external-write';

export type SkillRunStatus = 'ok' | 'error';

/**
 * One piece of proof behind a skill's output.
 *
 * A skill whose output object carries an `evidence` array has that array
 * lifted into the ledger row by the runner, so the reasoning behind a run
 * survives independently of the output payload.
 */
export interface SkillEvidence {
  label: string;
  detail: string;
  sourceUrl?: string | null;
}

/**
 * Whether a skill's output may be written to the ledger.
 *
 * `'none'` means the payload is licensed by a third party on terms that do not
 * permit Trevra to store it. The runner honours this by keeping the ledger ROW
 * -- who ran what, when, and whether it worked -- and dropping the payload and
 * its evidence. The caller still receives the full output in memory.
 *
 * Declared on the OUTPUT rather than the manifest because it is a per-run
 * fact, not a per-skill one: `gtm.source-leads` may store the operator's own
 * seed list and must not store a licensed vendor's results, and which of those
 * happened is only known once a provider has been chosen.
 */
export type SkillRetention = 'default' | 'none';

export interface SkillManifest {
  /** Stable, namespaced identifier, e.g. `gtm.score-lead`. Also the `skills.id` primary key. */
  id: string;
  name: string;
  /** Bumped whenever the observable behaviour changes; recorded on every run so old rows stay interpretable. */
  version: string;
  description: string;
  sideEffect: SkillSideEffect;
  /** True when a human must approve the output before anything acts on it. */
  requiresApproval: boolean;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
}

export interface SkillContext {
  db: Db;
  workspaceId: string;
  /** Injected clock so runs are reproducible under test. */
  now(): Date;
  logger?: { warn(msg: string, meta?: unknown): void };
}

export interface Skill<I = unknown, O = unknown> {
  manifest: SkillManifest;
  run(input: I, ctx: SkillContext): Promise<O>;
}

/** One row of the skill ledger, as returned by `runSkill`. */
export interface SkillRun {
  id: string;
  skillId: string;
  skillVersion: string;
  workspaceId: string;
  status: SkillRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  evidence: SkillEvidence[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
