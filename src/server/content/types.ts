export type ContentOpportunityStatus = 'candidate' | 'ready' | 'dismissed' | 'expired';
export type ContentOpportunityKind =
  'company_change' | 'market_pattern' | 'watch_trend' | 'comparison' | 'index_move';

export type ContentFormat = 'text_post' | 'evidence_card' | 'market_pulse' | 'report';
export type ContentAngle =
  'observation' | 'contrarian' | 'list' | 'teardown' | 'prediction' | 'comparison';

export interface ContentEvidenceRef {
  sourceType: 'account_signal' | 'brand_watch_mention' | 'skill_run' | 'external_observation';
  sourceId: string;
  label: string;
  detail: string;
  sourceUrl: string;
  observedAt: string;
}

export interface ContentOpportunity {
  id: string;
  workspaceId: string;
  status: ContentOpportunityStatus;
  kind: ContentOpportunityKind;
  title: string;
  thesis: string;
  audience: string | null;
  freshnessAt: string;
  score: number;
  rationale: string[];
  evidence: ContentEvidenceRef[];
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimMapEntry {
  claim: string;
  evidence: ContentEvidenceRef[];
}

export interface ContentAsset {
  id: string;
  workspaceId: string;
  opportunityId: string | null;
  status: 'draft' | 'approved' | 'archived';
  format: ContentFormat;
  angle: ContentAngle;
  hook: string;
  body: string;
  claimMap: ClaimMapEntry[];
  generation: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
