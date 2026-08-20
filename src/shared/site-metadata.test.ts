import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStructuredData,
  buildWebPageStructuredData,
  FAQ_ITEMS,
  renderRobotsTxt,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE
} from './site-metadata.js';

/** The card's visible copy: markup, style, and the inline logo SVG stripped. */
const ogCardText = (await readFile(resolve('assets/og/trevra-social.html'), 'utf8'))
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<style>[\s\S]*?<\/style>/g, ' ')
  .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const BASE_CONFIG = {
  origin: 'https://trevra.example',
  name: 'Trevra',
  legalName: 'Trevra, Inc.',
  description: SITE_DESCRIPTION,
  supportEmail: 'support@trevra.example',
  githubUrl: ''
};

function webApplication(graph: unknown[]) {
  return graph.find(
    (node): node is { featureList: string[] } =>
      typeof node === 'object' &&
      node !== null &&
      (node as { '@type'?: string })['@type'] === 'WebApplication'
  )!;
}

function organization(graph: unknown[]) {
  return graph.find(
    (node): node is { sameAs?: string[] } =>
      typeof node === 'object' &&
      node !== null &&
      (node as { '@type'?: string })['@type'] === 'Organization'
  )!;
}

function faqPage(graph: unknown[]) {
  return graph.find(
    (node): node is { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> } =>
      typeof node === 'object' &&
      node !== null &&
      (node as { '@type'?: string })['@type'] === 'FAQPage'
  )!;
}

describe('buildStructuredData', () => {
  it('builds FAQPage.mainEntity from FAQ_ITEMS, length and text matching', () => {
    const data = buildStructuredData(BASE_CONFIG);
    const faq = faqPage(data['@graph']);
    expect(faq.mainEntity).toHaveLength(FAQ_ITEMS.length);
    faq.mainEntity.forEach((entity, index) => {
      expect(entity.name).toBe(FAQ_ITEMS[index].question);
      expect(entity.acceptedAnswer.text).toBe(FAQ_ITEMS[index].answer);
    });
  });

  it('includes sameAs when a githubUrl is given', () => {
    const data = buildStructuredData({
      ...BASE_CONFIG,
      githubUrl: 'https://github.com/trevra/trevra'
    });
    const org = organization(data['@graph']);
    expect(org.sameAs).toEqual(['https://github.com/trevra/trevra']);
  });

  it('omits sameAs entirely when githubUrl is empty', () => {
    const data = buildStructuredData({ ...BASE_CONFIG, githubUrl: '' });
    const org = organization(data['@graph']);
    expect(org).not.toHaveProperty('sameAs');
  });

  it('keeps featureList and description free of retired positioning', () => {
    const data = buildStructuredData(BASE_CONFIG);
    const app = webApplication(data['@graph']);
    const retired = ['Proof Pack', 'scope-creep', 'source to paid'];
    const featureText = app.featureList.join(' ');
    for (const phrase of retired) {
      expect(featureText).not.toContain(phrase);
      expect(SITE_DESCRIPTION).not.toContain(phrase);
    }
  });
});

describe('buildWebPageStructuredData', () => {
  it('gives every page an addressable @id under its own path', () => {
    const data = buildWebPageStructuredData({
      origin: 'https://trevra.example',
      path: '/privacy',
      title: 'Privacy | Trevra',
      description: 'What Trevra records.'
    });
    expect(data['@id']).toBe('https://trevra.example/privacy/#webpage');
    expect(data.url).toBe('https://trevra.example/privacy');
  });
});

describe('renderRobotsTxt', () => {
  it('advertises the given origin, never a hardcoded production one', () => {
    const robots = renderRobotsTxt('https://preview.example');
    expect(robots).toContain('Sitemap: https://preview.example/sitemap.xml');
    expect(robots).toContain('Host: preview.example');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).not.toContain('usetrevra.com');
  });
});

/**
 * assets/og/trevra-social.html is the source `npm run og:build` rasterizes
 * into public/og/trevra-social.png. Headless Chrome renders literal markup, so
 * nothing binds the card's copy to SITE_TITLE/SITE_DESCRIPTION -- this test is
 * that binding. Changing the product copy fails here until the card is
 * rewritten and the PNG regenerated, rather than shipping retired positioning
 * on every share and LLM preview.
 */
describe('the OG card source', () => {
  it('carries the wordmark and the current headline', () => {
    expect(ogCardText).toContain(SITE_NAME);
    // 'GTM infrastructure for AI agents' -- SITE_TITLE without the brand prefix.
    expect(ogCardText).toContain(SITE_TITLE.split('—')[1].trim());
  });

  it('carries the supporting sentence, clause for clause', () => {
    const clauses = SITE_DESCRIPTION.split('. ')[1]
      .replace(/\.$/, '')
      .split(/,\s*(?:and\s+)?/);
    expect(clauses.length).toBeGreaterThan(1);
    for (const clause of clauses) expect(ogCardText.toLowerCase()).toContain(clause.toLowerCase());
  });
});
