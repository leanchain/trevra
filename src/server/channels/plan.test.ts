import { describe, expect, it } from 'vitest';
import { PLAN_WEIGHTS, candidateChannels, channelPlanSkill, planChannels } from './plan.js';
import { getChannel, listEnabled } from './registry.js';

const ctx = { db: null as never, workspaceId: 'ws', now: () => new Date(0) };

const draft = {
  title: 'Trevra 0.4 ships distribution channels',
  body: 'Trevra 0.4 ships 13 distribution channel adapters. Each one names the policy that blocks automation.',
  url: 'https://github.com/pankaj/trevra',
  tags: ['open-source', 'launch']
};

const AUDIENCE = ['developers', 'open-source', 'founders'];

describe('gtm.channel-plan', () => {
  it('declares itself side-effect free and approval-free', () => {
    expect(channelPlanSkill.manifest.id).toBe('gtm.channel-plan');
    expect(channelPlanSkill.manifest.sideEffect).toBe('none');
    expect(channelPlanSkill.manifest.requiresApproval).toBe(false);
  });

  it('is deterministic', () => {
    const first = planChannels(draft, AUDIENCE);
    const second = planChannels(draft, AUDIENCE);
    expect(second).toEqual(first);
  });

  it('ranks by fit descending, breaking every tie on channel key', () => {
    const { ranked } = planChannels(draft, AUDIENCE);
    for (let index = 1; index < ranked.length; index += 1) {
      const previous = ranked[index - 1];
      const current = ranked[index];
      expect(previous.fit).toBeGreaterThanOrEqual(current.fit);
      if (previous.fit === current.fit) expect(previous.key < current.key).toBe(true);
    }
  });

  it('locks the reference ordering for this draft and audience', () => {
    const { ranked } = planChannels(draft, AUDIENCE);
    expect(ranked.map((entry) => entry.key)).toEqual([
      'devto',
      'bluesky',
      'github',
      'hackernews',
      'hashnode',
      'lobsters',
      'mastodon',
      'reddit',
      'producthunt',
      'x',
      'indiehackers',
      'linkedin'
    ]);
    expect(ranked[0].fit).toBe(1);
    expect(ranked.at(-1)!.fit).toBe(0.2);
  });

  it('emits a reason for every point every channel scored', () => {
    const { reasons } = planChannels(draft, AUDIENCE);
    expect(reasons).toContain('devto: base 0');
    expect(reasons).toContain('devto: +0.6 audience 3/3 (developers, founders, open-source)');
    expect(reasons).toContain(`devto: +${PLAN_WEIGHTS.apiPublish} api-publish (no human step)`);
    expect(reasons).toContain(`devto: +${PLAN_WEIGHTS.readyToPost} draft is ready as written`);
    expect(reasons).toContain('github: +0.4 audience 2/3 (developers, open-source)');
    expect(reasons.at(-1)).toBe(
      'order: devto > bluesky > github > hackernews > hashnode > lobsters > mastodon > reddit > producthunt > x > indiehackers > linkedin (fit desc, then key asc)'
    );
  });

  it('carries the automation reason into every ranked entry, so it cannot be lost', () => {
    for (const entry of planChannels(draft, AUDIENCE).ranked) {
      const channel = getChannel(entry.key)!;
      expect(entry.automationReason).toBe(channel.automation.reason);
      expect(entry.automationReason.trim().length).toBeGreaterThan(0);
      expect(entry.mode).toBe(channel.automation.mode);
    }
  });

  it('returns each channel its own adapted post', () => {
    const { ranked } = planChannels(draft, AUDIENCE);
    for (const entry of ranked) {
      expect(entry.post.channelKey).toBe(entry.key);
      const channel = listEnabled().find((candidate) => candidate.key === entry.key)!;
      expect(entry.post.body.length).toBeLessThanOrEqual(channel.constraints.maxChars);
      if (entry.mode === 'prepare-only') expect(entry.post.submitUrl).toBeTruthy();
    }
  });

  it('plans across enabled channels only, unless a channel is named', () => {
    expect(planChannels(draft, AUDIENCE).ranked.map((entry) => entry.key)).not.toContain('instagram');
    const named = planChannels(draft, AUDIENCE, ['instagram', 'devto']);
    expect(named.ranked.map((entry) => entry.key).sort()).toEqual(['devto', 'instagram']);
  });

  it('scores nothing on audience when no audience is given, and says so', () => {
    const plan = planChannels(draft, []);
    expect(plan.audience).toEqual([]);
    expect(plan.reasons[0]).toBe('audience: none given, so no channel earns an audience score');
    for (const entry of plan.ranked) expect(entry.matchedAudience).toEqual([]);
    expect(plan.ranked.every((entry) => entry.fit <= PLAN_WEIGHTS.apiPublish + PLAN_WEIGHTS.readyToPost)).toBe(true);
  });

  it('normalises and de-duplicates audience tags before matching', () => {
    const messy = planChannels(draft, ['  Developers ', 'DEVELOPERS', 'Open-Source', 'founders']);
    expect(messy.audience).toEqual(['developers', 'founders', 'open-source']);
    expect(messy.ranked).toEqual(planChannels(draft, AUDIENCE).ranked);
  });

  it('refuses to silently drop a channel key it does not know', () => {
    expect(() => candidateChannels(['devto', 'myspace'])).toThrow("unknown channel 'myspace'");
    expect(() => planChannels(draft, AUDIENCE, ['myspace'])).toThrow("unknown channel 'myspace'");
  });

  it('validates its own output schema', async () => {
    const result = await channelPlanSkill.run({ draft, audience: AUDIENCE }, ctx);
    expect(() => channelPlanSkill.manifest.outputSchema.parse(result)).not.toThrow();
  });

  it('defaults the audience to empty rather than failing', () => {
    const parsed = channelPlanSkill.manifest.inputSchema.parse({ draft });
    expect(parsed.audience).toEqual([]);
  });
});
