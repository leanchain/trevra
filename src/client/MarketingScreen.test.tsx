import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketingApp } from './MarketingApp';
import { FAQ_ITEMS } from '../shared/site-metadata';

// The FAQPage JSON-LD (built from this same FAQ_ITEMS array in
// src/shared/site-metadata.ts) only counts toward rich results if Google can
// find matching, visible copy on the page -- so this test is what keeps the
// structured data honest rather than a claim no one checks.
describe('MarketingScreen FAQ disclosure', () => {
  it('renders every FAQ_ITEMS question and answer visibly on the page', () => {
    const html = renderToStaticMarkup(<MarketingApp />);
    expect(html).toContain('class="deploy-faq"');
    for (const { question, answer } of FAQ_ITEMS) {
      expect(html).toContain(question);
      expect(html).toContain(answer);
    }
  });
});
