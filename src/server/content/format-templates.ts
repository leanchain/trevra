import { createHash } from 'node:crypto';
import { renderPostBody, type PostBlock } from '../../shared/linkedin-post-format.js';
import { id, type Db } from '../db.js';
import { listContentPublicationPerformance } from './performance.js';

export const FORMAT_TEMPLATE_MIN_SAMPLE = 3;

export type FormatHookType = 'question' | 'numbered' | 'statement';
export type FormatListStyle = 'bullet' | 'numbered' | 'none';
export type FormatRhythm = 'short' | 'balanced' | 'long';
export type FormatCtaType = 'question' | 'action' | 'none';
export type FormatVisualLayout =
  'portrait_card' | 'square_card' | 'wide_card' | 'carousel' | 'none';

export interface ContentFormatStructure {
  version: 1;
  hookType: FormatHookType;
  listStyle: FormatListStyle;
  rhythm: FormatRhythm;
  ctaType: FormatCtaType;
  paragraphCountBand: 'compact' | 'standard' | 'extended';
  evidenceSlots: number;
  visualLayout: FormatVisualLayout;
}

export interface ContentFormatTemplatePerformance {
  sampleSize: number;
  metricSampleSize: number;
  medianImpressions: number | null;
  qualifiedDemand: number;
  verifiedReplies: number;
  opportunities: number;
  won: number;
}

export interface ContentFormatTemplate {
  id: string;
  workspaceId: string;
  status: 'active' | 'archived';
  name: string;
  sourceKind: 'own_published_post' | 'manual_reference';
  sourceRef: string;
  structure: ContentFormatStructure;
  provenance: { sourcePostIds: string[]; extractedAt: string };
  performance: ContentFormatTemplatePerformance;
  fingerprint: string;
  recommended: boolean;
  createdAt: string;
  updatedAt: string;
}

function object(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function serialize(row: Record<string, unknown>): ContentFormatTemplate {
  const performance = (object(row.performance_json) as ContentFormatTemplatePerformance) ?? {
    sampleSize: 0,
    metricSampleSize: 0,
    medianImpressions: null,
    qualifiedDemand: 0,
    verifiedReplies: 0,
    opportunities: 0,
    won: 0
  };
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    status: String(row.status) as ContentFormatTemplate['status'],
    name: String(row.name),
    sourceKind: String(row.source_kind) as ContentFormatTemplate['sourceKind'],
    sourceRef: String(row.source_ref),
    structure: object(row.structure_json) as ContentFormatStructure,
    provenance: object(row.provenance_json) as ContentFormatTemplate['provenance'],
    performance,
    fingerprint: String(row.fingerprint),
    recommended: performance.sampleSize >= FORMAT_TEMPLATE_MIN_SAMPLE,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function sentenceLengths(body: string): number[] {
  return body
    .split(/[.!?]+(?:\s|$)/)
    .map((part) => part.trim().length)
    .filter((length) => length > 0);
}

/** Extracts reusable SHAPE only. No source wording is returned or persisted. */
export function extractContentFormatStructure(input: {
  body: string;
  evidenceCount: number;
  visualLayout?: FormatVisualLayout;
}): ContentFormatStructure {
  // text uses blank lines. Shape extraction must be invariant across both.
  const sections = input.body
    .split(/\n+/)
    .map((section) => section.trim())
    .filter(Boolean);
  const first = sections[0] ?? '';
  const last = sections.at(-1) ?? '';
  const numbered = sections.filter((section) => /^\d+[.)]\s+/.test(section)).length;
  const bullets = sections.filter((section) => /^[•*-]\s+/.test(section)).length;
  const lengths = sentenceLengths(input.body);
  const average = lengths.length === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const structure: ContentFormatStructure = {
    version: 1,
    hookType: first.endsWith('?')
      ? 'question'
      : /^\d+[.:)]\s/.test(first)
        ? 'numbered'
        : 'statement',
    listStyle: numbered > bullets && numbered > 0 ? 'numbered' : bullets > 0 ? 'bullet' : 'none',
    rhythm: average <= 55 ? 'short' : average >= 110 ? 'long' : 'balanced',
    ctaType: last.endsWith('?')
      ? 'question'
      : /\b(?:try|read|check|reply|message|book|download|follow|see)\b/i.test(last)
        ? 'action'
        : 'none',
    paragraphCountBand:
      sections.length <= 4 ? 'compact' : sections.length >= 8 ? 'extended' : 'standard',
    evidenceSlots: Math.max(1, Math.min(6, Math.trunc(input.evidenceCount || 1))),
    visualLayout: input.visualLayout ?? 'none'
  };
  return structure;
}

