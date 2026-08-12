import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BRANCH_ON_VALUES,
  conditionOf,
  conditionRejection,
  cycleRejection,
  evaluateBranches,
  hasBranching,
  stepConditionSchema,
  type BranchActionRow,
  type BranchableStep,
  type BranchEvaluationInput
} from './branching.js';
import { SEQUENCE_TEMPLATES } from './templates.js';

/**
 * Branching is pure -- no db, no clock, no network -- so these tests need no
 * Postgres, exactly like `sequence.test.ts`. Every instant here is injected.
 */

const DAY_MS = 86_400_000;
/** Campaign day 0. A Monday, so nothing here accidentally depends on a weekend. */
const START = new Date('2026-03-02T09:00:00.000Z');

function at(days: number, hours = 0): Date {
  return new Date(START.getTime() + days * DAY_MS + hours * 3_600_000);
}

/** The Dripify shape, written as steps: invite, then one arm for each answer. */
function branchingSequence(): BranchableStep[] {
  return [
    { id: 'view', day: 0, kind: 'profile_view' },
    { id: 'invite', day: 1, kind: 'invite' },
    { id: 'accepted-dm', day: 3, kind: 'dm', condition: { on: 'accepted', ofStepId: 'invite' } },
    { id: 'fallback-inmail', day: 3, kind: 'inmail', condition: { on: 'not_accepted', ofStepId: 'invite' } },
    { id: 'nudge', day: 7, kind: 'dm', condition: { on: 'not_replied', ofStepId: 'accepted-dm' } }
  ];
}

function evaluate(overrides: Partial<BranchEvaluationInput> = {}) {
  return evaluateBranches({
    steps: branchingSequence(),
    targetRef: 'https://linkedin.com/in/maya',
    actions: [],
    campaignStartedAt: START,
    now: at(0),
    ...overrides
  });
}

function row(kind: BranchActionRow['kind'], status: BranchActionRow['status'], extra: Partial<BranchActionRow> = {}): BranchActionRow {
  return { kind, status, ...extra };
}

function outcomeOf(evaluation: ReturnType<typeof evaluate>, stepId: string): string {
  const decision = evaluation.decisions.find((entry) => entry.stepId === stepId);
  if (!decision) throw new Error(`no decision for '${stepId}'`);
  return decision.outcome;
}

describe('the vocabulary is closed', () => {
  it('has exactly the five branches, and the schema accepts nothing else', () => {
    expect([...BRANCH_ON_VALUES]).toEqual(['accepted', 'replied', 'not_accepted', 'not_replied', 'always']);
    expect(stepConditionSchema.safeParse({ on: 'accepted', ofStepId: 'invite' }).success).toBe(true);
    expect(stepConditionSchema.safeParse({ on: 'if_they_seem_keen', ofStepId: 'invite' }).success).toBe(false);
    expect(stepConditionSchema.safeParse({ on: 'accepted' }).success).toBe(false);
  });

  it('keeps the migration and the union spelling the same five values', () => {
    const sql = readFileSync(new URL('../../../migrations/033_linkedin_sequence_branching.sql', import.meta.url), 'utf8');
    for (const branch of BRANCH_ON_VALUES) expect(sql).toContain(`"${branch}"`);
  });
});

describe('branching is a pure extension', () => {
  it('accepts every sequence that exists today, unchanged', () => {
    for (const template of SEQUENCE_TEMPLATES) {
      expect(conditionRejection(template.steps as unknown as BranchableStep[])).toBeNull();
      expect(hasBranching(template.steps as unknown as BranchableStep[])).toBe(false);
    }
  });

  it('reads an absent condition, and an explicit always, as no condition at all', () => {
    expect(conditionOf({ id: 'a', day: 0, kind: 'dm' })).toBeNull();
    expect(conditionOf({ id: 'a', day: 0, kind: 'dm', condition: null })).toBeNull();
    expect(conditionOf({ id: 'a', day: 0, kind: 'dm', condition: { on: 'always', ofStepId: 'invite' } })).toBeNull();
  });

  it('gates an unconditional sequence on its day and nothing else', () => {
    const steps: BranchableStep[] = [
      { id: 'view', day: 0, kind: 'profile_view' },
      { id: 'invite', day: 1, kind: 'invite' },
      { id: 'close', day: 14, kind: 'dm' }
    ];

    expect(evaluate({ steps, now: at(0) }).due).toEqual(['view']);
    expect(evaluate({ steps, now: at(1) }).due).toEqual(['view', 'invite']);
    expect(evaluate({ steps, now: at(14) }).due).toEqual(['view', 'invite', 'close']);
    expect(evaluate({ steps, now: at(14) }).skipped).toEqual([]);
  });
});

