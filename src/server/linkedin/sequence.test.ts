import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES } from '../skills/voice.js';
import {
  INVITE_NOTE_MAX_CHARS,
  SUPPORTED_MERGE_FIELDS,
  SequenceValidationError,
  buildSequence,
  extractVariables,
  isSupportedMergeField,
  linkedinSequenceSkill,
  sequenceEvidence,
  sequenceFromSteps,
  validateSequenceSteps,
  type SequenceInput,
  type SequenceStepInput
} from './sequence.js';
import { DEFAULT_SEQUENCE_TEMPLATE_ID, SEQUENCE_TEMPLATES, getSequenceTemplate } from './templates.js';
import { briefFromProfile, briefIsComplete } from './brief.js';
import type { CompanyProfile } from '../skills/enrich.js';

/**
 * The sequence is pure -- no db, no clock, no network -- so these tests need
 * no Postgres. That is the point of `sideEffect: 'none'`.
 */

function input(overrides: Partial<SequenceInput> = {}): SequenceInput {
  return {
    icp: {
      role: 'Head of RevOps',
      segment: 'Series A B2B SaaS',
      pain: 'lead routing breaks every time the territory map changes',
      ...(overrides.icp ?? {})
    },
    offer: {
      name: 'Trevra',
      summary: 'a go-to-market runtime that keeps routing rules in one reviewable file',
      mechanism: 'routing lives in version control, so a territory change is a diff instead of a migration',
      proof: [
        { label: 'routing errors', value: 'down 71%' },
        { label: 'time to reroute', value: '4 days to 20 minutes' }
      ],
      url: 'https://trevra.dev',
      ...(overrides.offer ?? {})
    },
    targets: ['https://linkedin.com/in/one', 'https://linkedin.com/in/two'],
    tone: 'consultative',
    ...overrides
  } as SequenceInput;
}

describe('buildSequence output shape', () => {
  it('emits ordered steps with a day, a kind from the ledger taxonomy, a template and its variables', () => {
    const sequence = buildSequence(input());

    expect(sequence.steps.length).toBeGreaterThan(0);
    const days = sequence.steps.map((step) => step.day);
    expect([...days].sort((a, b) => a - b)).toEqual(days);

    for (const step of sequence.steps) {
      expect(Number.isInteger(step.day)).toBe(true);
      expect(step.day).toBeGreaterThanOrEqual(0);
      expect(['invite', 'dm', 'inmail', 'profile_view', 'comment', 'follow']).toContain(step.kind);
      expect(typeof step.template).toBe('string');
      expect(Array.isArray(step.variables)).toBe(true);
      // Every declared variable is actually in the template, and vice versa.
      expect(step.variables).toEqual(extractVariables(step.template));
    }

    expect(Array.isArray(sequence.antiSlopNotes)).toBe(true);
  });

  it('opens with a profile view that carries no copy, then the invite', () => {
    const steps = buildSequence(input()).steps;
    expect(steps[0].kind).toBe('profile_view');
    expect(steps[0].template).toBe('');
    expect(steps[0].variables).toEqual([]);
    expect(steps[0].critique).toBeNull();
    expect(steps[1].kind).toBe('invite');
  });

  it('personalises through merge fields rather than by baking a target into the copy', () => {
    const sequence = buildSequence(input());
    const invite = sequence.steps.find((step) => step.kind === 'invite');
    expect(invite?.variables).toContain('firstName');
    for (const step of sequence.steps) {
      for (const target of ['https://linkedin.com/in/one', 'https://linkedin.com/in/two']) {
        expect(step.template).not.toContain(target);
      }
    }
  });

  it('adds the InMail step only when asked, and never by default', () => {
    expect(buildSequence(input()).steps.some((step) => step.kind === 'inmail')).toBe(false);
    const withInMail = buildSequence(input({ includeInMail: true }));
    expect(withInMail.steps.some((step) => step.kind === 'inmail')).toBe(true);
  });

  it('is deterministic: the same input produces byte-identical copy', () => {
    // The approval hash depends on this. See the module comment.
    expect(JSON.stringify(buildSequence(input()))).toBe(JSON.stringify(buildSequence(input())));
  });

  it('validates through the skill manifest', async () => {
    expect(linkedinSequenceSkill.manifest.id).toBe('gtm.linkedin-sequence');
    expect(linkedinSequenceSkill.manifest.sideEffect).toBe('none');

    const parsed = linkedinSequenceSkill.manifest.inputSchema.parse({
      icp: input().icp,
      offer: input().offer,
      targets: input().targets
    });
    const output = await linkedinSequenceSkill.run(parsed, {
      db: undefined as never,
      workspaceId: 'ws_demo',
      now: () => new Date('2026-08-04T09:00:00.000Z')
    });
    expect(() => linkedinSequenceSkill.manifest.outputSchema.parse(output)).not.toThrow();
  });
});

