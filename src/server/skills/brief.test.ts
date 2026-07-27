import { describe, expect, it } from 'vitest';
import { buildResearchBrief } from './brief.js';
import { draftLeadSchema, templateDraft } from './draft.js';
import { critique } from './voice.js';

const AUDIT = {
  domain: 'shop.test',
  score: 48,
  topFinding: 'Product pages ship no structured data.',
  checks: [
    {
      id: 'structured_data_product',
      label: 'Product structured data',
      status: 'fail',
      detail: 'No Product JSON-LD on the sampled product page.',
      evidence: null,
      weight: 30,
      impact: 'Product pages ship no structured data, so AI shopping assistants cannot read prices or availability.'
    },
    {
      id: 'meta_quality',
      label: 'Page title & meta description',
      status: 'warn',
      detail: 'Only one of <title> / meta description is present.',
      evidence: null,
      weight: 10,
      impact: 'A missing page title or meta description weakens AI and search result snippets.'
    }
  ],
  evidence: [{ label: 'Product structured data', detail: 'No Product JSON-LD found.', sourceUrl: 'https://shop.test' }]
};

const ENRICH = {
  domain: 'shop.test',
  name: 'Nonormal',
  platform: 'shopify',
  catalogSize: 187,
  catalogCapped: false,
  tech: [
    { key: 'shopify', label: 'Shopify', platform: true, marker: 'cdn.shopify.com in homepage HTML' },
    { key: 'hubspot', label: 'HubSpot', platform: false, marker: 'js.hs-scripts.com in homepage HTML' }
  ],
  pages: [{ kind: 'careers', url: 'https://shop.test/careers', present: true }],
  emails: ['hello@shop.test'],
  evidence: [{ label: 'Catalog size', detail: '/products.json lists 187 product(s).', sourceUrl: 'https://shop.test/products.json' }]
};

const CONTACT = {
  domain: 'shop.test',
  contacts: [{ kind: 'email', value: 'hello@shop.test', source: 'https://shop.test/contact', confidence: 'published' }],
  evidence: [{ label: 'Published email', detail: 'hello@shop.test is published on https://shop.test/contact.', sourceUrl: 'https://shop.test/contact' }]
};

const WATCH = {
  domain: 'shop.test',
  signals: [
    {
      kind: 'hiring-up',
      detail: 'Open roles on https://shop.test/careers went from 3 to 7 (new: Head of RevOps).',
      previous: '3',
      current: '7'
    }
  ],
  evidence: [{ label: 'hiring-up', detail: 'Open roles went from 3 to 7.', sourceUrl: 'https://shop.test/careers' }]
};

describe('gtm.research-brief', () => {
  it('marks a brief built from nothing as insufficient, and that brief fails the slop critic', () => {
    const brief = buildResearchBrief({});

    expect(brief.sufficient).toBe(false);
    expect(brief.specifics).toEqual([]);
    expect(brief.recommendedAngle).toBe('none');
    expect(brief.domain).toBeNull();

    // Both halves of the promise: the flag says do not send, AND the sentence
    // itself cannot pass the substitution test, so a caller ignoring the flag
    // still gets stopped one gate later.
    const verdict = critique(brief.findingDetail, []);
    expect(verdict.passed).toBe(false);
    expect(verdict.findings.some((finding) => finding.check === 'generic-sentence')).toBe(true);
  });

  it('builds a checkable findingDetail from audit and enrichment that passes the substitution test', () => {
    const brief = buildResearchBrief({ audit: AUDIT, enrich: ENRICH });

    expect(brief.sufficient).toBe(true);
    expect(brief.findingDetail).toBe('shop.test scores 48/100 for AI visibility: Product structured data is a fail.');
    expect(brief.specifics).toEqual(['48', 'Product structured data']);
    expect(brief.recommendedAngle).toBe('ai-visibility');

    const verdict = critique(brief.findingDetail, [brief.domain, 'Nonormal']);
    expect(verdict.findings.filter((finding) => finding.check === 'generic-sentence')).toEqual([]);
    expect(verdict.passed).toBe(true);
  });

  it('prefers a timely change over a standing diagnosis', () => {
    const brief = buildResearchBrief({ audit: AUDIT, enrich: ENRICH, watch: WATCH });

    expect(brief.recommendedAngle).toBe('growth');
    expect(brief.topFinding).toBe('Hiring is up');
    expect(brief.findingDetail).toContain('went from 3 to 7');
    expect(brief.specifics).toEqual(['3', '7']);
    expect(critique(brief.findingDetail, [brief.domain]).passed).toBe(true);
  });

  it('falls back to firmographics when no audit or signal is available', () => {
    const brief = buildResearchBrief({ enrich: ENRICH });

    expect(brief.sufficient).toBe(true);
    expect(brief.recommendedAngle).toBe('platform');
    expect(brief.topFinding).toBe('Shopify catalog of 187 products');
    expect(brief.findingDetail).toContain('187 products in its public products.json feed');
    expect(brief.findingDetail).toContain('https://shop.test/careers');
  });

  it('refuses to lead with a contact list, because it says nothing about the business', () => {
    const brief = buildResearchBrief({ contact: CONTACT });

    expect(brief.sufficient).toBe(false);
    // The contacts still travel as evidence; they just cannot be the finding.
    expect(brief.evidence.map((row) => row.label)).toEqual(['Published email']);
    expect(brief.domain).toBe('shop.test');
  });

  it('merges and dedupes evidence from every input', () => {
    const brief = buildResearchBrief({ audit: AUDIT, enrich: ENRICH, contact: CONTACT, watch: WATCH });
    expect(brief.evidence.map((row) => row.label)).toEqual(['hiring-up', 'Product structured data', 'Catalog size', 'Published email']);

    const duplicated = buildResearchBrief({ audit: AUDIT, enrich: { ...ENRICH, evidence: AUDIT.evidence } });
    expect(duplicated.evidence).toHaveLength(1);
  });

  it('drops straight into gtm.outreach-draft', () => {
    const brief = buildResearchBrief({ audit: AUDIT, enrich: ENRICH, watch: WATCH });
    const lead = draftLeadSchema.parse({
      domain: 'shop.test',
      name: 'Nonormal',
      contactEmail: 'hello@shop.test',
      topFinding: brief.topFinding,
      findingDetail: brief.findingDetail
    });

    const draft = templateDraft(lead);
    expect(draft.subject).toBe('Nonormal: Hiring is up');
    expect(draft.bodyText).toContain('went from 3 to 7');
  });
});
