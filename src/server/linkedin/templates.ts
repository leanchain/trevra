import type { SequenceStepInput } from './sequence.js';

/**
 * Ready-made sequences: the shapes, not the copy.
 *
 * WHY THIS FILE IS DATA AND NOT CODE. `buildSequence` used to be the only
 * sequence Trevra could produce -- profile view, invite, three messages, on
 * days a function literal decided. That is a fine default and a terrible
 * ceiling: an operator who wants three touches instead of five, or an InMail
 * first, had nowhere to say so. A template is the same list of steps an editor
 * produces, written down, so "start from a template" and "assemble it yourself"
 * are the same code path with different starting values.
 *
 * THE COPY HERE IS DELIBERATELY GENERIC, AND THE CRITIC WILL SAY SO. Every
 * template goes through `sequenceFromSteps`, which runs the same anti-slop
 * critic as every other piece of Trevra copy, and a template that names
 * nothing specific fails the substitution test by construction. That is the
 * intended experience: the operator is handed a shape plus a list of the
 * sentences that carry no information yet. Writing plausible-sounding fake
 * specifics here instead would pass the critic and get SENT.
 *
 * Every template holds every rule in `validateSequenceSteps` -- days
 * non-decreasing, one invite, no copy on a profile view, invite note inside
 * LinkedIn's 300 characters, only supported merge fields. `templates.test.ts`
 * asserts that rather than trusting this paragraph.
 */

export interface SequenceTemplate {
  /** Stable slug. Referenced by `POST /api/linkedin/campaigns/draft`. */
  id: string;
  name: string;
  /** One line on when to reach for this one, not on what it contains. */
  description: string;
  steps: SequenceStepInput[];
}

/**
 * The shape `buildSequence` drafts. Named so a client can offer "the default"
 * without hardcoding a slug that might change.
 */
export const DEFAULT_SEQUENCE_TEMPLATE_ID = 'five-touch';

const TEMPLATE_SOURCES: readonly SequenceTemplate[] = [
  {
    id: 'three-touch',
    name: 'Three touches',
    description: 'Use on a warm or referred list, where five touches reads as pressure rather than persistence.',
    steps: [
      {
        id: 'invite',
        day: 0,
        kind: 'invite',
        intent: 'Connection request with a note that says why you are writing, not who you are.',
        template: '{{firstName}} -- connecting because of what {{company}} is building. No pitch attached.'
      },
      {
        id: 'open',
        day: 3,
        kind: 'dm',
        intent: 'First message after acceptance. One observation, one sentence on what you do about it.',
        template:
          'Thanks for connecting, {{firstName}}. I work on the problem {{company}} hits when the manual version of this stops scaling.'
      },
      {
        id: 'close',
        day: 10,
        kind: 'dm',
        intent: 'Close the loop with no ask, so the thread ends cleanly either way.',
        template: '{{firstName}}, closing the loop. If it lands on your desk at {{company}} later, you know where to find me.'
      }
    ]
  },
  {
    id: DEFAULT_SEQUENCE_TEMPLATE_ID,
    name: 'Five touches',
    description:
      'The default cold shape: a view, a bare invite with no note, and three messages across a fortnight. Start here if you have no reason not to.',
    steps: [
      {
        id: 'view',
        day: 0,
        kind: 'profile_view',
        intent: 'Show up in their "who viewed your profile" before the invite lands. No copy.',
        template: ''
      },
      /*
       * NO NOTE, AND THAT IS THE DEFAULT.
       *
       * A connection-request note is the most-read and least-earned sentence
       * in the sequence: it goes to somebody who has agreed to nothing, and a
       * template note is by construction a sentence about nobody. The line
       * that used to sit here ("most {{jobTitle}}s I speak to at {{company}}'s
       * stage still carry this one by hand") is exactly the shape people have
       * learned to read as automated, so it cost acceptances rather than
       * buying them. A bare invite asks for the connection and nothing else,
       * and the copy starts on day 3 when there is a thread to put it in.
       *
       * A note is still one checkbox away -- `inviteNote: 'drafted'` on the
       * drafter, or type one into this step in the builder -- and the three
       * other templates here ship with one.
       */
      {
        id: 'invite',
        day: 1,
        kind: 'invite',
        intent: 'Connection request with no note. Nothing is claimed before they have accepted anything.',
        template: ''
      },
      {
        id: 'message-1',
        day: 3,
        kind: 'dm',
        intent: 'First message after acceptance: the mechanism, in one sentence.',
        template:
          "Thanks for connecting, {{firstName}}. What I do: take the manual version of this off {{company}}'s plate, without a migration to get there."
      },
      {
        id: 'message-2',
        day: 7,
        kind: 'dm',
        intent: 'The proof step. One number, one ask, nothing else.',
        template: '{{firstName}} -- the number that travels: teams this size cut it from days to minutes. Worth a look for {{company}}.'
      },
      {
        id: 'close',
        day: 14,
        kind: 'dm',
        intent: 'Close the loop. No ask, so a non-answer stays a clean one.',
        template: "{{firstName}}, closing the loop on this one. I will leave it here; the door stays open at {{company}}'s end."
      }
    ]
  },
  {
    id: 'inmail-led',
    name: 'InMail first',
    description:
      'For a Sales Navigator seat writing to people who rarely accept cold invites. Spends one of the 50 monthly InMail credits per target.',
    steps: [
      {
        id: 'inmail',
        day: 0,
        kind: 'inmail',
        intent: 'Open in the inbox rather than the invite queue. This is the credit-spending step.',
        template:
          '{{firstName}} -- writing directly because this sits squarely in what a {{jobTitle}} at {{company}} owns, and the manual version of it costs more than it looks.'
      },
      {
        id: 'view',
        day: 2,
        kind: 'profile_view',
        intent: 'A cheap second signal between the InMail and the invite. No copy.',
        template: ''
      },
      {
        id: 'invite',
        day: 3,
        kind: 'invite',
        intent: 'The fallback for an InMail that went unread: a connection request referring back to it.',
        template:
          '{{firstName}} -- following the note I sent. Connecting so this is easier to pick up if the timing at {{company}} improves.'
      },
      {
        id: 'follow-up',
        day: 8,
        kind: 'dm',
        intent: 'One message after acceptance, repeating the single point rather than adding a second.',
        template:
          'Thanks for connecting, {{firstName}}. Same point as the InMail: the manual version of this at {{company}} is the expensive part.'
      }
    ]
  },
  {
    id: 'slow-burn',
    name: 'Slow burn, no early ask',
    description: 'For senior titles, where the first ask is the thing that gets you ignored. Three weeks, and nothing is asked until the end.',
    steps: [
      {
        id: 'view',
        day: 0,
        kind: 'profile_view',
        intent: 'Passive first touch. No copy.',
        template: ''
      },
      {
        id: 'invite',
        day: 2,
        kind: 'invite',
        intent: 'Connect before there is anything to sell, and say so.',
        template:
          '{{firstName}} -- no pitch. {{company}} came up while I was looking at how teams handle this, and I would rather be connected before I have anything to say.'
      },
      {
        id: 'context',
        day: 6,
        kind: 'dm',
        intent: 'Context, not an ask. Establishes the problem is real before naming a solution.',
        template:
          "Thanks for connecting, {{firstName}}. Context rather than an ask: most teams at {{company}}'s size run this by hand until it breaks once."
      },
      {
        id: 'proof',
        day: 13,
        kind: 'dm',
        intent: 'The one number. Still no ask.',
        template:
          '{{firstName}} -- one number, since it is the only part that travels: the manual version of this costs days a month, and it does not have to.'
      },
      {
        id: 'close',
        day: 21,
        kind: 'dm',
        intent: 'Stop, explicitly. A sequence that trails off is a sequence nobody closed.',
        template: '{{firstName}}, I will stop here. Nothing needed from {{company}}; the offer stands whenever it is useful.'
      }
    ]
  }
];

