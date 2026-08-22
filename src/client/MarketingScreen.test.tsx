import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FAQ_ITEMS } from '../shared/site-metadata';
import { MarketingApp } from './MarketingApp';
import { MarketingScreen } from './MarketingScreen';

describe('MarketingScreen', () => {
  it('renders every FAQ question and answer visibly on the page', () => {
    const html = renderToStaticMarkup(<MarketingApp />);
    expect(html).toContain('class="landing-faq"');
    expect(html).not.toContain('class="deploy-faq"');
    for (const { question, answer } of FAQ_ITEMS) {
      expect(html).toContain(question);
      expect(html).toContain(answer);
    }
  });

  it('connects sourced evidence to a safe payload reveal', () => {
    const html = renderToStaticMarkup(<MarketingApp />);
    expect(html).toContain('HARD FACT');
    expect(html).toContain('REPORTED');
    expect(html).toContain('Reveal the exact payload');
    expect(html).not.toContain('Illustrative example');
    expect(html).not.toContain('Not customer data');
    expect(html).not.toContain('Approve this run');
    expect(html).not.toContain('Approved — released to you');
  });

  it('keeps the landing message narrow', () => {
    const html = renderToStaticMarkup(<MarketingApp />);
    expect(html).toContain('Know who’s worth selling to before you reach out.');
    expect(html).toContain('Research first. Act with conviction.');
    expect(html).toContain('Customer Research');
    expect(html).toContain('high-potential customers');
    expect(html).not.toContain('public modules');
    expect(html).not.toContain('module-row');
    expect(html).not.toContain('Every consequential action travels');
    expect(html).not.toContain('GTM');
    expect(html).not.toContain('account');
    expect(html).not.toContain('—');
    expect(html).toContain('aria-label="GitHub"');
    expect(html).not.toContain('> Source</a>');
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