describe('anti-slop critique runs on every template', () => {
  it('populates a critique for every step that has copy', () => {
    const sequence = buildSequence(input());
    for (const step of sequence.steps) {
      if (step.template.trim().length === 0) expect(step.critique).toBeNull();
      else {
        expect(step.critique).not.toBeNull();
        expect(typeof step.critique?.wordCount).toBe('number');
        expect(step.critique?.wordCount).toBeGreaterThan(0);
      }
    }
  });

  it("reports a banned phrase the operator put in the offer instead of shipping it", () => {
    // The critic is the same module gtm.draft-reply uses, so a tell that fails
    // there must fail here. 'game-changer' is in BANNED_PHRASES.
    expect(BANNED_PHRASES).toContain('game-changer');
    const sequence = buildSequence(
      input({
        offer: {
          name: 'Trevra',
          summary: 'a game-changer for revenue teams',
          mechanism: 'it is a game-changer',
          proof: [],
          url: 'https://trevra.dev'
        }
      })
    );

    expect(sequence.antiSlopPassed).toBe(false);
    expect(sequence.antiSlopNotes.length).toBeGreaterThan(0);
    expect(sequence.antiSlopNotes.join('\n')).toContain('banned-phrase');
    // Reported, never swallowed: the copy is still returned so a human can fix it.
    expect(sequence.steps.some((step) => step.template.includes('game-changer'))).toBe(true);
  });

  it('attributes each note to the step it came from', () => {
    const sequence = buildSequence(
      input({
        offer: {
          name: 'Trevra',
          summary: 'we wanted to reach out about routing',
          mechanism: 'we wanted to reach out about routing',
          proof: [],
          url: 'https://trevra.dev'
        }
      })
    );
    const ids = sequence.steps.map((step) => step.id);
    for (const note of sequence.antiSlopNotes) {
      expect(ids.some((stepId) => note.startsWith(`${stepId} (day `))).toBe(true);
    }
  });

  it("flags an invite note over LinkedIn's 300-character connection-note ceiling", () => {
    const sequence = buildSequence(
      input({
        icp: {
          role: 'Head of RevOps',
          segment: 'Series A B2B SaaS',
          pain: 'x'.repeat(280)
        }
      })
    );
    const invite = sequence.steps.find((step) => step.kind === 'invite');
    expect(invite!.template.length).toBeGreaterThan(INVITE_NOTE_MAX_CHARS);
    expect(sequence.antiSlopNotes.join('\n')).toContain(String(INVITE_NOTE_MAX_CHARS));
  });
});

