import type { Db } from '../db.js';
import type { Skill } from './types.js';
import { scoreLeadSkill } from './score.js';
import { leadStatusSkill } from './ladder.js';
import { validateHostSkill } from './guard.js';
import { visibilityAuditSkill } from './audit.js';
import { outreachDraftSkill } from './draft.js';
import { copyCritiqueSkill } from './voice.js';
import { channelPlanSkill } from '../channels/plan.js';
import { channelPrepareSkill } from '../channels/prepare.js';

/**
 * Skill registry.
 *
 * In-memory map keyed by manifest id, seeded at module load with every ported
 * skill, plus an idempotent seed into the `skills` table.
 *
 * Seeding philosophy carried over from the Python reference
 * `src/growth/sources/registry.py`: seeding only ever CREATES missing rows and
 * refreshes the code-owned columns (`name`, `version`). It never rewrites an
 * operator-set `enabled` flag or `config_json` -- an operator who disabled a
 * skill or tuned its config keeps that decision across every deploy, and a
 * skill added to the registry later is back-filled on the next seed.
 * `registerSkill` follows the same rule in memory: an id that is already
 * registered wins, so repeated imports are a no-op rather than a silent
 * overwrite.
 *
 * NOT YET PORTED, deliberately -- each needs an infrastructure decision Trevra
 * has not made:
 * - sending.py         -- SMTP delivery: needs a provider, DKIM/SPF, and a
 *                         suppression story before anything leaves the box.
 * - replies.py         -- IMAP reply polling: same mailbox decision.
 * - enrich.py          -- lead enrichment: depends on paid third-party APIs.
 * - ai_discovery.py    -- candidate mining: depends on backend monitoring
 *                         intelligence Trevra does not have.
 * - directory_crawl.py -- directory crawling: needs a crawl budget and its own
 *                         robots-compliance policy.
 * - temporal.py        -- Temporal client: Trevra has no Temporal deployment.
 */

/** Registry storage type: skills differ in their I/O shapes, so the schemas do the checking. */
export type RegisteredSkill = Skill<any, unknown>;

const skills = new Map<string, RegisteredSkill>();

/**
 * Register `skill` unless its id is already taken. Returns whatever is
 * registered under that id, so callers always get the live instance.
 */
export function registerSkill(skill: RegisteredSkill): RegisteredSkill {
  const existing = skills.get(skill.manifest.id);
  if (existing) return existing;
  skills.set(skill.manifest.id, skill);
  return skill;
}

export function getSkill(id: string): RegisteredSkill | undefined {
  return skills.get(id);
}

/** All registered skills, ordered by id so listings are stable. */
export function listSkills(): RegisteredSkill[] {
  return [...skills.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

for (const skill of [
  scoreLeadSkill,
  leadStatusSkill,
  validateHostSkill,
  visibilityAuditSkill,
  outreachDraftSkill,
  copyCritiqueSkill,
  channelPlanSkill,
  channelPrepareSkill
]) {
  registerSkill(skill);
}

/**
 * Idempotently back-fill the `skills` table from the registry.
 *
 * `enabled` and `config_json` are deliberately absent from the conflict update:
 * they are operator state, not code state.
 */
export async function seedSkills(db: Db, now: Date = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  for (const skill of listSkills()) {
    await db.prepare(`
      INSERT INTO skills (id, name, version, created_at, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        version=excluded.version,
        updated_at=excluded.updated_at
    `).run(skill.manifest.id, skill.manifest.name, skill.manifest.version, timestamp, timestamp);
  }
}