describe('conditionRejection', () => {
  function reject(steps: BranchableStep[]): string {
    const message = conditionRejection(steps);
    expect(message).not.toBeNull();
    return message as string;
  }

  it('accepts the branching shape this feature exists for', () => {
    expect(conditionRejection(branchingSequence())).toBeNull();
  });

  it('refuses a branch outside the closed vocabulary', () => {
    const message = reject([
      { id: 'invite', day: 0, kind: 'invite' },
      { id: 'dm', day: 2, kind: 'dm', condition: { on: 'seems_interested' as never, ofStepId: 'invite' } }
    ]);
    expect(message).toContain("Step 'dm'");
    expect(message).toContain('seems_interested');
  });

  it('refuses a condition that names no step', () => {
    const message = reject([
      { id: 'invite', day: 0, kind: 'invite' },
      { id: 'dm', day: 2, kind: 'dm', condition: { on: 'accepted', ofStepId: '  ' } }
    ]);
    expect(message).toContain("Step 'dm'");
  });

  it('refuses a step that waits on itself', () => {
    const message = reject([
      { id: 'invite', day: 0, kind: 'invite' },
      { id: 'dm', day: 2, kind: 'dm', condition: { on: 'replied', ofStepId: 'dm' } }
    ]);
    expect(message).toContain("Step 'dm' waits on itself");
  });

  it('refuses a forward reference, and says it is a forward reference', () => {
    const message = reject([
      { id: 'dm', day: 2, kind: 'dm', condition: { on: 'accepted', ofStepId: 'invite' } },
      { id: 'invite', day: 3, kind: 'invite' }
    ]);
    expect(message).toContain("Step 'dm' waits on step 'invite'");
    expect(message).toContain('comes after it');
  });

  it('refuses a reference to a step that is not in the sequence', () => {
    const message = reject([
      { id: 'invite', day: 0, kind: 'invite' },
      { id: 'dm', day: 2, kind: 'dm', condition: { on: 'accepted', ofStepId: 'invite-2' } }
    ]);
    expect(message).toContain("'invite-2'");
    expect(message).toContain('not in this sequence');
  });

  it('refuses a condition on a profile view, which is never accepted or replied to', () => {
    const message = reject([
      { id: 'view', day: 0, kind: 'profile_view' },
      { id: 'dm', day: 2, kind: 'dm', condition: { on: 'replied', ofStepId: 'view' } }
    ]);
    expect(message).toContain("Step 'dm'");
    expect(message).toContain('profile view');
  });

  it('refuses acceptance branches on anything but an invite', () => {
    const base: BranchableStep[] = [
      { id: 'invite', day: 0, kind: 'invite' },
      { id: 'first', day: 2, kind: 'dm' }
    ];
    for (const on of ['accepted', 'not_accepted'] as const) {
      const message = reject([...base, { id: 'second', day: 4, kind: 'dm', condition: { on, ofStepId: 'first' } }]);
      expect(message).toContain("Step 'second'");
      expect(message).toContain('only a connection request can be accepted');
    }
  });

  it('allows an acceptance branch on an invite and a reply branch on a message', () => {
    expect(
      conditionRejection([
        { id: 'invite', day: 0, kind: 'invite' },
        { id: 'dm', day: 2, kind: 'dm', condition: { on: 'accepted', ofStepId: 'invite' } },
        { id: 'nudge', day: 5, kind: 'dm', condition: { on: 'not_replied', ofStepId: 'dm' } },
        { id: 'inmail', day: 6, kind: 'inmail', condition: { on: 'not_accepted', ofStepId: 'invite' } }
      ])
    ).toBeNull();
  });

  it('allows an explicit always on a step whose outcome nobody can read, because it reads nothing', () => {
    expect(
      conditionRejection([
        { id: 'view', day: 0, kind: 'profile_view' },
        { id: 'invite', day: 1, kind: 'invite', condition: { on: 'always', ofStepId: 'view' } }
      ])
    ).toBeNull();
  });

  it('asserts acyclicity even though the earlier-only rule already guarantees it', () => {
    // A list the earlier-only rule could never produce, built by hand so the
    // assertion is tested rather than merely present.
    const cyclic: BranchableStep[] = [
      { id: 'a', day: 0, kind: 'dm', condition: { on: 'replied', ofStepId: 'b' } },
      { id: 'b', day: 1, kind: 'dm', condition: { on: 'replied', ofStepId: 'a' } }
    ];
    const message = cycleRejection(cyclic);
    expect(message).not.toBeNull();
    expect(message).toContain('loop of conditions');

    expect(cycleRejection(branchingSequence())).toBeNull();
  });
});

