import { describe, expect, it } from 'vitest';
import { channelPrepareSkill, draftEvidence, prepareChannelPost } from './prepare.js';

const ctx = { db: null as never, workspaceId: 'ws', now: () => new Date(0) };

const goodDraft = {
  title: 'Trevra 0.4 ships distribution channels',
  body: 'Trevra 0.4 ships 13 distribution channels. Each one names the policy that blocks automation.',
  url: 'https://github.com/pankaj/trevra',
  tags: ['open-source']
};

// Grammatical, warm, and about nobody. Exactly what the critic exists to stop.
const slopDraft = {
  title: 'Trevra 0.4 ships distribution channels',
  body:
    'I wanted to reach out because I hope this email finds you well. ' +
    'Our seamless, best-in-class platform will revolutionize your workflow.',
  url: 'https://github.com/pankaj/trevra',
  tags: ['open-source']
};

describe('draftEvidence', () => {
  it("uses the draft's own title, url, and tags as the specificity anchor", () => {
    expect(draftEvidence(goodDraft)).toEqual([
      'Trevra 0.4 ships distribution channels',
      'https://github.com/pankaj/trevra',
      'open-source'
    ]);
  });

  it('tolerates a draft with no url and no tags', () => {
    expect(draftEvidence({ title: 'Trevra', body: 'Out now.' })).toEqual(['Trevra']);
  });
});

describe('gtm.channel-prepare', () => {
  it('declares itself side-effect free and approval-free', () => {
    expect(channelPrepareSkill.manifest.id).toBe('gtm.channel-prepare');
    expect(channelPrepareSkill.manifest.sideEffect).toBe('none');
    expect(channelPrepareSkill.manifest.requiresApproval).toBe(false);
  });

  it('adapts the draft to the named channel and reports its automation mode', () => {
    const prepared = prepareChannelPost('bluesky', goodDraft);
    expect(prepared.post.channelKey).toBe('bluesky');
    expect(prepared.post.body.length).toBeLessThanOrEqual(300);
    expect(prepared.mode).toBe('api-publish');
    expect(prepared.automationReason).toContain('com.atproto.repo.createRecord');
  });

  it('hands a human the submit URL for a prepare-only channel', () => {
    const prepared = prepareChannelPost('hackernews', goodDraft);
    expect(prepared.mode).toBe('prepare-only');
    expect(prepared.post.submitUrl).toBe('https://news.ycombinator.com/submit');
  });

  it('passes copy anchored in the draft’s own evidence', () => {
    const prepared = prepareChannelPost('bluesky', goodDraft);
    expect(prepared.critique.passed).toBe(true);
    expect(prepared.instructions).toBe('');
  });

  // The point of the skill: a failing gate is reported, not swallowed.
  it('surfaces a failing critique instead of passing the copy through', () => {
    const prepared = prepareChannelPost('linkedin', slopDraft);
    expect(prepared.critique.passed).toBe(false);
    expect(prepared.critique.findings.map((finding) => finding.check)).toContain('banned-phrase');
    expect(prepared.instructions).toContain('banned-phrase');
    // The post is still returned, so the caller can see exactly what failed.
    expect(prepared.post.body).toContain('best-in-class');
  });

  it('reports the failure through the skill contract too, rather than throwing', async () => {
    const result = await channelPrepareSkill.run({ channel: 'linkedin', draft: slopDraft, evidence: [] }, ctx);
    expect(result.critique.passed).toBe(false);
    expect(result.instructions.length).toBeGreaterThan(0);
    expect(() => channelPrepareSkill.manifest.outputSchema.parse(result)).not.toThrow();
  });

  it('critiques the adapted body, not the raw draft', () => {
    // Instagram strips the URL, so the critique runs against copy with no link in it.
    const prepared = prepareChannelPost('instagram', {
      ...goodDraft,
      body: 'Trevra 0.4 ships 13 distribution channels at https://github.com/pankaj/trevra today.'
    });
    expect(prepared.post.body).not.toContain('http');
    expect(prepared.critique.wordCount).toBe(prepared.post.body.split(/\s+/).filter(Boolean).length);
  });

  it('accepts extra evidence on top of the draft’s own', () => {
    const draft = { ...goodDraft, body: 'Trevra 0.4 ships distribution channels. Rate limits live in the adapter comment.' };
    const bare = prepareChannelPost('bluesky', draft);
    const withExtra = prepareChannelPost('bluesky', draft, { evidence: ['adapter comment'] });
    expect(bare.critique.genericRatio).toBe(0.5);
    expect(withExtra.critique.genericRatio).toBe(0);
  });

  it('lets a caller raise the word ceiling for a long-form channel, deliberately', () => {
    const longBody = `Trevra 0.4 ships 13 distribution channels. ${'Each adapter names its own policy fact. '.repeat(20)}`;
    const strict = prepareChannelPost('devto', { ...goodDraft, body: longBody });
    const loosened = prepareChannelPost('devto', { ...goodDraft, body: longBody }, { criticOptions: { maxWords: 5_000 } });
    expect(strict.critique.findings.map((finding) => finding.check)).toContain('too-long');
    expect(loosened.critique.findings.map((finding) => finding.check)).not.toContain('too-long');
  });

  it('refuses a channel key it does not know', () => {
    expect(() => prepareChannelPost('myspace', goodDraft)).toThrow("unknown channel 'myspace'");
  });
});
