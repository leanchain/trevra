import { describe, expect, it } from 'vitest';
import {
  MESSAGE_VARIANT_MAX,
  chooseMessageVariant,
  delayMilliseconds,
  diagnoseWorkflow,
  parseWorkflowSteps,
  renderWorkflowTemplate,
  unsupportedVariables,
  workflowStepsSchema
} from './workflows.js';

describe('LinkedIn manager workflows', () => {
  it('accepts the supported actions and hour/day delays', () => {
    const result = workflowStepsSchema.parse([
      { id: 'view', action: 'profile_view', delayBefore: { amount: 0, unit: 'hours' }, config: {} },
      {
        id: 'invite',
        action: 'connection_request',
        delayBefore: { amount: 3, unit: 'hours' },
        config: { message: 'Hi {{first_name}}' }
      },
      {
        id: 'withdraw',
        action: 'withdraw_pending',
        delayBefore: { amount: 14, unit: 'days' },
        config: { afterDays: 14 }
      },
      {
        id: 'msg',
        action: 'message',
        delayBefore: { amount: 2, unit: 'days' },
        config: {
          variants: [
            { id: 'a', body: 'Hey {{first_name}} at {{company}}', weight: 50 },
            { id: 'b', body: 'Hi {{first_name}}', weight: 50 }
          ]
        }
      },
      {
        id: 'manual',
        action: 'manual_message',
        delayBefore: { amount: 1, unit: 'days' },
        config: { suggestedTemplate: 'Check in with {{first_name}}' }
      },
      { id: 'follow', action: 'follow', delayBefore: { amount: 1, unit: 'hours' }, config: {} }
    ]);
    expect(result).toHaveLength(6);
    expect(delayMilliseconds(result[2].delayBefore)).toBe(14 * 24 * 3_600_000);
  });

  it('accepts only LinkedIn company/event/group destinations for community nodes', () => {
    expect(() =>
      workflowStepsSchema.parse([
        {
          id: 'company',
          action: 'follow_company',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { companyUrl: 'https://evil.example/company/acme/' }
        }
      ])
    ).toThrow(/LinkedIn company URL/);
    expect(
      workflowStepsSchema.parse([
        {
          id: 'group',
          action: 'group_message',
          delayBefore: { amount: 0, unit: 'hours' },
          config: {
            groupUrl: 'https://www.linkedin.com/groups/123/',
            variants: [{ id: 'a', body: 'Hello', weight: 100 }]
          }
        }
      ])[0].action
    ).toBe('group_message');
  });

  it('requires an explicit destructive acknowledgement for disconnect steps', () => {
    expect(() =>
      workflowStepsSchema.parse([
        {
          id: 'disconnect',
          action: 'disconnect',
          delayBefore: { amount: 0, unit: 'hours' },
          config: {}
        }
      ])
    ).toThrow();
    expect(
      workflowStepsSchema.parse([
        {
          id: 'disconnect',
          action: 'disconnect',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { acknowledgeDestructive: true }
        }
      ])[0].action
    ).toBe('disconnect');
  });

  it('rejects unsupported merge variables and duplicate step ids', () => {
    expect(() =>
      workflowStepsSchema.parse([
        {
          id: 'x',
          action: 'connection_request',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { message: 'Hi {{job_title}}' }
        },
        { id: 'x', action: 'follow', delayBefore: { amount: 1, unit: 'days' }, config: {} }
      ])
    ).toThrow();
  });

  it('requires withdrawal to follow an invite', () => {
    expect(() =>
      workflowStepsSchema.parse([
        {
          id: 'withdraw',
          action: 'withdraw_pending',
          delayBefore: { amount: 1, unit: 'days' },
          config: { afterDays: 7 }
        }
      ])
    ).toThrow();
  });

  it('renders supported variables and fails closed on an unknown token', () => {
    expect(
      renderWorkflowTemplate('Hi {{first_name}} {{last_name}} from {{company}} / {{other}}', {
        firstName: 'Maya',
        lastName: 'Smith',
        company: 'Acme'
      })
    ).toBe('Hi Maya Smith from Acme / ');
  });

  // Migration 046 stores an email, a phone and a country on every contact, the
  // importer parses all three and the lead table renders them -- and none of
  // them could reach a message. A merge field for data the operator already
  // supplied is not a feature request, it is the data being connected to the
  // one place it was collected for.

  it('renders arbitrary imported custom fields and accepts them at validation time', () => {
    expect(unsupportedVariables('Hi {{custom.job_title}} at {{custom.icp_tier}}')).toEqual([]);
    expect(
      renderWorkflowTemplate('{{first_name}} / {{custom.job_title}} / {{custom.missing}}', {
        firstName: 'Maya',
        lastName: 'Smith',
        company: 'Acme',
        customFields: { job_title: 'VP Sales' }
      })
    ).toBe('Maya / VP Sales / ');
  });
  it('merges email, phone and country, and renders a missing one as empty rather than as a token', () => {
    expect(
      renderWorkflowTemplate('{{first_name}} / {{email}} / {{phone}} / {{country}}', {
        firstName: 'Maya',
        lastName: 'Smith',
        company: 'Acme',
        email: 'maya@acme.test',
        phone: '+41 79 000 00 00',
        country: 'CH'
      })
    ).toBe('Maya / maya@acme.test / +41 79 000 00 00 / CH');

    // A contact whose CSV had no phone column: a blank, not the word null and
    // not `{{phone}}` arriving in somebody's inbox.
    expect(
      renderWorkflowTemplate('Call {{phone}} in {{country}}.', {
        firstName: 'Maya',
        lastName: 'Smith',
        company: 'Acme',
        phone: null
      })
    ).toBe('Call  in .');

    expect(
      workflowStepsSchema.parse([
        {
          id: 'invite',
          action: 'connection_request',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { message: 'Hi {{first_name}} in {{country}}' }
        }
      ])
    ).toHaveLength(1);
  });

  // `sequence.ts` documents camelCase (`{{firstName}}`) and this renderer filled
  // only snake_case, so a line copied from one screen to the other was refused
  // at save time -- or delivered with the braces intact by anything that leaves
  // unknown tokens standing.
  it('accepts the camelCase spelling of the three fields the sequence path shares', () => {
    expect(
      renderWorkflowTemplate('Hi {{firstName}} {{lastName}} at {{company}}', {
        firstName: 'Maya',
        lastName: 'Smith',
        company: 'Acme'
      })
    ).toBe('Hi Maya Smith at Acme');
    expect(unsupportedVariables('{{firstName}} {{lastName}} {{company}} {{email}}')).toEqual([]);
    expect(
      workflowStepsSchema.parse([
        {
          id: 'invite',
          action: 'connection_request',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { message: 'Hi {{firstName}}' }
        }
      ])
    ).toHaveLength(1);
  });

  // Widening the set does not soften the refusal: a name that is neither a
  // canonical field nor an alias is still rejected on the write that
  // introduced it, which is the whole reason the set is closed.
  it('still refuses a variable that is neither a field nor an alias', () => {
    expect(unsupportedVariables('Hi {{fistName}} at {{jobTitle}}').sort()).toEqual([
      'fistName',
      'jobTitle'
    ]);
    expect(() =>
      workflowStepsSchema.parse([
        {
          id: 'invite',
          action: 'connection_request',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { message: 'Hi {{fistName}}' }
        }
      ])
    ).toThrow();
  });

  it('assigns an A/B variant deterministically', () => {
    const variants = [
      { id: 'a', body: 'A', weight: 50 },
      { id: 'b', body: 'B', weight: 50 }
    ];
    expect(chooseMessageVariant(variants, 'member:step')).toEqual(
      chooseMessageVariant(variants, 'member:step')
    );
  });

  // A/B was capped at two arms by the schema alone -- nothing downstream needed
  // two. The cap is four now, and these are the four properties that make a
  // four-way split worth having rather than a way to lose a fortnight.
  describe('four-way A/B', () => {
    const four = [
      { id: 'a', body: 'A', weight: 25 },
      { id: 'b', body: 'B', weight: 25 },
      { id: 'c', body: 'C', weight: 25 },
      { id: 'd', body: 'D', weight: 25 }
    ];

    it('accepts four message variants and still refuses a fifth', () => {
      expect(MESSAGE_VARIANT_MAX).toBe(4);
      const parsed = workflowStepsSchema.parse([
        {
          id: 'msg',
          action: 'message',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { variants: four }
        }
      ]);
      expect(parsed[0].action === 'message' && parsed[0].config.variants).toHaveLength(4);

      expect(() =>
        workflowStepsSchema.parse([
          {
            id: 'msg',
            action: 'message',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { variants: [...four, { id: 'e', body: 'E', weight: 20 }] }
          }
        ])
      ).toThrow();

      // The uniqueness rule is not weakened by the extra room: four arms, two
      // of them called `c`, is still a rejected save and not a silent overwrite.
      expect(() =>
        workflowStepsSchema.parse([
          {
            id: 'msg',
            action: 'message',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { variants: [...four.slice(0, 3), { id: 'c', body: 'D', weight: 25 }] }
          }
        ])
      ).toThrow();
    });

    it('spreads 1000 members across all four arms in roughly the weighted proportions', () => {
      const counts = new Map(four.map((variant) => [variant.id, 0]));
      for (let member = 0; member < 1000; member += 1) {
        const chosen = chooseMessageVariant(four, `member${member}:msg`);
        counts.set(chosen.id, (counts.get(chosen.id) ?? 0) + 1);
      }
      // Every arm is USED -- the bug this replaces could not reach arms 3 and 4
      // at all -- and none runs away with the split.
      for (const variant of four) {
        const share = (counts.get(variant.id) ?? 0) / 1000;
        expect(share).toBeGreaterThan(0.2);
        expect(share).toBeLessThan(0.3);
      }
      expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(1000);
    });

    // Weights are the operator's, and they do not have to sum to 100: the split
    // is taken from the arms' own total, so 60/20/10/10 means 60/20/10/10 and
    // 6/2/1/1 means the same thing.
    it('honours uneven weights, and is unchanged when the same ratio is written smaller', () => {
      const weighted = [
        { id: 'a', body: 'A', weight: 60 },
        { id: 'b', body: 'B', weight: 20 },
        { id: 'c', body: 'C', weight: 10 },
        { id: 'd', body: 'D', weight: 10 }
      ];
      const scaled = weighted.map((variant) => ({ ...variant, weight: variant.weight / 10 }));

      const spread = (arms: typeof weighted) => {
        const counts = new Map(arms.map((variant) => [variant.id, 0]));
        for (let member = 0; member < 2000; member += 1) {
          const chosen = chooseMessageVariant(arms, `member${member}:msg`);
          counts.set(chosen.id, (counts.get(chosen.id) ?? 0) + 1);
        }
        return new Map([...counts].map(([variantId, count]) => [variantId, count / 2000]));
      };

      // The RATIO is what the two share, not the per-member draw: the sample is
      // taken modulo the arms' own total, so writing the same split smaller
      // moves individual members while the shares land in the same place.
      for (const shares of [spread(weighted), spread(scaled)]) {
        expect(shares.get('a') ?? 0).toBeGreaterThan(0.55);
        expect(shares.get('a') ?? 0).toBeLessThan(0.65);
        expect(shares.get('b') ?? 0).toBeGreaterThan(0.15);
        expect(shares.get('b') ?? 0).toBeLessThan(0.25);
        expect(shares.get('c') ?? 0).toBeGreaterThan(0.05);
        expect(shares.get('c') ?? 0).toBeLessThan(0.15);
        expect(shares.get('d') ?? 0).toBeGreaterThan(0.05);
        expect(shares.get('d') ?? 0).toBeLessThan(0.15);
      }
    });

    // A retried tick must not move a contact between arms: an A/B split whose
    // arms reshuffle on retry measures the retry, not the copy.
    it('re-derives the same arm for the same member:step on every call', () => {
      for (let member = 0; member < 200; member += 1) {
        const seed = `member${member}:msg`;
        const first = chooseMessageVariant(four, seed);
        expect(chooseMessageVariant(four, seed)).toEqual(first);
        expect(chooseMessageVariant(four, seed)).toEqual(first);
        // Different STEP, same member: a workflow with two message steps is two
        // independent tests, not the same draw twice.
        expect(chooseMessageVariant(four, `member${member}:msg2`).id).toBeTruthy();
      }
    });

    it('never falls off the end of the arms, whatever the seed', () => {
      const ids = new Set(four.map((variant) => variant.id));
      for (let seed = 0; seed < 500; seed += 1) {
        expect(ids.has(chooseMessageVariant(four, `seed-${seed}`).id)).toBe(true);
      }
      // One arm is not a draw at all.
      expect(chooseMessageVariant([{ id: 'only', body: 'O', weight: 50 }], 'anything').id).toBe(
        'only'
      );
    });
  });

  // RAISING A MAXIMUM MIGRATES NOTHING. A campaign executes the snapshot it
  // started with, and those snapshots are one- and two-variant JSON written
  // before the cap moved -- they have to keep parsing byte-for-byte as they
  // were stored, weights and all.
  it('still parses a stored 1- and 2-variant workflow exactly as written', () => {
    const stored = JSON.stringify([
      { id: 'view', action: 'profile_view', delayBefore: { amount: 0, unit: 'hours' }, config: {} },
      {
        id: 'msg',
        action: 'message',
        delayBefore: { amount: 2, unit: 'days' },
        config: {
          variants: [
            { id: 'a', body: 'Hey {{first_name}}', weight: 70 },
            { id: 'b', body: 'Hi {{first_name}}', weight: 30 }
          ]
        }
      },
      {
        id: 'solo',
        action: 'message',
        delayBefore: { amount: 3, unit: 'days' },
        config: { variants: [{ id: 'a', body: 'Following up, {{first_name}}', weight: 50 }] }
      }
    ]);

    const steps = parseWorkflowSteps(stored);
    expect(steps).toHaveLength(3);
    const ab = steps[1];
    const solo = steps[2];
    if (ab.action !== 'message' || solo.action !== 'message')
      throw new Error('expected two message steps');
    expect(ab.config.variants.map((variant) => [variant.id, variant.weight])).toEqual([
      ['a', 70],
      ['b', 30]
    ]);
    expect(solo.config.variants).toHaveLength(1);

    // And the split those stored weights describe is still the split that runs:
    // 70/30 out of a total of 100, not a third each because the cap moved.
    let a = 0;
    for (let member = 0; member < 1000; member += 1) {
      if (chooseMessageVariant(ab.config.variants, `member${member}:msg`).id === 'a') a += 1;
    }
    expect(a / 1000).toBeGreaterThan(0.65);
    expect(a / 1000).toBeLessThan(0.75);
  });

  it('accepts a positive per-step SLA and rejects a zero SLA', () => {
    const parsed = workflowStepsSchema.parse([
      {
        id: 'follow-up',
        action: 'message',
        delayBefore: { amount: 1, unit: 'days' },
        sla: { amount: 6, unit: 'hours' },
        config: { variants: [{ id: 'a', body: 'Hi', weight: 100 }] }
      }
    ]);
    expect(parsed[0]?.sla).toEqual({ amount: 6, unit: 'hours' });
    expect(() =>
      workflowStepsSchema.parse([
        {
          id: 'bad-sla',
          action: 'profile_view',
          delayBefore: { amount: 0, unit: 'hours' },
          sla: { amount: 0, unit: 'hours' },
          config: {}
        }
      ])
    ).toThrow(/SLA/i);
  });

  it('suggests sequence fixes without invalidating or rewriting the workflow', () => {
    const diagnosticSteps = workflowStepsSchema.parse([
      {
        id: 'invite',
        action: 'connection_request',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { message: 'Hi {{first_name}}' }
      },
      ...['m1', 'm2', 'm3', 'm4'].map((id, index) => ({
        id,
        action: 'message' as const,
        delayBefore: { amount: index + 1, unit: 'days' as const },
        config: { variants: [{ id: 'a', body: 'Reach me at {{email}}', weight: 100 }] }
      }))
    ]);
    const diagnostics = diagnoseWorkflow(diagnosticSteps, {
      email: { present: 7, total: 10 }
    });
    expect(diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'repeated_action_bottleneck',
        'missing_reply_monitor',
        'missing_invite_cleanup',
        'missing_variable_coverage'
      ])
    );
    // Diagnostics are advisory: the already-parsed input is unchanged.
    expect(diagnosticSteps).toHaveLength(5);
    expect(diagnosticSteps[1]?.action).toBe('message');
  });
});
