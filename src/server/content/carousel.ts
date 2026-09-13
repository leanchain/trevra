import sharp from 'sharp';
import type { Db } from '../db.js';
import { ensurePostImage, type LinkedInPost } from '../linkedin/posts.js';
import { createContentAsset, getContentAsset } from './assets.js';
import { getContentOpportunity } from './opportunities.js';
import { contentOpportunityRevision } from './revision.js';
import { prepareStoryLinkedInDraft } from './story-draft.js';
import type {
  ClaimMapEntry,
  ContentAsset,
  ContentEvidenceRef,
  ContentOpportunity
} from './types.js';

const CAROUSEL_RENDERER_VERSION = 'source-carousel-v1';
const WIDTH = 1080;
const HEIGHT = 1350;
const MAX_FACT_SLIDES = 5;

export class CarouselError extends Error {
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

function shell(inner: string, index: number, total: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#f7f7f4"/>
    <rect x="72" y="72" width="936" height="1206" rx="4" fill="#ffffff" stroke="#dadad5" stroke-width="2"/>
    ${inner}
    <line x1="106" y1="1188" x2="974" y2="1188" stroke="#e1e1dd" stroke-width="2"/>
    <text x="106" y="1238" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="18">SOURCE-BACKED · ${index}/${total}</text>
    <text x="974" y="1238" text-anchor="end" fill="#222222" font-family="Inter,Arial,sans-serif" font-size="21" font-weight="700">Trevra</text>
  </svg>`;
}

function coverSvg(opportunity: ContentOpportunity, total: number): string {
  const title = wrap(opportunity.title, 27, 4);
  const thesis = wrap(opportunity.thesis, 50, 4);
  return shell(
    `<text x="106" y="160" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="19" letter-spacing="2">MARKET SIGNAL BRIEF</text>
     <text x="106" y="300" fill="#111111" font-family="Inter,Arial,sans-serif" font-size="66" font-weight="700" letter-spacing="-1.5">${tspans(title, 106, 300, 72)}</text>
     <text x="106" y="${650 + Math.max(0, title.length - 2) * 50}" fill="#555555" font-family="Inter,Arial,sans-serif" font-size="29">${tspans(thesis, 106, 650 + Math.max(0, title.length - 2) * 50, 40)}</text>
     <text x="106" y="1080" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="21">${opportunity.evidence.length} current source-backed observation${opportunity.evidence.length === 1 ? '' : 's'}</text>`,
    1,
    total
  );
}

function factSvg(fact: ContentEvidenceRef, index: number, total: number): string {
  const detail = wrap(fact.detail, 37, 8);
  const label = wrap(fact.label, 48, 2);
  return shell(
    `<text x="106" y="160" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="19" letter-spacing="2">OBSERVATION ${index - 1}</text>
     <text x="106" y="245" fill="#555555" font-family="Inter,Arial,sans-serif" font-size="24" font-weight="600">${tspans(label, 106, 245, 34)}</text>
     <text x="106" y="390" fill="#111111" font-family="Inter,Arial,sans-serif" font-size="54" font-weight="700" letter-spacing="-1">${tspans(detail, 106, 390, 66)}</text>
     <text x="106" y="1080" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="19">Observed ${xml(new Date(fact.observedAt).toISOString().slice(0, 10))}</text>`,
    index,
    total
  );
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 72);
  }
}

function sourcesSvg(evidence: ContentEvidenceRef[], total: number): string {
  const rows = evidence
    .map((fact, index) => {
      const y = 285 + index * 150;
      const label = wrap(`${index + 1}. ${fact.label}`, 44, 2);
      return `<text x="106" y="${y}" fill="#111111" font-family="Inter,Arial,sans-serif" font-size="28" font-weight="650">${tspans(label, 106, y, 34)}</text>
        <text x="106" y="${y + 72}" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="19">${xml(sourceHost(fact.sourceUrl))} · ${xml(new Date(fact.observedAt).toISOString().slice(0, 10))}</text>`;
    })
    .join('');
  return shell(
    `<text x="106" y="160" fill="#777777" font-family="Inter,Arial,sans-serif" font-size="19" letter-spacing="2">SOURCES</text>
     <text x="106" y="225" fill="#111111" font-family="Inter,Arial,sans-serif" font-size="46" font-weight="700">Check the underlying evidence.</text>
     ${rows}`,
    total,
    total
  );
}

export async function renderStoryCarouselSlides(
  opportunity: ContentOpportunity
): Promise<Array<{ index: number; bytes: Buffer }>> {
  const evidence = opportunity.evidence.slice(0, MAX_FACT_SLIDES);
  if (evidence.length === 0) throw new CarouselError('This story has no source evidence.');
  const total = evidence.length + 2;
  const svgs = [
    coverSvg(opportunity, total),
    ...evidence.map((fact, offset) => factSvg(fact, offset + 2, total)),
    sourcesSvg(evidence, total)
  ];
  return Promise.all(
    svgs.map(async (svg, index) => ({
      index: index + 1,
      bytes: await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer()
    }))
  );
}

function carouselKey(opportunity: ContentOpportunity): string {
  return `carousel:${opportunity.id}:${CAROUSEL_RENDERER_VERSION}:rev:${contentOpportunityRevision(opportunity)}`;
}

async function ensureCarouselAsset(
  db: Db,
  opportunity: ContentOpportunity,
  actorUserId: string | null,
  now: Date
): Promise<{ asset: ContentAsset; reused: boolean }> {
  const key = carouselKey(opportunity);
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`${opportunity.workspaceId}\u001f${key}`);
    const existing = await tx
      .prepare(
        `SELECT id FROM content_assets
         WHERE workspace_id=? AND opportunity_id=? AND format='carousel'
           AND generation_json->>'idempotencyKey'=?
         ORDER BY created_at,id LIMIT 1`
      )
      .get<{ id: string }>(opportunity.workspaceId, opportunity.id, key);
    if (existing) {
      const asset = await getContentAsset(tx, opportunity.workspaceId, existing.id);
      if (asset) return { asset, reused: true };
    }
    const evidence = opportunity.evidence.slice(0, MAX_FACT_SLIDES);
    const claimMap: ClaimMapEntry[] = [
      { claim: opportunity.title, evidence: opportunity.evidence },
      { claim: opportunity.thesis, evidence: opportunity.evidence },
      ...evidence.map((item) => ({ claim: item.detail, evidence: [item] }))
    ];
    const asset = await createContentAsset(
      tx,
      {
        workspaceId: opportunity.workspaceId,
        opportunityId: opportunity.id,
        format: 'carousel',
        angle: 'observation',
        hook: opportunity.title,
        body: evidence.map((item) => item.detail).join('\n'),
        claimMap,
        generation: {
          idempotencyKey: key,
          storyRevision: contentOpportunityRevision(opportunity),
          renderer: CAROUSEL_RENDERER_VERSION,
          slideCount: evidence.length + 2,
          dimensions: { width: WIDTH, height: HEIGHT }
        },
        createdBy: actorUserId
      },
      now
    );
    return { asset, reused: false };
  });
}

export async function prepareStoryCarousel(
  db: Db,
  input: {
    workspaceId: string;
    opportunityId: string;
    seatKey?: string;
    actorUserId?: string | null;
    formatTemplateId?: string | null;
  },
  now: Date = new Date()
): Promise<{ asset: ContentAsset; post: LinkedInPost; reused: boolean }> {
  const opportunity = await getContentOpportunity(db, input.workspaceId, input.opportunityId);
  if (!opportunity) throw new CarouselError('Content opportunity not found.', 404);
  if (opportunity.status !== 'ready')
    throw new CarouselError('This story is not available for carousel generation.', 409);

  const draft = await prepareStoryLinkedInDraft(
    db,
    {
      workspaceId: input.workspaceId,
      opportunityId: input.opportunityId,
      seatKey: input.seatKey,
      actorUserId: input.actorUserId,
      formatTemplateId: input.formatTemplateId,
      variantKey: CAROUSEL_RENDERER_VERSION
    },
    now
  );
  const ensured = await ensureCarouselAsset(db, opportunity, input.actorUserId ?? null, now);
  await db
    .prepare(
      `UPDATE linkedin_posts SET publication_meta_json=publication_meta_json || ?::jsonb,updated_at=?
       WHERE workspace_id=? AND id=?`
    )
    .run(
      JSON.stringify({ carouselAssetId: ensured.asset.id, contentVariant: 'carousel' }),
      now.toISOString(),
      input.workspaceId,
      draft.post.id
    );

  const slides = await renderStoryCarouselSlides(opportunity);
  let post = draft.post;
  let allReused = ensured.reused;
  for (const slide of slides) {
    const attached = await ensurePostImage(
      db,
      input.workspaceId,
      draft.post.id,
      {
        name: `trevra-${ensured.asset.id}-carousel-${String(slide.index).padStart(2, '0')}.png`,
        mimeType: 'image/png',
        bytes: slide.bytes
      },
      now
    );
    post = attached.post;
    allReused = allReused && attached.reused;
  }
  return { asset: ensured.asset, post, reused: allReused };
}
