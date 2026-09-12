import { createHash } from 'node:crypto';
import type { ContentOpportunity } from './types.js';

export function contentOpportunityRevision(opportunity: ContentOpportunity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        opportunity.title,
        opportunity.thesis,
        opportunity.evidence.map((item) => ({
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          label: item.label,
          detail: item.detail,
          sourceUrl: item.sourceUrl,
          observedAt: item.observedAt
        }))
      ])
    )
    .digest('hex')
    .slice(0, 16);
}