describe('sequenceEvidence', () => {
  it('carries every operator-supplied fact, so the substitution test has something to find', () => {
    const evidence = sequenceEvidence(input());
    expect(evidence).toContain('Series A B2B SaaS');
    expect(evidence).toContain('routing errors');
    expect(evidence.every((entry) => entry.trim().length > 0)).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * A sequence is data, and data has rules.
 *
 * These were implicit in `buildSequence`'s hardcoded skeleton. The moment the
 * step list became editable they stopped being enforced by construction, which
 * is exactly when they have to become assertions.
 * ------------------------------------------------------------------------ */

function steps(...overrides: SequenceStepInput[]): SequenceStepInput[] {
  return overrides;
}

function refusal(list: SequenceStepInput[]): string {
  try {
    validateSequenceSteps(list);
  } catch (error) {
    expect(error).toBeInstanceOf(SequenceValidationError);
    return (error as Error).message;
  }
  throw new Error('expected the sequence to be refused, and it was not');
}

describe('validateSequenceSteps', () => {
  const ok = steps(
    { id: 'view', day: 0, kind: 'profile_view', template: '' },
    { id: 'invite', day: 1, kind: 'invite', template: 'Hi {{firstName}}, connecting about {{company}}.' },
    { id: 'note', day: 4, kind: 'dm', template: 'Thanks for connecting, {{firstName}}.' }
  );

  it('accepts a well-formed list', () => {
    expect(() => validateSequenceSteps(ok)).not.toThrow();
  });

  it('refuses an empty sequence', () => {
    expect(refusal([])).toMatch(/at least one step/);
  });

  it('names the step whose day runs backwards', () => {
    const message = refusal(steps({ id: 'first', day: 5, kind: 'dm', template: 'a' }, { id: 'second', day: 2, kind: 'dm', template: 'b' }));
    expect(message).toContain("'second'");
    expect(message).toContain('day 2');
  });

  it('refuses a negative day', () => {
    expect(refusal(steps({ id: 'early', day: -1, kind: 'dm', template: 'a' }))).toContain("'early'");
  });

  it('refuses a repeated step id, because a note is attributed by id', () => {
    const message = refusal(steps({ id: 'dup', day: 0, kind: 'dm', template: 'a' }, { id: 'dup', day: 1, kind: 'dm', template: 'b' }));
    expect(message).toContain("'dup'");
  });

  it('refuses copy on a profile view, which carries no message', () => {
    expect(refusal(steps({ id: 'view', day: 0, kind: 'profile_view', template: 'nobody will ever read this' }))).toContain("'view'");
  });

  it('refuses an empty dm and an empty inmail, which are nothing but their message', () => {
    expect(refusal(steps({ id: 'silent', day: 0, kind: 'dm', template: '   ' }))).toContain("'silent'");
    expect(refusal(steps({ id: 'quiet', day: 0, kind: 'inmail', template: '' }))).toContain("'quiet'");
  });

  it('refuses a second invite, because a person can only be invited once', () => {
    const message = refusal(
      steps({ id: 'invite', day: 0, kind: 'invite', template: 'one' }, { id: 'invite-again', day: 3, kind: 'invite', template: 'two' })
    );
    expect(message).toContain("'invite-again'");
  });

  it("refuses an invite note past LinkedIn's 300-character ceiling, rather than letting the platform cut it", () => {
    const message = refusal(steps({ id: 'invite', day: 0, kind: 'invite', template: 'x'.repeat(INVITE_NOTE_MAX_CHARS + 1) }));
    expect(message).toContain("'invite'");
    expect(message).toContain(String(INVITE_NOTE_MAX_CHARS));
  });
});

describe('merge fields', () => {
  it('publishes a closed, documented set', () => {
    expect([...SUPPORTED_MERGE_FIELDS]).toEqual(['firstName', 'lastName', 'company', 'jobTitle']);
    for (const field of SUPPORTED_MERGE_FIELDS) expect(isSupportedMergeField(field)).toBe(true);
    expect(isSupportedMergeField('fistName')).toBe(false);
  });

  it('refuses an unknown merge field by name, instead of sending {{fistName}} to a human', () => {
    const message = refusal(steps({ id: 'open', day: 0, kind: 'dm', template: 'Hi {{fistName}}, about {{company}}.' }));
    expect(message).toContain("'open'");
    expect(message).toContain('{{fistName}}');
    expect(message).toContain('{{firstName}}');
  });

  it('accepts every supported field in one template', () => {
    const template = '{{firstName}} {{lastName}} at {{company}}, {{jobTitle}}.';
    expect(() => validateSequenceSteps(steps({ id: 'all', day: 0, kind: 'dm', template }))).not.toThrow();
    expect(extractVariables(template)).toEqual(['firstName', 'lastName', 'company', 'jobTitle']);
  });
});

describe('sequenceFromSteps', () => {
  it('critiques hand-written copy exactly as it critiques drafted copy', () => {
    const sequence = sequenceFromSteps(
      steps({ id: 'open', day: 0, kind: 'dm', template: 'Hi {{firstName}}, I wanted to reach out about {{company}}.' })
    );
    expect(sequence.antiSlopPassed).toBe(false);
    expect(sequence.antiSlopNotes.join('\n')).toContain('banned-phrase');
    // Reported, never swallowed: the copy comes back so a human can fix it.
    expect(sequence.steps[0].template).toContain('wanted to reach out');
  });

  it('carries the variables it found and leaves a copy-less step without a verdict', () => {
    const sequence = sequenceFromSteps(
      steps(
        { id: 'view', day: 0, kind: 'profile_view', template: '' },
        { id: 'invite', day: 2, kind: 'invite', intent: 'Say why.', template: 'Hi {{firstName}} at {{company}}.' }
      )
    );
    expect(sequence.steps[0].critique).toBeNull();
    expect(sequence.steps[0].variables).toEqual([]);
    expect(sequence.steps[1].variables).toEqual(['firstName', 'company']);
    expect(sequence.steps[1].intent).toBe('Say why.');
  });

  it('is deterministic, because an approval hash depends on it', () => {
    const list = steps({ id: 'open', day: 0, kind: 'dm', template: 'Hi {{firstName}}.' });
    expect(JSON.stringify(sequenceFromSteps(list))).toBe(JSON.stringify(sequenceFromSteps(list)));
  });

  it('refuses through the skill manifest too, so the HTTP layer cannot route around it', async () => {
    const parsed = linkedinSequenceSkill.manifest.inputSchema.parse({
      steps: [{ id: 'open', day: 0, kind: 'dm', template: 'Hi {{nope}}.' }],
      targets: []
    });
    await expect(
      linkedinSequenceSkill.run(parsed, { db: undefined as never, workspaceId: 'ws_demo', now: () => new Date() })
    ).rejects.toBeInstanceOf(SequenceValidationError);
  });

  it('drafts from a brief when no steps are supplied, and critiques steps when they are', async () => {
    const ctx = { db: undefined as never, workspaceId: 'ws_demo', now: () => new Date('2026-08-04T09:00:00.000Z') };
    const drafted = await linkedinSequenceSkill.run(
      linkedinSequenceSkill.manifest.inputSchema.parse({ icp: input().icp, offer: input().offer, targets: input().targets }),
      ctx
    );
    expect(drafted.steps.map((step) => step.id)).toEqual(['view', 'invite', 'message-1', 'message-2', 'close']);

    const assembled = await linkedinSequenceSkill.run(
      linkedinSequenceSkill.manifest.inputSchema.parse({
        steps: [{ id: 'only', day: 0, kind: 'dm', template: 'Hi {{firstName}}.' }],
        icp: input().icp,
        offer: input().offer,
        targets: input().targets
      }),
      ctx
    );
    // Steps win over the brief: an operator who edited copy did not ask for it
    // to be regenerated.
    expect(assembled.steps.map((step) => step.id)).toEqual(['only']);
  });
});

describe('the template library', () => {
  it('ships between three and five ready sequences, each with a name and a reason to pick it', () => {
    expect(SEQUENCE_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(SEQUENCE_TEMPLATES.length).toBeLessThanOrEqual(5);
    const ids = SEQUENCE_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of SEQUENCE_TEMPLATES) {
      expect(template.name.trim().length).toBeGreaterThan(0);
      expect(template.description.trim().length).toBeGreaterThan(0);
    }
    expect(getSequenceTemplate(DEFAULT_SEQUENCE_TEMPLATE_ID)).toBeDefined();
    expect(getSequenceTemplate('no-such-template')).toBeUndefined();
  });

  it('holds every rule it would be validated against on write', () => {
    for (const template of SEQUENCE_TEMPLATES) {
      expect(() => validateSequenceSteps(template.steps), template.id).not.toThrow();
      expect(() => sequenceFromSteps(template.steps), template.id).not.toThrow();
    }
  });

  it('reproduces the default five-touch shape, so the library and the drafter agree', () => {
    const drafted = buildSequence(input()).steps.map((step) => ({ id: step.id, day: step.day, kind: step.kind }));
    const template = getSequenceTemplate(DEFAULT_SEQUENCE_TEMPLATE_ID)!.steps.map((step) => ({
      id: step.id,
      day: step.day,
      kind: step.kind
    }));
    expect(template).toEqual(drafted);
  });
});

/* ---------------------------------------------------------------------------
 * Drafting a brief from a domain.
 *
 * The whole value of this path is what it REFUSES to fill in. A guessed
 * mechanism reads exactly like a real one, and a fabricated proof number is
 * the single worst thing this product could put in front of a stranger.
 * ------------------------------------------------------------------------ */

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    domain: 'acme.test',
    name: 'Acme',
    legalName: null,
    description: 'Warehouse software for independent retailers',
    url: 'https://acme.test',
    logoUrl: null,
    emails: [],
    telephone: null,
    sameAs: [],
    address: null,
    country: null,
    platform: 'shopify',
    tech: [],
    catalogSize: null,
    catalogCapped: false,
    pages: [],
    degraded: [],
    generatedAt: '2026-08-04T09:00:00.000Z',
    evidence: [],
    ...overrides
  };
}

describe('briefFromProfile', () => {
  it('fills what the site published and leaves the rest empty and named', () => {
    const { brief, degraded } = briefFromProfile(profile());
    expect(brief.offer.name).toBe('Acme');
    expect(brief.offer.summary).toBe('Warehouse software for independent retailers');
    expect(brief.offer.url).toBe('https://acme.test');

    expect(brief.offer.mechanism).toBe('');
    expect(brief.icp).toEqual({ role: '', segment: '', pain: '' });
    expect(degraded).toEqual(expect.arrayContaining(['offer.mechanism', 'icp.role', 'icp.segment', 'icp.pain']));
    expect(briefIsComplete(brief)).toBe(false);
  });

  it('never invents a proof number, and says so when it found none', () => {
    const { brief, degraded } = briefFromProfile(profile());
    expect(brief.offer.proof).toEqual([]);
    expect(degraded).toContain('offer.proof');
  });

  it('reports a number it actually counted, and marks a capped count as a floor', () => {
    const counted = briefFromProfile(profile({ catalogSize: 42 }));
    expect(counted.brief.offer.proof).toEqual([{ label: 'Products listed', value: '42' }]);
    expect(counted.degraded).not.toContain('offer.proof');

    const capped = briefFromProfile(profile({ catalogSize: 250, catalogCapped: true }));
    expect(capped.brief.offer.proof).toEqual([{ label: 'Products listed', value: '250+' }]);
  });

  it('passes the probe\'s own gaps through rather than presenting a partial read as a whole one', () => {
    const { brief, degraded } = briefFromProfile(profile({ name: null, description: null, url: null, degraded: ['homepage'] }));
    expect(brief.offer.name).toBe('');
    expect(brief.offer.summary).toBe('');
    // A URL is the one thing the caller supplied, so it is never blank.
    expect(brief.offer.url).toBe('https://acme.test');
    expect(degraded).toEqual(expect.arrayContaining(['offer.name', 'offer.summary', 'enrichment:homepage']));
  });
});
