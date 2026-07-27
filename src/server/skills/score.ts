import { z } from 'zod';
import type { Skill } from './types.js';

/**
 * Deterministic, explainable lead scoring.
 *
 * Ported from the Python reference `src/growth/scoring.py`.
 *
 * Produces a per-wedge fit map, an overall score, the recommended wedge (the
 * highest-fit wedge), and a human-readable list of reasons behind each
 * contribution. Pure function, no I/O -- safe to call from routers, batch
 * jobs, or tests.
 *
 * Wedge tie-break priority (locked decision, carried over from the reference):
 * `visibility` > `sizing` > `tracker`. Visibility is the first wedge when fit
 * scores tie.
 *
 * GENERALIZATION (the one intentional deviation from the reference): the
 * Python version hard-coded beseam's three products and their bonus rules in
 * straight-line code. Here the identical shape is expressed as data --
 * `ScoreConfig.wedges` for the scoring rules and reason-emission order, and
 * `ScoreConfig.priority` for the tie-break order, which is deliberately a
 * SEPARATE list because the reference emits reasons in
 * sizing -> visibility -> tracker order while breaking ties in
 * visibility > sizing > tracker order. A workspace supplies its own wedges via
 * the skill's `config` input (fed from `skills.config_json`).
 * `DEFAULT_SCORE_CONFIG` reproduces the reference map exactly -- same bases,
 * same weights, same thresholds, same reason strings, same tie-break -- so the
 * ported behaviour is the default rather than a special case.
 */

const wedgeRuleSchema = z.object({
  /** Which lead signal unlocks this bonus. */
  signal: z.enum(['platform', 'vertical', 'catalog', 'contactEmail']),
  weight: z.number(),
  /** Tail of the emitted reason line; `{value}` is replaced by the matched signal value. */
  label: z.string(),
  /** Minimum catalog size for `catalog` rules. */
  minCatalog: z.number().int().positive().optional()
});

const wedgeSchema = z.object({
  id: z.string().min(1),
  base: z.number(),
  rules: z.array(wedgeRuleSchema)
});

export const scoreConfigSchema = z.object({
  /** Platform string that satisfies `platform` rules (compared lowercased). */
  platform: z.string().min(1),
  /** Verticals that satisfy `vertical` rules (compared lowercased). */
  verticals: z.array(z.string()),
  /** Wedges in reason-emission order. */
  wedges: z.array(wedgeSchema).min(1),
  /** Wedge ids in tie-break priority order, highest priority first. */
  priority: z.array(z.string()).min(1)
}).refine(
  (config) => config.priority.every((wedge) => config.wedges.some((candidate) => candidate.id === wedge)),
  { message: 'every priority entry must name a configured wedge' }
);

export type ScoreConfig = z.infer<typeof scoreConfigSchema>;
export type WedgeRule = z.infer<typeof wedgeRuleSchema>;

/** The reference (beseam) wedge map, reproduced exactly. */
export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  platform: 'shopify',
  // Verticals that unlock the sizing-specific bonus.
  verticals: ['footwear', 'dance'],
  wedges: [
    {
      id: 'sizing',
      base: 0.2,
      rules: [
        { signal: 'vertical', weight: 0.4, label: 'footwear/dance vertical ({value})' },
        { signal: 'platform', weight: 0.2, label: 'shopify platform' },
        { signal: 'catalog', weight: 0.1, label: 'catalog>=20 ({value})', minCatalog: 20 },
        { signal: 'contactEmail', weight: 0.1, label: 'has contact email' }
      ]
    },
    {
      id: 'visibility',
      base: 0.3,
      rules: [
        { signal: 'platform', weight: 0.3, label: 'shopify (feed-driven)' },
        { signal: 'catalog', weight: 0.2, label: 'catalog>=20 ({value})', minCatalog: 20 },
        { signal: 'contactEmail', weight: 0.1, label: 'has contact email' }
      ]
    },
    {
      id: 'tracker',
      base: 0.25,
      rules: [
        { signal: 'platform', weight: 0.25, label: 'shopify platform' },
        { signal: 'catalog', weight: 0.1, label: 'catalog>=50 ({value})', minCatalog: 50 },
        { signal: 'contactEmail', weight: 0.1, label: 'has contact email' }
      ]
    }
  ],
  // Locked tie-break order, highest priority first.
  priority: ['visibility', 'sizing', 'tracker']
};