describe('evaluateBranches -- three-way, because "not yet" is the common case', () => {
  it('holds the accepted arm pending while the invite is out and unanswered, and lets the fallback ask', () => {
    const evaluation = evaluate({ actions: [row('invite', 'sent')], now: at(3) });
    expect(outcomeOf(evaluation, 'accepted-dm')).toBe('pending');
    expect(outcomeOf(evaluation, 'fallback-inmail')).toBe('due');
    expect(evaluation.decisions.find((entry) => entry.stepId === 'accepted-dm')?.reason).toContain('not yet');
  });

  it('runs the accepted arm and skips the fallback once the invite is accepted', () => {
    const evaluation = evaluate({ actions: [row('invite', 'accepted')], now: at(3) });
    expect(outcomeOf(evaluation, 'accepted-dm')).toBe('due');
    expect(outcomeOf(evaluation, 'fallback-inmail')).toBe('skipped');
  });

  it('skips the accepted arm outright when the invite was declined', () => {
    const evaluation = evaluate({ actions: [row('invite', 'declined')], now: at(3) });
    expect(outcomeOf(evaluation, 'accepted-dm')).toBe('skipped');
    expect(outcomeOf(evaluation, 'fallback-inmail')).toBe('due');
  });

  it('holds a negative branch pending until its own day, then answers with what is known', () => {
    const actions = [row('invite', 'sent')];
    expect(outcomeOf(evaluate({ actions, now: at(2) }), 'fallback-inmail')).toBe('pending');
    expect(outcomeOf(evaluate({ actions, now: at(3) }), 'fallback-inmail')).toBe('due');
  });

  it('treats a reply as an acceptance, the same reading acceptanceRate takes', () => {
    const evaluation = evaluate({ actions: [row('invite', 'replied')], now: at(3) });
    expect(outcomeOf(evaluation, 'accepted-dm')).toBe('due');
    expect(outcomeOf(evaluation, 'fallback-inmail')).toBe('skipped');
  });

  it('leaves everything conditional pending when the referenced step has no ledger row yet', () => {
    const evaluation = evaluate({ actions: [], now: at(9) });
    expect(evaluation.pending).toContain('accepted-dm');
    expect(evaluation.pending).toContain('fallback-inmail');
    expect(evaluation.skipped).toEqual([]);
  });

  it('cascades a skip: a branch off a step that will never run never runs either', () => {
    const evaluation = evaluate({
      steps: [
        { id: 'invite', day: 0, kind: 'invite' },
        { id: 'dm', day: 2, kind: 'dm', condition: { on: 'accepted', ofStepId: 'invite' } },
        { id: 'nudge', day: 5, kind: 'dm', condition: { on: 'not_replied', ofStepId: 'dm' } }
      ],
      actions: [row('invite', 'declined')],
      now: at(9)
    });
    expect(evaluation.skipped).toEqual(['dm', 'nudge']);
    expect(evaluation.due).toEqual(['invite']);
  });

  it('treats a skipped ledger row as "this will never produce an outcome"', () => {
    const evaluation = evaluate({ actions: [row('invite', 'skipped')], now: at(9) });
    expect(outcomeOf(evaluation, 'accepted-dm')).toBe('skipped');
    expect(outcomeOf(evaluation, 'fallback-inmail')).toBe('skipped');
  });

  it('resolves a step to its ledger row by step id when the ledger carries one', () => {
    const evaluation = evaluate({
      steps: [
        { id: 'invite', day: 0, kind: 'invite' },
        { id: 'first', day: 2, kind: 'dm' },
        { id: 'second', day: 5, kind: 'dm', condition: { on: 'replied', ofStepId: 'first' } }
      ],
      actions: [row('invite', 'accepted'), row('dm', 'replied', { stepId: 'first' }), row('dm', 'sent', { stepId: 'second' })],
      now: at(5)
    });
    expect(outcomeOf(evaluation, 'second')).toBe('due');
  });

  it('buckets every step exactly once', () => {
    const evaluation = evaluate({ actions: [row('invite', 'accepted')], now: at(7) });
    const total = evaluation.due.length + evaluation.skipped.length + evaluation.pending.length;
    expect(total).toBe(evaluation.decisions.length);
    expect(total).toBe(branchingSequence().length);
  });
});

