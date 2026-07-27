import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFT_CONFIG, capWords, draftOutreach, escapeHtml, templateDraft, wrapHtml } from './draft.js';
import { critique } from './voice.js';

// Ported from the template-fallback half of the Python reference
// src/growth/outreach/drafting.py (the Temporal/LLM path is not ported).
describe('capWords', () => {
  it('leaves text under the cap untouched', () => {
    expect(capWords('one two three', 5)).toBe('one two three');
  });

  it('truncates and marks the cut', () => {
    expect(capWords('one two three four', 2)).toBe('one two…');
  });

  it('drops a dangling separator before the ellipsis', () => {
    expect(capWords('alpha beta, gamma', 2)).toBe('alpha beta…');
    expect(capWords('alpha beta: gamma', 2)).toBe('alpha beta…');
  });
});

describe('templateDraft', () => {
  it('leads with the audit finding when there is one', () => {
    const draft = templateDraft({
      domain: 'shop.example',
      name: 'Shop Example',
      contactName: 'Jo Owner',
      topFinding: 'Product pages ship no structured data'
    });
    expect(draft.subject).toBe('Shop Example: Product pages ship no structured data');
    expect(draft.bodyText).toContain('Hi Jo Owner,');
    // The observation comes first; the sender is not the subject of the opener.
    expect(draft.bodyText).toContain('Product pages ship no structured data on shop.example.');
    expect(draft.bodyText).toContain(DEFAULT_DRAFT_CONFIG.senderName);
  });

  it('includes the supporting detail when the audit supplies one', () => {
    const draft = templateDraft({
      domain: 'shop.example',
      topFinding: 'No Product structured data',
      findingDetail: 'Checked 3 product URLs, none carried schema.org markup.'
    });
    expect(draft.bodyText).toContain('Checked 3 product URLs, none carried schema.org markup.');
  });

  it('says only what it can evidence when there is no finding', () => {
    const draft = templateDraft({ domain: 'shop.example' });
    expect(draft.subject).toBe('shop.example: audit');
    expect(draft.bodyText.startsWith('Hi,')).toBe(true);
    expect(draft.bodyText).toContain('I ran a visibility audit on shop.example.');
  });

  it('is deterministic', () => {
    const lead = { domain: 'shop.example', name: 'Shop Example', contactName: 'Jo' };
    expect(templateDraft(lead)).toEqual(templateDraft(lead));
  });

  it('honours a workspace-supplied offer and sender name', () => {
    const draft = templateDraft({ domain: 'shop.example' }, {
      offer: 'I can send the 7-check report.',
      senderName: 'Pankaj',
      postalAddress: 'Acme, 1 Main St',
      voiceSample: null
    });
    expect(draft.bodyText).toContain('I can send the 7-check report.');
    expect(draft.bodyText).toContain('Pankaj');
  });

  it('passes its own slop critic', () => {
    const lead = {
      domain: 'shop.example',
      name: 'Shop Example',
      contactName: 'Jo Owner',
      topFinding: 'No Product structured data',
      findingDetail: 'Checked 3 product URLs, none carried schema.org markup.'
    };
    const draft = templateDraft(lead);
    const verdict = critique(draft.bodyText, [
      lead.domain, lead.name, lead.contactName, lead.topFinding, lead.findingDetail
    ]);
    expect(verdict.findings.filter((f) => f.severity === 'block')).toEqual([]);
    expect(verdict.passed).toBe(true);
  });
});