/**
 * Step ids, made unique -- ONCE, HERE, ON THE WAY OUT.
 *
 * `validateSequenceSteps` refuses a repeated id, so a template carrying one
 * would be a library entry that cannot be used. Clients used to defend against
 * that by re-identifying steps after they read them, which meant the id an
 * operator edited was not the id the library published. The guarantee belongs
 * on the read: whatever this module serves has unique, non-empty step ids, and
 * a reader may take them at face value.
 *
 * Deterministic and position-derived -- no randomness -- because the same
 * template read twice has to produce the same ids, or two operators assembling
 * the same sequence would post different payloads and hash differently.
 */
function withUniqueStepIds(template: SequenceTemplate): SequenceTemplate {
  const seen = new Set<string>();
  return {
    ...template,
    steps: template.steps.map((step, index) => {
      const base = step.id.trim() || `step-${index + 1}`;
      let id = base;
      for (let suffix = 2; seen.has(id); suffix += 1) id = `${base}-${suffix}`;
      seen.add(id);
      return id === step.id ? step : { ...step, id };
    })
  };
}

/** The library as every reader sees it. `TEMPLATE_SOURCES` above is the copy; this is the contract. */
export const SEQUENCE_TEMPLATES: readonly SequenceTemplate[] = TEMPLATE_SOURCES.map(withUniqueStepIds);

export function getSequenceTemplate(templateId: string): SequenceTemplate | undefined {
  return SEQUENCE_TEMPLATES.find((template) => template.id === templateId);
}

/** The default, resolved. Throws only if somebody deletes it from the list above. */
export function defaultSequenceTemplate(): SequenceTemplate {
  const template = getSequenceTemplate(DEFAULT_SEQUENCE_TEMPLATE_ID);
  if (!template) throw new Error(`Sequence template '${DEFAULT_SEQUENCE_TEMPLATE_ID}' is missing from SEQUENCE_TEMPLATES`);
  return template;
}
