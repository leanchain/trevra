import { describe, expect, it } from 'vitest';
import { chooseMessageVariant, delayMilliseconds, renderWorkflowTemplate, workflowStepsSchema } from './workflows.js';

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

  it('renders only the three supported variables', () => {
    expect(renderWorkflowTemplate('Hi {{first_name}} {{last_name}} from {{company}} / {{other}}', { firstName: 'Maya', lastName: 'Smith', company: 'Acme' }))
      .toBe('Hi Maya Smith from Acme / {{other}}');
  });

  it('assigns an A/B variant deterministically', () => {
    const variants = [{ id: 'a', body: 'A', weight: 50 }, { id: 'b', body: 'B', weight: 50 }];
    expect(chooseMessageVariant(variants, 'member:step')).toEqual(chooseMessageVariant(variants, 'member:step'));
  });
});
