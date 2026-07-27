import { z } from 'zod';
import type { Skill } from './types.js';

/**
 * Lead lifecycle ladder and domain normalization.
 *
 * Ported from the pure parts of the Python reference `src/growth/service.py`
 * (`STATUS_LADDER`, `POST_SENT`, `GLOBAL_TARGETS`, `TERMINAL`,
 * `normalize_domain`, `allowed_transition`). No database access -- the ladder
 * is the rule, persistence is somebody else's job.
 *
 * Transition semantics, preserved exactly:
 * - forward exactly one step along the ladder, never backwards, never skipping;
 * - `dead` / `suppressed` are global targets, reachable from any status;
 * - `sent` may additionally move to `replied` / `bounced`, because those are
 *   caused by the outside world rather than by us.
 */

export const STATUS_LADDER: readonly string[] = ['new', 'enriched', 'scored', 'audited', 'drafted', 'approved', 'sent'];

/** Outcomes only reachable after an email has actually gone out. */
export const POST_SENT: ReadonlySet<string> = new Set(['replied', 'bounced']);

/** Always-allowed targets: an operator can kill or suppress a lead at any point. */
export const GLOBAL_TARGETS: ReadonlySet<string> = new Set(['dead', 'suppressed']);

export const TERMINAL: ReadonlySet<string> = new Set([...POST_SENT, ...GLOBAL_TARGETS]);

export const ALL_STATUSES: ReadonlySet<string> = new Set([...STATUS_LADDER, ...TERMINAL]);

/** Lowercase, strip scheme / path / query, drop leading `www.`. */
export function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return '';
  let value = raw.trim().toLowerCase();
  const scheme = value.indexOf('://');
  if (scheme >= 0) value = value.slice(scheme + 3);
  value = value.split('/', 1)[0].split('?', 1)[0];
  if (value.startsWith('www.')) value = value.slice(4);
  return value.trim().replace(/\.+$/, '');
}

export function allowedTransition(current: string, target: string): boolean {
  if (!ALL_STATUSES.has(target)) return false;
  if (GLOBAL_TARGETS.has(target)) return true;
  const index = STATUS_LADDER.indexOf(current);
  if (index >= 0) {
    if (STATUS_LADDER.indexOf(target) === index + 1) return true;
    if (current === 'sent' && POST_SENT.has(target)) return true;
  }
  return false;
}

const inputSchema = z.object({
  currentStatus: z.string().min(1),
  targetStatus: z.string().min(1),
  domain: z.string().optional()
});

const outputSchema = z.object({
  allowed: z.boolean(),
  currentStatus: z.string(),
  targetStatus: z.string(),
  terminal: z.boolean(),
  normalizedDomain: z.string().nullable(),
  reason: z.string()
});

type LadderInput = z.infer<typeof inputSchema>;
type LadderOutput = z.infer<typeof outputSchema>;

function explain(current: string, target: string, allowed: boolean): string {
  if (allowed && GLOBAL_TARGETS.has(target)) return `${target} is a global target and is reachable from any status`;
  if (allowed && current === 'sent' && POST_SENT.has(target)) return `${current} -> ${target} is an inbound outcome of a sent email`;
  if (allowed) return `${current} -> ${target} advances exactly one step on the ladder`;
  if (!ALL_STATUSES.has(target)) return `${target} is not a known lead status`;
  return `${current} -> ${target} is not a single forward step on the ladder`;
}

export const leadStatusSkill: Skill<LadderInput, LadderOutput> = {
  manifest: {
    id: 'gtm.lead-status',
    name: 'Lead status transition check',
    version: '1.0.0',
    description: 'Decide whether a lead status change is legal on the lifecycle ladder, and normalize the lead domain.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    const allowed = allowedTransition(input.currentStatus, input.targetStatus);
    return {
      allowed,
      currentStatus: input.currentStatus,
      targetStatus: input.targetStatus,
      terminal: TERMINAL.has(input.targetStatus),
      normalizedDomain: input.domain === undefined ? null : normalizeDomain(input.domain),
      reason: explain(input.currentStatus, input.targetStatus, allowed)
    };
  }
};
