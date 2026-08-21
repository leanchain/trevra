import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketingApp } from './MarketingApp';
import { MarketingScreen } from './MarketingScreen';
import { FAQ_ITEMS } from '../shared/site-metadata';

// The FAQPage JSON-LD (built from this same FAQ_ITEMS array in
// src/shared/site-metadata.ts) only counts toward rich results if Google can
// find matching, visible copy on the page -- so this test is what keeps the
// structured data honest rather than a claim no one checks.
describe('MarketingScreen', () => {
  it('renders every FAQ_ITEMS question and answer visibly on the page', () => {
    const html = renderToStaticMarkup(<MarketingApp />);
    expect(html).toContain('class="deploy-faq"');
    for (const { question, answer } of FAQ_ITEMS) {
      expect(html).toContain(question);
      expect(html).toContain(answer);
    }
  });

  it('connects sourced evidence to a safe payload reveal', () => {
    const html = renderToStaticMarkup(<MarketingApp />);
    expect(html).toContain('Illustrative example—not customer data.');
    expect(html).toContain('HARD FACT');
    expect(html).toContain('REPORTED');
    expect(html).toContain('Reveal the exact payload');
    expect(html).toContain('cannot trigger an external action');
    expect(html).not.toContain('Approve this run');
    expect(html).not.toContain('Approved — released to you');
  });

  it('names the real conversion state', () => {
    const batchHtml = renderToStaticMarkup(<MarketingApp />);
    expect(batchHtml).toContain('Request hosted access');
    expect(batchHtml).not.toContain('Open Trevra');

    const hostedHtml = renderToStaticMarkup(
      <MarketingScreen
        hostedAppUrl="https://app.usetrevra.example"
        onGetStarted={() => undefined}
      />
    );
    expect(hostedHtml).toContain('Open workspace');
    expect(hostedHtml).not.toContain('Request hosted access');
  });
});