function fingerprint(structure: ContentFormatStructure): string {
  return `format:${createHash('sha256').update(JSON.stringify(structure)).digest('hex').slice(0, 24)}`;
}

function nameOf(structure: ContentFormatStructure): string {
  const list = structure.listStyle === 'none' ? 'narrative' : `${structure.listStyle} list`;
  const visual =
    structure.visualLayout === 'none' ? '' : ` + ${structure.visualLayout.replace('_', ' ')}`;
  return `${structure.hookType} · ${list} · ${structure.rhythm}${visual}`;
}

function comparePerformance(
  left: ContentFormatTemplatePerformance,
  right: ContentFormatTemplatePerformance
): number {
  const lN = Math.max(1, left.sampleSize);
  const rN = Math.max(1, right.sampleSize);
  const dimensions: Array<[number, number]> = [
    [left.won / lN, right.won / rN],
    [left.opportunities / lN, right.opportunities / rN],
    [left.verifiedReplies / lN, right.verifiedReplies / rN],
    [left.qualifiedDemand / lN, right.qualifiedDemand / rN]
  ];
  for (const [l, r] of dimensions) {
    if (l !== r) return r - l;
  }
  const lReach =
    left.metricSampleSize >= FORMAT_TEMPLATE_MIN_SAMPLE ? left.medianImpressions : null;
  const rReach =
    right.metricSampleSize >= FORMAT_TEMPLATE_MIN_SAMPLE ? right.medianImpressions : null;
  if (lReach !== null || rReach !== null) {
    if (lReach === null) return 1;
    if (rReach === null) return -1;
    if (lReach !== rReach) return rReach - lReach;
  }
  return right.sampleSize - left.sampleSize;
}