export const leadFieldsSchema = z.object({
  platform: z.string().nullish(),
  vertical: z.string().nullish(),
  catalogSize: z.number().nullish(),
  contactEmail: z.string().nullish(),
  /** Additional harvested addresses; any one of them counts as "has contact email". */
  emails: z.array(z.string()).nullish()
});

export type LeadFields = z.infer<typeof leadFieldsSchema>;

export interface ScoreResult {
  fits: Record<string, number>;
  overall: number;
  wedge: string;
  reasons: string[];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Python's `round(value, 3)`; keeps float drift out of the emitted fits. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function hasContactEmail(lead: LeadFields): boolean {
  if (lead.contactEmail) return true;
  return (lead.emails ?? []).length > 0;
}

/** Argmax over `fits` with the locked tie-break priority applied. */
export function pickWedge(fits: Record<string, number>, priority: readonly string[] = DEFAULT_SCORE_CONFIG.priority): string {
  let best = priority[0];
  let bestFit = fits[best] ?? 0;
  for (const wedge of priority.slice(1)) {
    const fit = fits[wedge] ?? 0;
    // Strictly greater only: an equal fit leaves the earlier (higher priority) wedge in place.
    if (fit > bestFit) {
      best = wedge;
      bestFit = fit;
    }
  }
  return best;
}

function ruleMatches(rule: WedgeRule, lead: LeadFields, config: ScoreConfig): { matched: boolean; value: string } {
  const platform = (lead.platform ?? '').trim().toLowerCase();
  const vertical = (lead.vertical ?? '').trim().toLowerCase();
  const catalog = lead.catalogSize ?? 0;
  switch (rule.signal) {
    case 'platform':
      return { matched: platform === config.platform.toLowerCase(), value: platform };
    case 'vertical':
      // Single quotes reproduce the reference's Python `repr()` formatting.
      return { matched: config.verticals.includes(vertical), value: `'${vertical}'` };
    case 'catalog':
      return { matched: catalog >= (rule.minCatalog ?? 0), value: String(catalog) };
    case 'contactEmail':
      return { matched: hasContactEmail(lead), value: '' };
  }
}

/**
 * Return `{ fits, overall, wedge, reasons }`.
 *
 * Every contribution -- base and bonus alike -- emits a human-readable reason,
 * so the score is always defensible to the operator who acts on it.
 */
export function scoreLead(lead: LeadFields, config: ScoreConfig = DEFAULT_SCORE_CONFIG): ScoreResult {
  const reasons: string[] = [];
  const fits: Record<string, number> = {};

  for (const wedge of config.wedges) {
    let fit = wedge.base;
    reasons.push(`${wedge.id}: base ${wedge.base}`);
    for (const rule of wedge.rules) {
      const { matched, value } = ruleMatches(rule, lead, config);
      if (!matched) continue;
      fit += rule.weight;
      reasons.push(`${wedge.id}: +${rule.weight} ${rule.label.replace('{value}', value)}`);
    }
    fits[wedge.id] = round3(clamp(fit));
  }

  const wedge = pickWedge(fits, config.priority);
  const overall = fits[wedge];
  reasons.push(`wedge: ${wedge} (tie-break order ${config.priority.join(' > ')})`);

  return { fits, overall, wedge, reasons };
}

const inputSchema = z.object({
  lead: leadFieldsSchema,
  /** Optional per-workspace wedge map; defaults to the ported beseam map. */
  config: scoreConfigSchema.optional()
});

const outputSchema = z.object({
  fits: z.record(z.number()),
  overall: z.number().min(0).max(1),
  wedge: z.string(),
  reasons: z.array(z.string()).min(1)
});

type ScoreInput = z.infer<typeof inputSchema>;

export const scoreLeadSkill: Skill<ScoreInput, ScoreResult> = {
  manifest: {
    id: 'gtm.score-lead',
    name: 'Score lead fit',
    version: '1.0.0',
    description: 'Deterministic per-wedge fit scoring with a human-readable reason for every contribution.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return scoreLead(input.lead, input.config ?? DEFAULT_SCORE_CONFIG);
  }
};