describe('a branch gates whether a step runs, never when', () => {
  it('does NOT bring a step forward when its condition is already satisfied', () => {
    // Accepted on day 1. The arm is declared for day 3 and must not move.
    const actions = [row('invite', 'accepted')];
    for (const days of [1, 2, 2.9]) {
      const evaluation = evaluate({ actions, now: at(days) });
      expect(outcomeOf(evaluation, 'accepted-dm')).toBe('pending');
    }
    expect(outcomeOf(evaluate({ actions, now: at(3) }), 'accepted-dm')).toBe('due');
  });

  it('never reports a step due before its declared day, under any condition or answer', () => {
    const statuses: BranchActionRow['status'][] = ['planned', 'exported', 'sent', 'accepted', 'replied', 'declined', 'skipped'];
    const steps = branchingSequence();

    for (const inviteStatus of statuses) {
      for (const dmStatus of statuses) {
        for (const days of [0, 0.5, 1, 2, 3, 5, 7, 14]) {
          const now = at(days);
          const evaluation = evaluate({
            steps,
            actions: [row('invite', inviteStatus), row('dm', dmStatus, { stepId: 'accepted-dm' })],
            now
          });
          for (const decision of evaluation.decisions) {
            const step = steps.find((entry) => entry.id === decision.stepId);
            const declaredDay = START.getTime() + (step?.day ?? 0) * DAY_MS;
            // The floor holds for every decision, and a due step is at or past it.
            expect(Date.parse(decision.notBefore)).toBeGreaterThanOrEqual(declaredDay);
            if (decision.outcome === 'due') expect(now.getTime()).toBeGreaterThanOrEqual(Date.parse(decision.notBefore));
          }
        }
      }
    }
  });

  it('lets the pacing slot push a step later, and never lets it pull one earlier', () => {
    const steps: BranchableStep[] = [{ id: 'invite', day: 1, kind: 'invite' }];

    // Pacing put the slot two days past the declared day: the later one wins.
    const later = evaluate({ steps, actions: [row('invite', 'planned', { plannedFor: at(3).toISOString() })], now: at(2) });
    expect(later.decisions[0].notBefore).toBe(at(3).toISOString());
    expect(later.decisions[0].outcome).toBe('pending');

    // A slot BEFORE the declared day cannot lower the floor. Pacing owns time;
    // branching owns eligibility; they compose with max, never with min.
    const earlier = evaluate({ steps, actions: [row('invite', 'planned', { plannedFor: at(0).toISOString() })], now: at(0, 12) });
    expect(earlier.decisions[0].notBefore).toBe(at(1).toISOString());
    expect(earlier.decisions[0].outcome).toBe('pending');
  });
});

describe('deterministic and pure', () => {
  it('returns the same decision for the same inputs, without reading a clock or a random', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const randomSpy = vi.spyOn(Math, 'random');
    try {
      const args = { actions: [row('invite', 'accepted'), row('dm', 'sent')], now: at(7) };
      const first = evaluate(args);
      const second = evaluate(args);
      expect(second).toEqual(first);
      expect(nowSpy).not.toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });
});
