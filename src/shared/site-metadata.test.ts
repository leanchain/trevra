import { describe, expect, it } from 'vitest';
import { buildStructuredData, FAQ_ITEMS, SITE_DESCRIPTION } from './site-metadata.js';

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