describe('draftOutreach slop gate', () => {
  const lead = {
    domain: 'shop.example',
    name: 'Shop Example',
    contactName: 'Jo',
    topFinding: 'No Product structured data'
  };

  it('rejects fluent model output that fails the substitution test', async () => {
    const warn = vi.fn();
    const drafted = await draftOutreach(lead, {
      // Grammatical, polite, and about nobody in particular.
      drafter: async () => ({
        subject: 'Quick idea',
        bodyText:
          'Hi there,\n\nI hope this email finds you well. I came across your ' +
          'business and I love what you are doing.\n\nWe help brands unlock ' +
          'growth with a seamless, robust, best-in-class platform.\n\nWorth a ' +
          'quick call?'
      }),
      logger: { warn }
    });
    expect(drafted.generator).toBe('template');
    expect(warn).toHaveBeenCalled();
  });

  it('accepts model output that names the recipient specifics', async () => {
    const drafted = await draftOutreach(lead, {
      drafter: async () => ({
        subject: 'shop.example structured data',
        bodyText:
          'Hi Jo,\n\nshop.example has no Product structured data, so assistants ' +
          'cannot read your catalogue.\n\nI can send the full audit.\n\nPankaj'
      })
    });
    expect(drafted.generator).toBe('llm');
    expect(drafted.critique.passed).toBe(true);
  });

  it('feeds the critic findings back for one revision pass', async () => {
    const seen: Array<string | undefined> = [];
    const drafted = await draftOutreach(lead, {
      drafter: async (_lead, _config, revision) => {
        seen.push(revision?.instructions);
        return revision
          ? {
              subject: 'shop.example structured data',
              bodyText: 'Hi Jo,\n\nshop.example ships no Product structured data.\n\nI can send the audit.\n\nPankaj'
            }
          : { subject: 'Hi', bodyText: 'I hope this email finds you well. Worth a quick call?' };
      }
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toContain('banned-phrase');
    expect(drafted.generator).toBe('llm');
  });

  it('stops paying the model after maxAttempts and ships the template', async () => {
    const drafter = vi.fn(async () => ({ subject: 'Hi', bodyText: 'I hope this email finds you well.' }));
    const drafted = await draftOutreach(lead, { drafter, maxAttempts: 2 });
    expect(drafter).toHaveBeenCalledTimes(2);
    expect(drafted.generator).toBe('template');
  });
});

describe('draftOutreach', () => {
  it('appends the compliance footer to both parts', async () => {
    const drafted = await draftOutreach({ domain: 'shop.example', name: 'Shop Example' }, {
      config: { ...DEFAULT_DRAFT_CONFIG, postalAddress: 'Trevra, 1 Main St, Zurich' }
    });
    expect(drafted.generator).toBe('template');
    expect(drafted.bodyText).toContain('\n\n---\nTrevra, 1 Main St, Zurich\n');
    expect(drafted.bodyText).toContain("Reply 'unsubscribe' to never hear from us again.");
    expect(drafted.bodyHtml).toContain('Trevra, 1 Main St, Zurich');
    expect(drafted.bodyHtml.toLowerCase()).toContain('unsubscribe');
    expect(drafted.bodyHtml.startsWith('<div style="font-family:sans-serif;white-space:pre-wrap;">')).toBe(true);
    expect(drafted.bodyHtml).toContain('<hr style="margin:24px 0;border:none;border-top:1px solid #ddd;">');
  });

  it('escapes HTML and wraps newlines', () => {
    expect(escapeHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
    expect(wrapHtml('one\ntwo', '\n\n---\nAddr\nBye')).toContain('one<br>\ntwo');
  });

  it('never lets injected audit copy escape into raw HTML', async () => {
    // The finding reaches the body, so it is the injection path that matters.
    const drafted = await draftOutreach({
      domain: 'shop.example',
      topFinding: '<script>alert(1)</script>'
    });
    expect(drafted.bodyHtml).not.toContain('<script>');
    expect(drafted.bodyHtml).toContain('&lt;script&gt;');
  });

  it('falls back to the deterministic template when the drafter throws', async () => {
    const warn = vi.fn();
    const drafted = await draftOutreach({ domain: 'shop.example' }, {
      drafter: async () => {
        throw new Error('model unavailable');
      },
      logger: { warn }
    });
    expect(drafted.generator).toBe('template');
    expect(drafted.subject).toBe('shop.example: audit');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('treats an empty model result as a failure', async () => {
    const drafted = await draftOutreach({ domain: 'shop.example' }, {
      drafter: async () => ({ subject: '  ', bodyText: 'body' })
    });
    expect(drafted.generator).toBe('template');
  });
});
