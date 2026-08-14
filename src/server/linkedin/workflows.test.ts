import { describe, expect, it } from 'vitest';
import { chooseMessageVariant, delayMilliseconds, renderWorkflowTemplate, unsupportedVariables, workflowStepsSchema } from './workflows.js';

describe('LinkedIn manager workflows', () => {
  it('accepts the supported actions and hour/day delays', () => {
    const result = workflowStepsSchema.parse([
      { id: 'view', action: 'profile_view', delayBefore: { amount: 0, unit: 'hours' }, config: {} },
      { id: 'invite', action: 'connection_request', delayBefore: { amount: 3, unit: 'hours' }, config: { message: 'Hi {{first_name}}' } },
      { id: 'withdraw', action: 'withdraw_pending', delayBefore: { amount: 14, unit: 'days' }, config: { afterDays: 14 } },
      { id: 'msg', action: 'message', delayBefore: { amount: 2, unit: 'days' }, config: { variants: [{ id: 'a', body: 'Hey {{first_name}} at {{company}}', weight: 50 }, { id: 'b', body: 'Hi {{first_name}}', weight: 50 }] } },
      { id: 'manual', action: 'manual_message', delayBefore: { amount: 1, unit: 'days' }, config: { suggestedTemplate: 'Check in with {{first_name}}' } },
      { id: 'follow', action: 'follow', delayBefore: { amount: 1, unit: 'hours' }, config: {} }
    ]);
    expect(result).toHaveLength(6);
    expect(delayMilliseconds(result[2].delayBefore)).toBe(14 * 24 * 3_600_000);
  });

  it('rejects unsupported merge variables and duplicate step ids', () => {
    expect(() => workflowStepsSchema.parse([
      { id: 'x', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{job_title}}' } },
      { id: 'x', action: 'follow', delayBefore: { amount: 1, unit: 'days' }, config: {} }
    ])).toThrow();
  });

  it('requires withdrawal to follow an invite', () => {
    expect(() => workflowStepsSchema.parse([{ id: 'withdraw', action: 'withdraw_pending', delayBefore: { amount: 1, unit: 'days' }, config: { afterDays: 7 } }])).toThrow();
  });

  it('renders the supported variables and leaves an unknown token standing', () => {
    expect(renderWorkflowTemplate('Hi {{first_name}} {{last_name}} from {{company}} / {{other}}', { firstName: 'Maya', lastName: 'Smith', company: 'Acme' }))
      .toBe('Hi Maya Smith from Acme / {{other}}');
  });

  // Migration 046 stores an email, a phone and a country on every contact, the
  // importer parses all three and the lead table renders them -- and none of
  // them could reach a message. A merge field for data the operator already
  // supplied is not a feature request, it is the data being connected to the
  // one place it was collected for.
  it('merges email, phone and country, and renders a missing one as empty rather than as a token', () => {
    expect(renderWorkflowTemplate(
      '{{first_name}} / {{email}} / {{phone}} / {{country}}',
      { firstName: 'Maya', lastName: 'Smith', company: 'Acme', email: 'maya@acme.test', phone: '+41 79 000 00 00', country: 'CH' }
    )).toBe('Maya / maya@acme.test / +41 79 000 00 00 / CH');

    // A contact whose CSV had no phone column: a blank, not the word null and
    // not `{{phone}}` arriving in somebody's inbox.
    expect(renderWorkflowTemplate('Call {{phone}} in {{country}}.', { firstName: 'Maya', lastName: 'Smith', company: 'Acme', phone: null }))
      .toBe('Call  in .');

    expect(workflowStepsSchema.parse([
      { id: 'invite', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{first_name}} in {{country}}' } }
    ])).toHaveLength(1);
  });

  // `sequence.ts` documents camelCase (`{{firstName}}`) and this renderer filled
  // only snake_case, so a line copied from one screen to the other was refused
  // at save time -- or delivered with the braces intact by anything that leaves
  // unknown tokens standing.
  it('accepts the camelCase spelling of the three fields the sequence path shares', () => {
    expect(renderWorkflowTemplate('Hi {{firstName}} {{lastName}} at {{company}}', { firstName: 'Maya', lastName: 'Smith', company: 'Acme' }))
      .toBe('Hi Maya Smith at Acme');
    expect(unsupportedVariables('{{firstName}} {{lastName}} {{company}} {{email}}')).toEqual([]);
    expect(workflowStepsSchema.parse([
      { id: 'invite', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{firstName}}' } }
    ])).toHaveLength(1);
  });

  // Widening the set does not soften the refusal: a name that is neither a
  // canonical field nor an alias is still rejected on the write that
  // introduced it, which is the whole reason the set is closed.
  it('still refuses a variable that is neither a field nor an alias', () => {
    expect(unsupportedVariables('Hi {{fistName}} at {{jobTitle}}').sort()).toEqual(['fistName', 'jobTitle']);
    expect(() => workflowStepsSchema.parse([
      { id: 'invite', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{fistName}}' } }
    ])).toThrow();
  });

  it('assigns an A/B variant deterministically', () => {
    const variants = [{ id: 'a', body: 'A', weight: 50 }, { id: 'b', body: 'B', weight: 50 }];
    expect(chooseMessageVariant(variants, 'member:step')).toEqual(chooseMessageVariant(variants, 'member:step'));
  });
});
