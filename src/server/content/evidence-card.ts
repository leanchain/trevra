import sharp from 'sharp';
import type { Db } from '../db.js';
import { ensurePostImage } from '../linkedin/posts.js';
import { createContentAsset, getContentAsset } from './assets.js';
import { getContentOpportunity } from './opportunities.js';
import { prepareStoryLinkedInDraft } from './story-draft.js';
import type { ClaimMapEntry, ContentAsset, ContentOpportunity } from './types.js';

export type EvidenceCardAspect = 'square' | 'portrait' | 'wide';

const CARD_RENDERER_VERSION = 'evidence-card-v1';
const DIMENSIONS: Record<EvidenceCardAspect, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  wide: { width: 1200, height: 675 }
};

export class EvidenceCardError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function wrap(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const usedWords = lines.join(' ').split(' ').length;
  if (usedWords < words.length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1]!.replace(/[.…]+$/, '')}…`;
  }
  return lines;
}

function tspans(lines: string[], x: number, y: number, lineHeight: number): string {
  return lines
    .map((line, index) => `<tspan x="${x}" y="${y + index * lineHeight}">${xml(line)}</tspan>`)
    .join('');
}

function cardSvg(opportunity: ContentOpportunity, aspect: EvidenceCardAspect): string {
  const { width, height } = DIMENSIONS[aspect];
  const compact = aspect === 'wide';
  const margin = compact ? 64 : 76;
  const titleSize = compact ? 46 : 58;
  const factSize = compact ? 25 : 30;
  const titleLines = wrap(opportunity.title, compact ? 39 : 31, compact ? 2 : 3);
  const facts = opportunity.evidence.slice(0, 3);
  const latest = [...opportunity.evidence]
    .map((item) => item.observedAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const titleY = compact ? 142 : 180;
  const factsStart = titleY + titleLines.length * (titleSize * 1.08) + (compact ? 38 : 62);
  const factGap = compact ? 92 : 138;
  const factBlocks = facts
    .map((fact, index) => {
      const y = factsStart + index * factGap;
      const lines = wrap(fact.detail, compact ? 65 : 48, compact ? 2 : 3);
      return `<g><circle cx="${margin + 7}" cy="${y - 9}" r="6" fill="#111111"/><text x="${margin + 28}" y="${y}" fill="#202020" font-size="${factSize}" font-weight="560">${tspans(lines, margin + 28, y, factSize * 1.28)}</text><text x="${margin + 28}" y="${y + lines.length * factSize * 1.28 + 15}" fill="#777777" font-size="17">${xml(fact.label)} · ${xml(new Date(fact.observedAt).toISOString().slice(0, 10))}</text></g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#f7f7f4"/>
    <rect x="${margin}" y="${margin}" width="${width - margin * 2}" height="${height - margin * 2}" rx="4" fill="#ffffff" stroke="#dadad5" stroke-width="2"/>
    <text x="${margin + 34}" y="${margin + 48}" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="19" letter-spacing="2">SOURCE-BACKED MARKET OBSERVATION</text>
    <text x="${margin + 34}" y="${titleY}" fill="#111111" font-family="Inter,Arial,sans-serif" font-size="${titleSize}" font-weight="700" letter-spacing="-1.5">${tspans(titleLines, margin + 34, titleY, titleSize * 1.08)}</text>
    <g font-family="Inter,Arial,sans-serif">${factBlocks}</g>
    <line x1="${margin + 34}" y1="${height - margin - 88}" x2="${width - margin - 34}" y2="${height - margin - 88}" stroke="#e1e1dd" stroke-width="2"/>
    <text x="${margin + 34}" y="${height - margin - 42}" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="17">${facts.length} source-backed observation${facts.length === 1 ? '' : 's'} · snapshot ${xml(latest ? new Date(latest).toISOString().slice(0, 10) : '')}</text>
    <text x="${width - margin - 34}" y="${height - margin - 42}" text-anchor="end" fill="#222222" font-family="Inter,Arial,sans-serif" font-size="20" font-weight="700">Trevra</text>
  </svg>`;
}

export async function renderEvidenceCardPng(
  opportunity: ContentOpportunity,
  aspect: EvidenceCardAspect = 'portrait'
): Promise<Buffer> {
  if (opportunity.evidence.length === 0)
    throw new EvidenceCardError('This story has no source evidence.');
  return sharp(Buffer.from(cardSvg(opportunity, aspect)))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function cardKey(opportunityId: string, aspect: EvidenceCardAspect): string {
  return `evidence-card:${opportunityId}:${aspect}:${CARD_RENDERER_VERSION}`;
}

async function ensureCardAsset(
  db: Db,
  opportunity: ContentOpportunity,
  aspect: EvidenceCardAspect,
  actorUserId: string | null,
  now: Date
): Promise<ContentAsset> {
  const key = cardKey(opportunity.id, aspect);
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`${opportunity.workspaceId}\u001f${key}`);
    const existing = await tx
      .prepare(
        `SELECT id FROM content_assets WHERE workspace_id=? AND opportunity_id=? AND format='evidence_card' AND generation_json->>'idempotencyKey'=? ORDER BY created_at,id LIMIT 1`
      )
      .get<{ id: string }>(opportunity.workspaceId, opportunity.id, key);
    if (existing) {
      const asset = await getContentAsset(tx, opportunity.workspaceId, existing.id);
      if (asset) return asset;
    }
    const evidence = opportunity.evidence.slice(0, 3);
    const claimMap: ClaimMapEntry[] = [
      { claim: opportunity.title, evidence: opportunity.evidence },
      ...evidence.map((item) => ({ claim: item.detail, evidence: [item] }))
    ];
    return createContentAsset(
      tx,
      {
        workspaceId: opportunity.workspaceId,
        opportunityId: opportunity.id,
        format: 'evidence_card',
        angle: 'observation',
        hook: opportunity.title,
        body: evidence.map((item) => item.detail).join('\n'),
        claimMap,
        generation: {
          idempotencyKey: key,
          renderer: CARD_RENDERER_VERSION,
          aspect,
          dimensions: DIMENSIONS[aspect]
        },
        createdBy: actorUserId
      },
      now
    );
  });
}

export async function prepareStoryEvidenceCard(
  db: Db,
  input: {
    workspaceId: string;
    opportunityId: string;
    seatKey?: string;
    aspect?: EvidenceCardAspect;
    actorUserId?: string | null;
  },
  now: Date = new Date()
): Promise<{
  asset: ContentAsset;
  post: Awaited<ReturnType<typeof prepareStoryLinkedInDraft>>['post'];
  reused: boolean;
}> {
  const opportunity = await getContentOpportunity(db, input.workspaceId, input.opportunityId);
  if (!opportunity) throw new EvidenceCardError('Content opportunity not found.', 404);
  if (opportunity.status !== 'ready')
    throw new EvidenceCardError('This story is not available for card generation.', 409);
  const aspect = input.aspect ?? 'portrait';
  const draft = await prepareStoryLinkedInDraft(
    db,
    {
      workspaceId: input.workspaceId,
      opportunityId: opportunity.id,
      seatKey: input.seatKey,
      actorUserId: input.actorUserId
    },
    now
  );
  const asset = await ensureCardAsset(db, opportunity, aspect, input.actorUserId ?? null, now);
  const name = `trevra-${asset.id}-${aspect}.png`;
  const bytes = await renderEvidenceCardPng(opportunity, aspect);
  const attached = await ensurePostImage(
    db,
    input.workspaceId,
    draft.post.id,
    { name, mimeType: 'image/png', bytes },
    now
  );
  return { asset, post: attached.post, reused: attached.reused };
}
