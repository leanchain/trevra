import { describe, expect, it } from 'vitest';
import {
  BANNED_PHRASES,
  copyCritiqueSkill,
  critique,
  critiqueToInstructions,
  evidenceTokens,
  splitSentences
} from './voice.js';

const LEAD_EVIDENCE = ['shop.example', 'Shop Example', 'Jo Owner', 'No Product structured data'];

const blocks = (body: string, evidence = LEAD_EVIDENCE) =>
  critique(body, evidence).findings.filter((finding) => finding.severity === 'block').map((f) => f.check);

describe('evidenceTokens', () => {
  it('splits on domain and punctuation boundaries', () => {
    const tokens = evidenceTokens(['shop.example', 'Jo Owner']);
    expect(tokens.has('shop')).toBe(true);
    expect(tokens.has('example')).toBe(true);
    expect(tokens.has('owner')).toBe(true);
  });

  it('drops stopwords and short tokens that cannot prove specificity', () => {
    const tokens = evidenceTokens(['the site has a lot of data']);
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('has')).toBe(false);
    expect(tokens.has('data')).toBe(false);
    expect(tokens.has('lot')).toBe(true);
  });

  it('ignores empty sources', () => {
    expect(evidenceTokens([null, undefined, '']).size).toBe(0);
  });
});

describe('splitSentences', () => {
  it('splits on terminators and newlines', () => {
    expect(splitSentences('One. Two! Three?\n\nFour')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
  });
});

describe('the substitution test', () => {
  it('blocks copy that would read the same sent to a competitor', () => {
    // Grammatical, warm, and about nobody.
    const body = 'Hi there,\n\nWe help brands grow faster than ever.\n\nWorth a chat?';
    expect(blocks(body)).toContain('generic-sentence');
  });

  it('passes copy anchored in the recipient’s own evidence', () => {
    const body = 'Hi Jo Owner,\n\nshop.example has no Product structured data.\n\nI can send the audit.\n\nPankaj';
    expect(blocks(body)).toEqual([]);
  });

  it('counts a bare number as recipient-specific', () => {
    const verdict = critique('Hi,\n\n3 of 7 checks failed.\n\nPankaj', LEAD_EVIDENCE);
    expect(verdict.findings.map((f) => f.check)).not.toContain('generic-sentence');
  });

  it('reports a generic ratio and blocks when there is no evidence at all', () => {
    const verdict = critique('We can help you grow.', []);
    expect(verdict.genericRatio).toBe(1);
    expect(verdict.passed).toBe(false);
  });
});

describe('banned phrases', () => {
  it.each([
    'I hope this email finds you well.',
    'I came across your company.',
    'Just wanted to check in.',
    'We deliver a seamless, world-class experience.',
    "I'd love to connect."
  ])('blocks %j', (phrase) => {
    expect(blocks(`Hi Jo Owner,\n\nshop.example. ${phrase}\n\nPankaj`)).toContain('banned-phrase');
  });

  it('quotes the offending phrase so a drafter can fix it', () => {
    const verdict = critique('Hi,\n\nI hope this email finds you well on shop.example.\n\nPankaj', LEAD_EVIDENCE);
    const finding = verdict.findings.find((f) => f.check === 'banned-phrase');
    expect(finding?.excerpt).toBe('hope this email finds you well');
  });

  it('keeps the corpus free of duplicates', () => {
    expect(new Set(BANNED_PHRASES).size).toBe(BANNED_PHRASES.length);
  });
});

describe('structural checks', () => {
  it('blocks copy over the word ceiling', () => {
    const body = `Hi Jo Owner,\n\nshop.example ${'word '.repeat(120)}`;
    expect(blocks(body)).toContain('too-long');
  });

  it('blocks more than one ask', () => {
    const body =
      'Hi Jo Owner,\n\nshop.example has no Product structured data.\n\n' +
      'Worth a 15-minute call, or want me to send the shop.example audit first?\n\nPankaj';
    expect(blocks(body)).toContain('multiple-asks');
  });

  it('allows exactly one ask', () => {
    const body = 'Hi Jo Owner,\n\nshop.example has no Product structured data.\n\nWant the audit?\n\nPankaj';
    expect(blocks(body)).not.toContain('multiple-asks');
  });

  it('warns on hedging, adverb padding, and triads', () => {
    const checks = critique(
      'Hi Jo Owner,\n\nI think shop.example possibly needs structured data, better markup, and faster pages.\n\nPankaj',
      LEAD_EVIDENCE
    ).findings.map((f) => f.check);
    expect(checks).toContain('hedging');
    expect(checks).toContain('tricolon');
  });

  it('warns when the opener is about the sender', () => {
    const checks = critique(
      'Hi Jo Owner,\n\nWe build tools for shop.example operators.\n\nPankaj',
      LEAD_EVIDENCE
    ).findings.map((f) => f.check);
    expect(checks).toContain('sender-first-opener');
  });

  it('fails once warnings exceed the budget even with no blocking finding', () => {
    const verdict = critique(
      'Hi Jo Owner,\n\nI think shop.example possibly needs structured data, better markup, and faster pages. ' +
        'It seems the catalogue is largely, mostly, and generally invisible.\n\nPankaj',
      LEAD_EVIDENCE
    );
    expect(verdict.findings.filter((f) => f.severity === 'block')).toEqual([]);
    expect(verdict.passed).toBe(false);
  });
});

describe('critiqueToInstructions', () => {
  it('is empty for passing copy', () => {
    const verdict = critique('Hi Jo Owner,\n\nshop.example has no Product structured data.\n\nPankaj', LEAD_EVIDENCE);
    expect(critiqueToInstructions(verdict)).toBe('');
  });

  it('names every failing check for the regeneration prompt', () => {
    const verdict = critique('I hope this email finds you well.', LEAD_EVIDENCE);
    const instructions = critiqueToInstructions(verdict);
    expect(instructions).toContain('banned-phrase');
    expect(instructions).toContain('[block]');
  });
});

describe('copyCritiqueSkill', () => {
  const ctx = { db: null as never, workspaceId: 'ws', now: () => new Date(0) };

  it('declares itself side-effect free and approval-free', () => {
    expect(copyCritiqueSkill.manifest.sideEffect).toBe('none');
    expect(copyCritiqueSkill.manifest.requiresApproval).toBe(false);
  });

  it('returns findings and actionable instructions', async () => {
    const result = await copyCritiqueSkill.run(
      { body: 'I hope this email finds you well.', evidence: ['shop.example'] },
      ctx
    );
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.check === 'banned-phrase')).toBe(true);
    expect(result.instructions).toContain('banned-phrase');
  });

  it('passes evidence-anchored copy', async () => {
    const result = await copyCritiqueSkill.run(
      { body: 'shop.example has no Product structured data.', evidence: ['shop.example', 'Product structured data'] },
      ctx
    );
    expect(result.passed).toBe(true);
    expect(result.instructions).toBe('');
  });
});
