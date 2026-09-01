import type { Db } from '../db.js';
import type { Skill } from './types.js';
import { scoreLeadSkill } from './score.js';
import { leadStatusSkill } from './ladder.js';
import { validateHostSkill } from './guard.js';
import { visibilityAuditSkill } from './audit.js';
import { enrichCompanySkill } from './enrich.js';
import { findContactSkill } from './contact.js';
import { watchSignalSkill } from './signal.js';
import { researchBriefSkill } from './brief.js';
import { outreachDraftSkill } from './draft.js';
import { copyCritiqueSkill } from './voice.js';
import { channelPlanSkill } from '../channels/plan.js';
import { channelPrepareSkill } from '../channels/prepare.js';
import { sourceLeadsSkill } from '../research/source.js';
import { scoutThreadsSkill } from '../outreach/scout.js';
import { watchMentionsSkill } from '../watch/skill.js';
import { scoreThreadsSkill } from '../outreach/scorer.js';
import { draftReplySkill } from '../outreach/reply.js';
import { outreachGuardSkill } from '../outreach/safety.js';
import { linkedinPacingSkill } from '../linkedin/pacing.js';
import { linkedinGuardSkill } from '../linkedin/guard.js';
import { linkedinSequenceSkill } from '../linkedin/sequence.js';

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
 * NOW PORTED -- the research half of the catalog, and the design note that
 * made it possible. The Python reference assumed enrichment meant buying a
 * database, which is why it sat unported behind "depends on paid third-party
 * APIs". It does not: a company's own site publishes its firmographics, its
 * platform, its contacts, and its changes over time, at no cost and with no
 * credential. That is what `gtm.enrich-company`, `gtm.find-contact`, and
 * `gtm.watch-signal` read, and being first-party public content is exactly why
 * they are the durable modules -- no vendor can revoke them.
 * - enrich.py          -- superseded by `gtm.enrich-company`: firmographics,
 *                         platform and tech fingerprint, catalog size, and page
 *                         presence, all from the prospect's own site.
 * - directory_crawl.py -- superseded by `gtm.find-contact`, which supplies the
 *                         crawl budget and robots policy the note asked for:
 *                         a bounded, same-origin, robots-respecting page set.
 * - ai_discovery.py    -- partially superseded by `gtm.watch-signal`, which
 *                         mines change (hiring, pricing, positioning, stack)
 *                         from public pages rather than from the backend
 *                         monitoring intelligence Trevra still does not have.
 *
 * STILL NOT PORTED, deliberately -- each needs an infrastructure decision
 * Trevra has not made:
 * - sending.py         -- SMTP delivery: needs a provider, DKIM/SPF, and a
 *                         suppression story before anything leaves the box.
 * - replies.py         -- IMAP reply polling: same mailbox decision.
 * - temporal.py        -- Temporal client: Trevra has no Temporal deployment.
 *
 * Sourcing (`gtm.source-leads`) ships credential-free through its `seed`
 * provider; vendor-backed discovery stays gated on terms rather than on
 * engineering. See `research/registry.ts` for the providers that were read and
 * deliberately NOT shipped, with the clause that decided it.
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
  enrichCompanySkill,
  findContactSkill,
  watchSignalSkill,
  researchBriefSkill,
  sourceLeadsSkill,
  outreachDraftSkill,
  copyCritiqueSkill,
  channelPlanSkill,
  channelPrepareSkill,
  scoutThreadsSkill,
  watchMentionsSkill,
  scoreThreadsSkill,
  outreachGuardSkill,
  draftReplySkill,
  linkedinPacingSkill,
  linkedinGuardSkill,
  linkedinSequenceSkill
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
    await db
      .prepare(
        `
      INSERT INTO skills (id, name, version, created_at, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        version=excluded.version,
        updated_at=excluded.updated_at
    `
      )
      .run(skill.manifest.id, skill.manifest.name, skill.manifest.version, timestamp, timestamp);
  }
}