/** Rebuild own-post format recipes from the workspace's published history. */
export async function syncOwnPublishedFormatTemplates(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<ContentFormatTemplate[]> {
  const performance = await listContentPublicationPerformance(db, workspaceId, 500);
  const performanceByPost = new Map(performance.map((row) => [row.postId, row]));
  const rows = await db
    .prepare(
      `SELECT p.id AS post_id,p.blocks_json,p.media_json,a.claim_map_json,a.generation_json,a.opportunity_id
       FROM linkedin_posts p
       JOIN content_assets a ON a.workspace_id=p.workspace_id AND a.id=p.content_asset_id
       WHERE p.workspace_id=? AND p.status='posted' AND p.published_at IS NOT NULL
         AND p.content_asset_id IS NOT NULL
       ORDER BY p.published_at DESC,p.id DESC LIMIT 500`
    )
    .all<Record<string, unknown>>(workspaceId);

  type Group = {
    structure: ContentFormatStructure;
    postIds: string[];
    impressions: number[];
    qualifiedDemand: number;
    verifiedReplies: number;
    opportunities: number;
    won: number;
  };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const blocks = object(row.blocks_json) as PostBlock[];
    const claimMap = object(row.claim_map_json) as Array<{ evidence?: unknown[] }> | null;
    const body = renderPostBody(Array.isArray(blocks) ? blocks : []);
    const evidenceCount = Math.max(
      1,
      (claimMap ?? []).filter(
        (claim) => Array.isArray(claim.evidence) && claim.evidence.length === 1
      ).length
    );
    const media = object(row.media_json) as Array<{ name?: unknown }> | null;
    const names = (media ?? []).map((item) => String(item.name ?? ''));
    const visualLayout: FormatVisualLayout = names.some((name) => /-carousel-\d+\.png$/i.test(name))
      ? 'carousel'
      : names.some((name) => /-portrait\.png$/i.test(name))
        ? 'portrait_card'
        : names.some((name) => /-square\.png$/i.test(name))
          ? 'square_card'
          : names.some((name) => /-wide\.png$/i.test(name))
            ? 'wide_card'
            : 'none';
    const structure = extractContentFormatStructure({ body, evidenceCount, visualLayout });
    const fp = fingerprint(structure);
    const group = groups.get(fp) ?? {
      structure,
      postIds: [],
      impressions: [],
      qualifiedDemand: 0,
      verifiedReplies: 0,
      opportunities: 0,
      won: 0
    };
    const postId = String(row.post_id);
    group.postIds.push(postId);
    const observed = performanceByPost.get(postId);
    if (
      observed?.latestMetrics?.impressions !== null &&
      observed?.latestMetrics?.impressions !== undefined
    )
      group.impressions.push(observed.latestMetrics.impressions);
    if (observed) {
      group.qualifiedDemand += observed.commercial.qualifiedDemand;
      group.verifiedReplies += observed.commercial.verifiedReplies;
      group.opportunities += observed.commercial.opportunities;
      group.won += observed.commercial.won;
    }
    groups.set(fp, group);
  }

  const timestamp = now.toISOString();
  for (const [fp, group] of groups) {
    const perf: ContentFormatTemplatePerformance = {
      sampleSize: group.postIds.length,
      metricSampleSize: group.impressions.length,
      medianImpressions: median(group.impressions),
      qualifiedDemand: group.qualifiedDemand,
      verifiedReplies: group.verifiedReplies,
      opportunities: group.opportunities,
      won: group.won
    };
    await db
      .prepare(
        `INSERT INTO content_format_templates
         (id,workspace_id,status,name,source_kind,source_ref,structure_json,provenance_json,performance_json,fingerprint,created_at,updated_at)
         VALUES (?,?,'active',?,'own_published_post',?,?::jsonb,?::jsonb,?::jsonb,?,?,?)
         ON CONFLICT (workspace_id,fingerprint) DO UPDATE SET
           status='active',name=EXCLUDED.name,source_ref=EXCLUDED.source_ref,
           structure_json=EXCLUDED.structure_json,provenance_json=EXCLUDED.provenance_json,
           performance_json=EXCLUDED.performance_json,updated_at=EXCLUDED.updated_at`
      )
      .run(
        id('cft'),
        workspaceId,
        nameOf(group.structure),
        group.postIds[0]!,
        JSON.stringify(group.structure),
        JSON.stringify({ sourcePostIds: group.postIds, extractedAt: timestamp }),
        JSON.stringify(perf),
        fp,
        timestamp,
        timestamp
      );
  }
  return listContentFormatTemplates(db, workspaceId);
}

export async function listContentFormatTemplates(
  db: Db,
  workspaceId: string
): Promise<ContentFormatTemplate[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM content_format_templates WHERE workspace_id=? AND status='active'
       ORDER BY updated_at DESC,id DESC`
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(serialize).sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    const byPerformance = comparePerformance(left.performance, right.performance);
    return byPerformance || left.name.localeCompare(right.name);
  });
}

export async function getContentFormatTemplate(
  db: Db,
  workspaceId: string,
  templateId: string
): Promise<ContentFormatTemplate | null> {
  const row = await db
    .prepare(
      `SELECT * FROM content_format_templates WHERE workspace_id=? AND id=? AND status='active'`
    )
    .get<Record<string, unknown>>(workspaceId, templateId);
  return row ? serialize(row) : null;
}
