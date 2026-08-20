import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Eye,
  GripVertical,
  LayoutTemplate,
  LoaderCircle,
  MessageSquare,
  PenLine,
  Plus,
  Save,
  Trash2,
  UserCheck,
  UserMinus,
  UserPlus
} from 'lucide-react';
import {
  createLinkedInManagerWorkflow,
  deleteLinkedInManagerWorkflow,
  getLinkedInManagerWorkflows,
  updateLinkedInManagerWorkflow
} from './api';
import type { LinkedInWorkflow, WorkflowDelay, WorkflowStep } from '../server/linkedin/workflows';
import { errorMessage } from './LinkedInSafety';

/* ---------------------------------------------------------------------------
 * The reusable workflow builder.
 *
 * Every rule enforced here is a rule `workflowStepsSchema` in
 * src/server/linkedin/workflows.ts already enforces. It is mirrored rather than
 * imported because that module pulls in zod, node:crypto and the db handle --
 * none of which belong in the browser bundle. When the schema changes, this
 * file changes with it: the point of the mirror is that an operator is told
 * what is wrong ON THE STEP, before a save, instead of reading one 400 that
 * names an array index.
 * ------------------------------------------------------------------------ */

type Action = WorkflowStep['action'];
type MessageStep = Extract<WorkflowStep, { action: 'message' }>;
type Variant = MessageStep['config']['variants'][number];

/**
 * The closed set the server accepts -- MANAGER_VARIABLES in workflows.ts.
 *
 * EMAIL, PHONE AND COUNTRY ARE HERE BECAUSE THE DATA ALREADY IS: the CSV
 * importer has always parsed all three onto the contact, and until the server
 * widened this set not one of them could reach a message. A builder still
 * mirroring three names would now refuse, on the step card, templates the save
 * route accepts -- the mirror lying in the operator's favour is no better than
 * it lying against them.
 */
const MANAGER_VARIABLES = [
  'first_name',
  'last_name',
  'company',
  'email',
  'phone',
  'country'
] as const;
type ManagerVariable = (typeof MANAGER_VARIABLES)[number];

/**
 * Mirrors MANAGER_VARIABLE_ALIASES: camelCase spellings that mean the same field.
 *
 * The older sequence path documents `{{firstName}}` and `{{lastName}}`, and
 * authors copy lines between the two screens, so both spellings resolve. They
 * are ALIASES rather than members: the picker below offers one canonical name
 * per field, and the alias exists so the other spelling is understood, not so
 * the set has two entries for one thing.
 */
const MANAGER_VARIABLE_ALIASES: Readonly<Record<string, ManagerVariable>> = {
  firstName: 'first_name',
  lastName: 'last_name'
};

/** Mirrors `resolveManagerVariable`: the canonical field, in either spelling, or null. */
function resolveManagerVariable(name: string): ManagerVariable | null {
  if ((MANAGER_VARIABLES as readonly string[]).includes(name)) return name as ManagerVariable;
  return MANAGER_VARIABLE_ALIASES[name] ?? null;
}

/** LinkedIn refuses a longer invitation note; the schema caps it at the same number. */
const INVITE_NOTE_MAX = 300;
/** `body`/`suggestedTemplate` ceiling in the schema. */
const BODY_MAX = 8000;
/** `delayBefore.amount` ceiling in the schema: 90 days of hours. */
const DELAY_MAX = 2160;
const MAX_STEPS = 50;

/**
 * Mirrors MESSAGE_VARIANT_MAX in workflows.ts: message versions per A/B step.
 *
 * The number is the READ, not the storage. Results hold every arm to 20
 * messages before naming a leader, so four arms is already 80 sends of one
 * step before the comparison means anything -- and that is said on the card,
 * next to the button that adds the fourth, rather than discovered later on a
 * results panel that keeps answering "not enough data yet".
 */
const VARIANT_MAX = 4;

/** The ids the builder mints, in order. One letter each, so a card header stays short. */
const VARIANT_IDS = ['a', 'b', 'c', 'd'] as const;

/**
 * Split-bar fills for the ids styles.css does not already colour.
 *
 * `a` takes the sheet's default green fill and `b` its blue; the third and
 * fourth arms exist now and need to be told apart at a glance, so they carry
 * the two remaining theme colours inline. Keyed by ID rather than by position
 * on purpose: removing the middle arm must not repaint the survivors.
 */
const VARIANT_FILL: Readonly<Record<string, string>> = { c: 'var(--amber)', d: 'var(--muted)' };

/**
 * Integer weights, summing to exactly 100, keeping the proportions handed in.
 *
 * ADDING OR REMOVING AN ARM HAS TO LEAVE A SPLIT THAT STILL READS AS ONE. Two
 * arms at 50/50 plus a third left the card claiming 50%, 50% and 50% of leads;
 * the server would have normalised by the true total and sent 33/33/33, so the
 * builder was describing a split nobody was running. Every arm keeps a floor
 * of 1 -- the schema's own minimum -- and the remainder is handed out largest
 * fraction first, which is deterministic and never needs a second pass.
 */
export function renormaliseWeights(weights: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];
  if (count > 100) return weights.map(() => 1);
  const safe = weights.map((weight) => Math.max(1, Math.trunc(weight) || 1));
  const total = safe.reduce((sum, weight) => sum + weight, 0);
  const pool = 100 - count;
  const exact = safe.map((weight) => (weight / total) * pool);
  const out = exact.map((share) => 1 + Math.floor(share));
  let slack = 100 - out.reduce((sum, share) => sum + share, 0);
  const byRemainder = exact
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let at = 0; slack > 0; at += 1, slack -= 1) out[byRemainder[at].index] += 1;
  return out;
}

/** The next unused letter, or null when the step is already at {@link VARIANT_MAX}. */
export function nextVariantId(taken: readonly string[]): string | null {
  const used = new Set(taken.map((variantId) => variantId.trim().toLowerCase()));
  return VARIANT_IDS.find((candidate) => !used.has(candidate)) ?? null;
}

/** Who the previews are rendered for, so merge fields read as sentences and not as tokens. */
const SAMPLE_LEAD: Record<ManagerVariable, string> = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  company: 'Analytical Engines',
  email: 'ada@analyticalengines.example',
  phone: '+44 20 7946 0958',
  country: 'United Kingdom'
};

const MERGE_TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

interface ActionMeta {
  label: string;
  Icon: typeof Eye;
  /** Reuses the chip colours the rendered sequence already uses for the same idea. */
  chip: string;
  /** What the step does, said on the card when it carries no copy to explain itself. */
  blurb: string;
}

const ACTION_META: Record<Action, ActionMeta> = {
  profile_view: {
    label: 'Profile view',
    Icon: Eye,
    chip: 'li-kind-profile_view',
    blurb: 'Opens the profile and nothing else. It warms the lead before whatever comes next.'
  },
  connection_request: {
    label: 'Connection request',
    Icon: UserPlus,
    chip: 'li-kind-invite',
    blurb: 'Sends the invitation. An empty note sends the request without one.'
  },
  message: {
    label: 'Message (A/B)',
    Icon: MessageSquare,
    chip: 'li-kind-dm',
    blurb: 'Sends one of the variants below. The same lead always lands on the same variant.'
  },
  manual_message: {
    label: 'Manual message checkpoint',
    Icon: PenLine,
    chip: 'li-kind-inmail',
    blurb: 'Pauses the lead here for a human to write the message. Nothing is sent automatically.'
  },
  follow: {
    label: 'Follow',
    Icon: UserCheck,
    chip: 'li-kind-profile_view',
    blurb: 'Follows the profile. It carries no message.'
  },
  withdraw_pending: {
    label: 'Withdraw pending invite',
    Icon: UserMinus,
    chip: 'li-kind-profile_view',
    blurb:
      'Cancels an invitation that was never accepted, so the pending backlog stays under its ceiling.'
  }
};

const ACTION_ORDER: readonly Action[] = [
  'profile_view',
  'connection_request',
  'message',
  'manual_message',
  'follow',
  'withdraw_pending'
];

/* ---------------------------------------------------------------------------
 * Pure helpers.
 * ------------------------------------------------------------------------ */

function hoursOf(delay: WorkflowDelay): number {
  return delay.unit === 'days' ? delay.amount * 24 : delay.amount;
}

/** Cumulative offset from the moment the campaign starts the lead, as an operator reads it. */
function whenLabel(totalHours: number): string {
  if (totalHours <= 0) return 'At campaign start';
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (hours === 0) return `Day ${days}`;
  return `Day ${days}, +${hours}h`;
}

/** The delay on the step itself. Zero is a word, not a number: it reads as a decision. */
function waitLabel(delay: WorkflowDelay): string {
  if (delay.amount <= 0) return 'immediately';
  return `${delay.amount} ${delay.amount === 1 ? delay.unit.replace(/s$/, '') : delay.unit}`;
}

/** Mirrors `templatesOf` in workflows.ts -- the strings the server scans for variables. */
function templatesOf(step: WorkflowStep): string[] {
  if (step.action === 'connection_request') return step.config.message ? [step.config.message] : [];
  if (step.action === 'message') return step.config.variants.map((variant) => variant.body);
  if (step.action === 'manual_message')
    return step.config.suggestedTemplate ? [step.config.suggestedTemplate] : [];
  return [];
}

/**
 * Mirrors `unsupportedVariables` in workflows.ts, character for character in
 * the pattern.
 *
 * Widening the accepted set does not soften the rule: a name that is neither a
 * canonical field nor an alias is still reported here, and the save route still
 * rejects it. The only change is that `{{email}}` and `{{firstName}}` stopped
 * being in that category.
 */
function unsupportedVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(MERGE_TOKEN)) {
    if (resolveManagerVariable(match[1]) === null) found.add(match[1]);
  }
  return [...found];
}

/**
 * Mirrors `renderWorkflowTemplate`.
 *
 * EMPTY-SAFE, and the distinction matters for the three new fields: a lead with
 * no phone renders a blank, never the word "null" and never the literal
 * `{{phone}}`. Only an UNKNOWN token is left standing, on purpose, so a name
 * that somehow got past the refusal above is VISIBLE in the preview rather than
 * silently swallowed. The sample lead below carries all six, so the preview
 * shows the sentence an operator is actually writing; a real lead missing one
 * takes the blank path on the server, which reads as the same sentence with a
 * gap rather than as a broken template.
 */
function renderSample(template: string): string {
  return template.replace(MERGE_TOKEN, (whole, name: string) => {
    const canonical = resolveManagerVariable(name);
    return canonical === null ? whole : SAMPLE_LEAD[canonical];
  });
}

/**
 * Everything wrong with one step, in sentences.
 *
 * The withdraw rule needs the whole list, not the step, because it is about
 * ORDER: the server rejects a withdraw that no connection request precedes,
 * and reordering is the thing that breaks it.
 */
function stepProblems(step: WorkflowStep, index: number, steps: readonly WorkflowStep[]): string[] {
  const problems: string[] = [];
  const { amount } = step.delayBefore;
  if (!Number.isInteger(amount) || amount < 0 || amount > DELAY_MAX) {
    problems.push(`The wait has to be a whole number between 0 and ${DELAY_MAX}.`);
  }

  if (step.action === 'withdraw_pending') {
    const invited = steps
      .slice(0, index)
      .some((earlier) => earlier.action === 'connection_request');
    if (!invited) {
      problems.push(
        'There is no connection request above this step, so there is nothing pending to withdraw. Move it below an invite, or add one.'
      );
    }
    if (
      !Number.isInteger(step.config.afterDays) ||
      step.config.afterDays < 1 ||
      step.config.afterDays > 90
    ) {
      problems.push('Withdraw after has to be between 1 and 90 days.');
    }
  }

  if (step.action === 'connection_request') {
    const note = step.config.message ?? '';
    if (note.length > INVITE_NOTE_MAX) {
      problems.push(
        `The note is ${note.length} characters. LinkedIn refuses an invitation note over ${INVITE_NOTE_MAX}.`
      );
    }
  }

  if (step.action === 'message') {
    if (
      step.config.requiresAcceptedConnection &&
      !steps.slice(0, index).some((earlier) => earlier.action === 'connection_request')
    ) {
      problems.push('This condition needs a connection request above the message.');
    }
    if (step.config.variants.every((variant) => variant.body.trim().length === 0)) {
      problems.push('A message step needs copy in at least one variant.');
    }
    if (step.config.variants.length > VARIANT_MAX) {
      problems.push(`A message step takes at most ${VARIANT_MAX} versions.`);
    }
    for (const variant of step.config.variants) {
      if (variant.body.length > BODY_MAX)
        problems.push(
          `Variant ${variant.id.toUpperCase()} is ${variant.body.length} characters. The ceiling is ${BODY_MAX}.`
        );
      if (!Number.isInteger(variant.weight) || variant.weight < 1 || variant.weight > 100) {
        problems.push(`Variant ${variant.id.toUpperCase()} needs a weight between 1 and 100.`);
      }
    }
  }

  if (step.action === 'manual_message' && (step.config.suggestedTemplate ?? '').length > BODY_MAX) {
    problems.push(`The suggestion is over ${BODY_MAX} characters.`);
  }

  for (const template of templatesOf(step)) {
    const bad = unsupportedVariables(template);
    if (bad.length > 0) {
      problems.push(
        `${bad.map((name) => `{{${name}}}`).join(', ')} ${bad.length === 1 ? 'is not a variable' : 'are not variables'} the server accepts. It takes ${MANAGER_VARIABLES.map((name) => `{{${name}}}`).join(', ')}.`
      );
    }
  }

  return problems;
}

/**
 * What actually gets posted.
 *
 * A message variant with no copy is a variant the operator started and left --
 * `body` is `min(1)` on the server, so it is dropped rather than posted as an
 * empty string that would come back as a 400. Dropping it is also what the
 * split on the card already says will happen.
 */
function serializeSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.map((step) =>
    step.action === 'message'
      ? {
          ...step,
          config: {
            ...step.config,
            variants: step.config.variants.filter((variant) => variant.body.trim().length > 0)
          }
        }
      : step
  );
}

function blankStep(action: Action, stepId: string, delayBefore: WorkflowDelay): WorkflowStep {
  const base = { id: stepId, delayBefore };
  if (action === 'connection_request') return { ...base, action, config: { message: '' } };
  if (action === 'withdraw_pending') return { ...base, action, config: { afterDays: 14 } };
  if (action === 'profile_view') return { ...base, action, config: {} };
  if (action === 'message')
    return {
      ...base,
      action,
      config: {
        variants: [
          { id: 'a', body: '', weight: 50 },
          { id: 'b', body: '', weight: 50 }
        ],
        requiresAcceptedConnection: false
      }
    };
  if (action === 'manual_message') return { ...base, action, config: { suggestedTemplate: '' } };
  return { ...base, action: 'follow', config: {} };
}

interface Starter {
  key: string;
  label: string;
  blurb: string;
  build: (mint: () => string) => WorkflowStep[];
}

/**
 * One-click sequences.
 *
 * Each is a shape an operator would otherwise assemble by hand. Where a
 * message needs words, they are written against the three supported
 * variables so the first save is not blocked on writing three messages.
 * Where a note would only read as automated -- a cold invite is the worst
 * place for one -- it is left blank on purpose, same as the product's own
 * cold-outreach default (see `templates.ts`).
 */
const STARTERS: readonly Starter[] = [
  {
    key: 'view-invite-followup',
    label: 'View → Invite → Follow-up message',
    blurb: 'View the profile, send a short invite note, then follow up two days after they accept.',
    build: (mint) => [
      { id: mint(), delayBefore: { amount: 0, unit: 'hours' }, action: 'profile_view', config: {} },
      {
        id: mint(),
        delayBefore: { amount: 1, unit: 'days' },
        action: 'connection_request',
        config: {
          message: '{{first_name}} — connecting because of what {{company}} is doing. No pitch.'
        }
      },
      {
        id: mint(),
        delayBefore: { amount: 2, unit: 'days' },
        action: 'message',
        config: {
          variants: [
            {
              id: 'a',
              body: 'Thanks for connecting, {{first_name}}. What are you focused on at {{company}} right now?',
              weight: 50
            }
          ],
          requiresAcceptedConnection: true
        }
      }
    ]
  },
  {
    key: 'invite-followup-withdraw',
    label: 'Invite → Accepted message → Withdraw after 30 days',
    blurb:
      'Send the message only after they accept. If they are still not connected after 30 days, withdraw the request.',
    build: (mint) => [
      {
        id: mint(),
        delayBefore: { amount: 0, unit: 'hours' },
        action: 'connection_request',
        config: { message: '' }
      },
      {
        id: mint(),
        delayBefore: { amount: 0, unit: 'hours' },
        action: 'message',
        config: {
          variants: [
            {
              id: 'a',
              body: "Good to be connected, {{first_name}}. What's {{company}} working on these days?",
              weight: 50
            }
          ],
          requiresAcceptedConnection: true
        }
      },
      {
        id: mint(),
        delayBefore: { amount: 0, unit: 'hours' },
        action: 'withdraw_pending',
        config: { afterDays: 30 }
      }
    ]
  },
  {
    key: 'warm-touch',
    label: 'View → Follow → Manual note',
    blurb: 'No automated copy: two passive touches, then a human writes the message.',
    build: (mint) => [
      { id: mint(), delayBefore: { amount: 0, unit: 'hours' }, action: 'profile_view', config: {} },
      { id: mint(), delayBefore: { amount: 1, unit: 'days' }, action: 'follow', config: {} },
      {
        id: mint(),
        delayBefore: { amount: 2, unit: 'days' },
        action: 'manual_message',
        config: {
          suggestedTemplate:
            'Read their last two posts, then write to {{first_name}} about one of them.'
        }
      }
    ]
  }
];

/* ---------------------------------------------------------------------------
 * The panel.
 * ------------------------------------------------------------------------ */

export function LinkedInManagerWorkflowConfig({
  onChanged,
  setToast,
  compact = false,
  onCreated
}: {
  onChanged: () => Promise<void>;
  setToast: (message: string) => void;
  /**
   * The inline "new from template" picker used on the campaign screen: pick a
   * starter, it is created and saved immediately, no name field, no step
   * editor, no library table. The full builder below is still where a
   * starter gets customized -- this mode exists for the case where the
   * starter as written is exactly what's wanted.
   */
  compact?: boolean;
  /** Compact mode only: fires with the workflow a starter click just created. */
  onCreated?: (workflow: LinkedInWorkflow) => void;
}) {
  const [library, setLibrary] = useState<LinkedInWorkflow[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The card whose grip is held down. Only that card is draggable, so a caret drag inside a textarea is not a reorder. */
  const [armedId, setArmedId] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  /**
   * Step ids, minted once per edit session and never handed out twice.
   *
   * The old builder named a new step after the list length, so deleting step 2
   * of 3 and adding another minted `step-3` a second time -- a duplicate id,
   * and `workflowStepsSchema` rejects the whole save for it. The used-set is
   * never pruned on a removal, so an id retired at 11:00 is not reissued at
   * 11:01 either.
   */
  const counter = useRef(1);
  const usedIds = useRef(new Set<string>());
  const mintId = () => {
    let candidate = `step-${counter.current}`;
    while (usedIds.current.has(candidate)) {
      counter.current += 1;
      candidate = `step-${counter.current}`;
    }
    counter.current += 1;
    usedIds.current.add(candidate);
    return candidate;
  };
  const claimIds = (existing: readonly WorkflowStep[]) =>
    existing.forEach((step) => usedIds.current.add(step.id));

  const refresh = async () => setLibrary(await getLinkedInManagerWorkflows());
  useEffect(() => {
    if (compact) return;
    void refresh().catch(() => undefined);
  }, [compact]);

  /** Compact mode's whole job: build a starter's steps, save it under its own label, hand it back. No shared mutable id-minting state needed -- this is one save, not an editing session. */
  const createFromStarter = async (starter: Starter) => {
    setBusy(true);
    setError('');
    try {
      let nextId = 1;
      const mint = () => `step-${nextId++}`;
      const workflow = await createLinkedInManagerWorkflow({
        name: starter.label,
        steps: serializeSteps(starter.build(mint))
      });
      setToast(`Workflow “${workflow.name}” saved. This stored configuration and queued nothing.`);
      onCreated?.(workflow);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Unable to create that workflow.'));
    } finally {
      setBusy(false);
    }
  };

  const problems = useMemo(
    () => steps.map((step, index) => stepProblems(step, index, steps)),
    [steps]
  );
  const brokenCount = problems.filter((list) => list.length > 0).length;
  const cumulative = useMemo(() => {
    let total = 0;
    return steps.map((step) => {
      total += hoursOf(step.delayBefore);
      return total;
    });
  }, [steps]);

  const replaceStep = (index: number, next: WorkflowStep) =>
    setSteps((current) => current.map((step, at) => (at === index ? next : step)));
  const addStep = (action: Action) =>
    setSteps((current) =>
      current.length >= MAX_STEPS
        ? current
        : [
            ...current,
            blankStep(action, mintId(), {
              amount: current.length === 0 ? 0 : 1,
              unit: current.length === 0 ? 'hours' : 'days'
            })
          ]
    );
  const removeStep = (index: number) =>
    setSteps((current) => current.filter((_, at) => at !== index));
  const moveStep = (from: number, to: number) =>
    setSteps((current) => {
      if (from === to || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  const reset = () => {
    setId(null);
    setName('');
    setSteps([]);
    setError('');
  };
  const edit = (workflow: LinkedInWorkflow) => {
    claimIds(workflow.steps);
    setId(workflow.id);
    setName(workflow.name);
    setSteps(workflow.steps);
    setError('');
  };
  const applyStarter = (starter: Starter) => {
    setSteps(starter.build(mintId));
    setError('');
    if (!name.trim()) setName(starter.label);
  };

  const clearDrag = () => {
    setArmedId(null);
    setDragFrom(null);
    setDropAt(null);
  };

  /**
   * A GRIP THAT WAS PRESSED AND NOT DRAGGED HAS TO DISARM ITSELF.
   *
   * `onMouseDown` on the grip arms the card -- it is what makes `draggable`
   * true, so that a caret drag inside a textarea is never a reorder -- but the
   * only things that cleared it were `onDragEnd` and `onDrop`. A grip CLICK
   * produces neither, so one stray click left that card draggable for the rest
   * of the session and selecting text in it started a drag instead.
   *
   * The listener is on the document rather than on the button because a pointer
   * does not have to come back up over the element it went down on. A real drag
   * is unaffected: browsers suppress `mouseup` for the duration of a native drag
   * and fire `dragend` instead, which `clearDrag` already handles.
   */
  useEffect(() => {
    if (armedId === null) return undefined;
    const disarm = () => setArmedId(null);
    document.addEventListener('mouseup', disarm);
    document.addEventListener('touchend', disarm);
    document.addEventListener('touchcancel', disarm);
    return () => {
      document.removeEventListener('mouseup', disarm);
      document.removeEventListener('touchend', disarm);
      document.removeEventListener('touchcancel', disarm);
    };
  }, [armedId]);

  /**
   * THE THREE GUARDS BELOW ARE REACHABLE, AND MAKING THEM SO WAS THE FIX.
   *
   * None of them could fire. The save button was disabled on an empty name and
   * on a broken step, and its footer only rendered once there was at least one
   * step, so all three strings were dead code -- and a builder holding a
   * finished sequence with no name faced a dead button with nothing anywhere
   * saying which field it was waiting on. The button is now disabled only while
   * a request is in flight, and each refusal says its own reason, which is the
   * rule the step cards have followed all along.
   */
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the workflow a name.');
      return;
    }
    if (steps.length === 0) {
      setError('A workflow needs at least one step.');
      return;
    }
    if (brokenCount > 0) {
      setError('Some steps still have problems. They are marked below.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = { name: trimmed, steps: serializeSteps(steps) };
      const saved = id
        ? await updateLinkedInManagerWorkflow(id, payload)
        : await createLinkedInManagerWorkflow(payload);
      setToast(`Workflow “${saved.name}” saved. This stored configuration and queued nothing.`);
      reset();
      await Promise.all([refresh(), onChanged()]);
    } catch (err) {
      setError(errorMessage(err, 'Unable to save that workflow.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (workflow: LinkedInWorkflow) => {
    setBusy(true);
    setError('');
    try {
      await deleteLinkedInManagerWorkflow(workflow.id);
      if (id === workflow.id) reset();
      setToast(`Workflow “${workflow.name}” deleted.`);
      await Promise.all([refresh(), onChanged()]);
    } catch (err) {
      setError(errorMessage(err, 'Unable to delete that workflow.'));
    } finally {
      setBusy(false);
    }
  };

  if (compact) {
    return (
      <div className="li-wf-compact">
        {error && <div className="error-banner">{error}</div>}
        <div className="li-wf-starters">
          {STARTERS.map((starter) => (
            <button
              className="li-wf-starter"
              type="button"
              key={starter.key}
              disabled={busy}
              onClick={() => void createFromStarter(starter)}
            >
              <strong>{starter.label}</strong>
              <p>{starter.blurb}</p>
              <span className="li-wf-starter-steps">
                {starter
                  .build(() => 'preview')
                  .map((step, at) => (
                    <span
                      className={`li-chip li-kind-chip ${ACTION_META[step.action].chip}`}
                      key={`${starter.key}-${at}`}
                    >
                      {ACTION_META[step.action].label}
                    </span>
                  ))}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Reusable workflow builder</h3>
          <p>
            A workflow is a ladder of LinkedIn actions, each waiting its own delay. Definitions are
            versioned and validated. Saving one never creates a LinkedIn action.
          </p>
        </div>
        {(id || steps.length > 0) && (
          <button className="ghost-button" type="button" onClick={reset}>
            New workflow
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <label className="li-block-label">
        Workflow name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Founder connect + follow-up"
        />
      </label>

      {steps.length === 0 ? (
        <div className="empty-state li-wf-empty">
          <LayoutTemplate size={22} />
          <h4>No steps yet</h4>
          <p>
            A workflow is the sequence every lead in a campaign walks: view the profile, ask to
            connect, follow up, withdraw what nobody answered. Each step waits its own delay before
            it runs. Start from one of these and edit it, or pick any of the six actions below as
            the first step.
          </p>
          <div className="li-wf-starters">
            {STARTERS.map((starter) => (
              <button
                className="li-wf-starter"
                type="button"
                key={starter.key}
                onClick={() => applyStarter(starter)}
              >
                <strong>{starter.label}</strong>
                <p>{starter.blurb}</p>
                <span className="li-wf-starter-steps">
                  {starter
                    .build(() => 'preview')
                    .map((step, at) => (
                      <span
                        className={`li-chip li-kind-chip ${ACTION_META[step.action].chip}`}
                        key={`${starter.key}-${at}`}
                      >
                        {ACTION_META[step.action].label}
                      </span>
                    ))}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ol className="li-wf-timeline">
          {steps.map((step, index) => (
            <li
              className={`li-wf-node${dragFrom === index ? ' is-dragging' : ''}${dropAt === index && dragFrom !== null && dragFrom !== index ? ' is-drop-target' : ''}`}
              key={step.id}
            >
              <div className="li-wf-rail" aria-hidden="true">
                <span className="li-wf-marker">{index + 1}</span>
                {index < steps.length - 1 && <span className="li-wf-line" />}
              </div>
              <WorkflowStepCard
                step={step}
                index={index}
                total={steps.length}
                when={whenLabel(cumulative[index])}
                problems={problems[index]}
                armed={armedId === step.id}
                onArm={() => setArmedId(step.id)}
                onChange={(next) => replaceStep(index, next)}
                onChangeAction={(action) =>
                  replaceStep(index, blankStep(action, step.id, step.delayBefore))
                }
                onMove={(direction) => moveStep(index, index + direction)}
                onRemove={() => removeStep(index)}
                onDragStart={() => setDragFrom(index)}
                onDragOver={() => setDropAt(index)}
                onDrop={() => {
                  if (dragFrom !== null) moveStep(dragFrom, index);
                  clearDrag();
                }}
                onDragEnd={clearDrag}
              />
            </li>
          ))}
        </ol>
      )}

      {/*
      THIS MENU IS THE ONLY WAY TO ADD A STEP, INCLUDING THE FIRST ONE.
      The empty state used to offer a single button hardcoded to `profile_view`,
      and the six-action menu rendered only once a step already existed -- so
      five of the six actions could not begin a workflow. An operator wanting to
      open on a connection request had to add a profile view and then change what
      it was. Rendering it in both states means the first step is chosen exactly
      the way every later one is.
    */}
      <div className="li-add-step">
        <fieldset className="li-add-step-group">
          <legend>{steps.length === 0 ? 'Start with a step' : 'Add a step'}</legend>
          <div className="li-add-step-buttons">
            {ACTION_ORDER.map((action) => {
              const { Icon, label } = ACTION_META[action];
              return (
                <button
                  className="li-mini-button"
                  type="button"
                  key={action}
                  disabled={steps.length >= MAX_STEPS}
                  onClick={() => addStep(action)}
                >
                  <Icon size={12} /> {label}
                </button>
              );
            })}
          </div>
        </fieldset>
        {steps.length >= MAX_STEPS && (
          <span className="li-hint">A workflow holds {MAX_STEPS} steps at most.</span>
        )}
      </div>

      <div className="panel-footer">
        <span>
          {brokenCount > 0
            ? `${brokenCount} step${brokenCount === 1 ? '' : 's'} still ${brokenCount === 1 ? 'has' : 'have'} something the server would refuse. Each one says what, below.`
            : steps.length === 0
              ? 'A workflow needs at least one step. Pick the first one above.'
              : !name.trim()
                ? 'Give the workflow a name and it can be saved.'
                : 'Saving stores this definition. It queues no LinkedIn action.'}
        </span>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{' '}
          {id ? 'Update workflow' : 'Save workflow'}
        </button>
      </div>

      {library.length > 0 && (
        <div className="li-table-scroll">
          <table className="li-table">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Steps</th>
                <th>Version</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {library.map((workflow) => (
                <tr key={workflow.id}>
                  <td>
                    <button className="ghost-button" type="button" onClick={() => edit(workflow)}>
                      {workflow.name}
                    </button>
                  </td>
                  <td>{workflow.steps.length}</td>
                  <td>v{workflow.version}</td>
                  <td>
                    <button
                      className="icon-button"
                      type="button"
                      title="Delete workflow"
                      onClick={() => void remove(workflow)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * One step.
 * ------------------------------------------------------------------------ */

function WorkflowStepCard({
  step,
  index,
  total,
  when,
  problems,
  armed,
  onArm,
  onChange,
  onChangeAction,
  onMove,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  /** Cumulative offset from campaign start, already worded. */
  when: string;
  problems: readonly string[];
  armed: boolean;
  onArm: () => void;
  onChange: (next: WorkflowStep) => void;
  onChangeAction: (action: Action) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const meta = ACTION_META[step.action];
  const { Icon } = meta;
  /** Every textarea on this card, so a merge field lands at the caret of the one it belongs to. */
  const fields = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const insert = (key: string, value: string, token: string, commit: (next: string) => void) => {
    const element = fields.current[key];
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    commit(`${value.slice(0, start)}${token}${value.slice(end)}`);
    requestAnimationFrame(() => {
      if (!element) return;
      const caret = start + token.length;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const setDelay = (patch: Partial<WorkflowDelay>) =>
    onChange({ ...step, delayBefore: { ...step.delayBefore, ...patch } } as WorkflowStep);

  return (
    <article
      className="li-step li-step-card li-wf-card"
      draggable={armed}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      <header>
        <span className={`li-chip li-kind-chip ${meta.chip}`}>
          <Icon size={12} /> {meta.label}
        </span>
        <span className="li-wf-when">{when}</span>
        <div className="li-step-tools">
          <button
            className="li-mini-button li-wf-grip"
            type="button"
            aria-label={`Drag step ${index + 1} to reorder`}
            title="Drag to reorder"
            onMouseDown={onArm}
            onTouchStart={onArm}
          >
            <GripVertical size={12} />
          </button>
          <button
            className="li-mini-button"
            type="button"
            disabled={index === 0}
            aria-label={`Move step ${index + 1} earlier`}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={12} />
          </button>
          <button
            className="li-mini-button"
            type="button"
            disabled={index === total - 1}
            aria-label={`Move step ${index + 1} later`}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={12} />
          </button>
          <button
            className="li-mini-button li-mini-danger"
            type="button"
            aria-label={`Delete step ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </header>

      <div className="li-form-grid li-step-fields">
        <label>
          Action
          <select
            value={step.action}
            aria-label={`Action for step ${index + 1}`}
            onChange={(event) => onChangeAction(event.target.value as Action)}
          >
            {ACTION_ORDER.map((action) => (
              <option key={action} value={action}>
                {ACTION_META[action].label}
              </option>
            ))}
          </select>
        </label>
        <div className="li-wf-wait">
          <label>
            Wait before this step
            <input
              type="number"
              min={0}
              max={DELAY_MAX}
              value={step.delayBefore.amount}
              onChange={(event) =>
                setDelay({
                  amount: Math.min(
                    DELAY_MAX,
                    Math.max(0, Math.trunc(Number(event.target.value) || 0))
                  )
                })
              }
            />
          </label>
          <label>
            Unit
            <select
              value={step.delayBefore.unit}
              onChange={(event) => setDelay({ unit: event.target.value as 'hours' | 'days' })}
            >
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </label>
        </div>
        <p className="li-hint li-span-2">
          {index === 0
            ? `Runs ${waitLabel(step.delayBefore)} after the campaign starts the lead — ${when.toLowerCase()}.`
            : `Runs ${waitLabel(step.delayBefore)} after step ${index} — ${when.toLowerCase()}.`}
        </p>

        {step.action === 'connection_request' && (
          <div className="li-span-2">
            <label>
              Invitation note (optional)
              <textarea
                ref={(element) => {
                  fields.current.note = element;
                }}
                rows={3}
                value={step.config.message ?? ''}
                onChange={(event) => onChange({ ...step, config: { message: event.target.value } })}
                placeholder="Hi {{first_name}} — …"
              />
            </label>
            <MergeRow
              onInsert={(variable) =>
                insert('note', step.config.message ?? '', `{{${variable}}}`, (next) =>
                  onChange({ ...step, config: { message: next } })
                )
              }
              trailing={
                <CharCount length={(step.config.message ?? '').length} max={INVITE_NOTE_MAX} />
              }
            />
            <TemplatePreview value={step.config.message ?? ''} />
            <p className="li-hint">An empty note sends the request with no message at all.</p>
          </div>
        )}

        {step.action === 'withdraw_pending' && (
          <label>
            Withdraw invites older than (days)
            <input
              type="number"
              min={1}
              max={90}
              value={step.config.afterDays}
              onChange={(event) =>
                onChange({
                  ...step,
                  config: {
                    afterDays: Math.min(
                      90,
                      Math.max(1, Math.trunc(Number(event.target.value) || 1))
                    )
                  }
                })
              }
            />
          </label>
        )}

        {step.action === 'message' && (
          <label className="li-span-2">
            Condition
            <select
              value={step.config.requiresAcceptedConnection ? 'accepted' : 'always'}
              onChange={(event) =>
                onChange({
                  ...step,
                  config: {
                    ...step.config,
                    requiresAcceptedConnection: event.target.value === 'accepted'
                  }
                })
              }
            >
              <option value="always">Always send when this step is due</option>
              <option value="accepted">Only if the connection request was accepted</option>
            </select>
          </label>
        )}

        {step.action === 'message' && (
          <MessageVariants
            step={step}
            bind={(key, element) => {
              fields.current[key] = element;
            }}
            insert={insert}
            onChange={onChange}
          />
        )}

        {step.action === 'manual_message' && (
          <div className="li-span-2">
            <label>
              Suggested copy for the human (optional)
              <textarea
                ref={(element) => {
                  fields.current.suggested = element;
                }}
                rows={3}
                value={step.config.suggestedTemplate ?? ''}
                onChange={(event) =>
                  onChange({ ...step, config: { suggestedTemplate: event.target.value } })
                }
                placeholder="Review the thread and write a personal note."
              />
            </label>
            <MergeRow
              onInsert={(variable) =>
                insert(
                  'suggested',
                  step.config.suggestedTemplate ?? '',
                  `{{${variable}}}`,
                  (next) => onChange({ ...step, config: { suggestedTemplate: next } })
                )
              }
              trailing={
                <CharCount length={(step.config.suggestedTemplate ?? '').length} max={BODY_MAX} />
              }
            />
            <TemplatePreview value={step.config.suggestedTemplate ?? ''} />
          </div>
        )}

        {(step.action === 'profile_view' ||
          step.action === 'follow' ||
          step.action === 'withdraw_pending') && <p className="li-hint li-span-2">{meta.blurb}</p>}
      </div>

      {problems.length > 0 && (
        <div className="li-wf-issues">
          {problems.map((problem) => (
            <small className="li-merge-warn" key={problem}>
              {problem}
            </small>
          ))}
        </div>
      )}
    </article>
  );
}

/* ---------------------------------------------------------------------------
 * A/B variants.
 * ------------------------------------------------------------------------ */

function MessageVariants({
  step,
  bind,
  insert,
  onChange
}: {
  step: MessageStep;
  bind: (key: string, element: HTMLTextAreaElement | null) => void;
  insert: (key: string, value: string, token: string, commit: (next: string) => void) => void;
  onChange: (next: WorkflowStep) => void;
}) {
  const variants = step.config.variants;
  const written = variants.filter((variant) => variant.body.trim().length > 0);
  const total = written.reduce((sum, variant) => sum + Math.max(1, variant.weight), 0);

  // `...step.config` matters: dropping it silently reset `requiresAcceptedConnection`
  // to false (the option this step doesn't render its own control for the
  // opposite of) on every keystroke in a variant body, every weight tweak, and
  // every add/remove -- so choosing "only if accepted" and then editing the
  // copy quietly threw the condition away.
  const setVariants = (next: Variant[]) =>
    onChange({ ...step, config: { ...step.config, variants: next } });
  const patch = (at: number, changes: Partial<Variant>) =>
    setVariants(
      variants.map((variant, index) => (index === at ? { ...variant, ...changes } : variant))
    );
  const share = (variant: Variant) => {
    if (variant.body.trim().length === 0 || total === 0) return null;
    return Math.round((Math.max(1, variant.weight) / total) * 100);
  };

  /** Re-spread the weights over whatever arms are left, so the card's split is the one that runs. */
  const setRenormalised = (next: Variant[]) => {
    const weights = renormaliseWeights(next.map((variant) => variant.weight));
    setVariants(next.map((variant, index) => ({ ...variant, weight: weights[index] })));
  };

  const minted = nextVariantId(variants.map((variant) => variant.id));
  const addVariant = () => {
    if (!minted) return;
    // The new arm starts on the MEAN of the existing ones, so a 70/30 split
    // stays a 70/30 split with a third arm beside it rather than being flattened
    // to thirds -- the operator's intent is a ratio, not the two numbers.
    const mean = Math.max(
      1,
      Math.round(
        variants.reduce((sum, variant) => sum + Math.max(1, variant.weight), 0) /
          Math.max(1, variants.length)
      )
    );
    setRenormalised([...variants, { id: minted, body: '', weight: mean }]);
  };

  return (
    <div className="li-span-2 li-wf-variants">
      {variants.map((variant, at) => {
        const key = `variant-${variant.id}`;
        const pct = share(variant);
        return (
          <div className="li-wf-variant" key={variant.id}>
            <div className="li-wf-variant-head">
              <span className="li-chip">Variant {variant.id.toUpperCase()}</span>
              <label className="li-wf-weight">
                Weight
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={variant.weight}
                  aria-label={`Weight for variant ${variant.id.toUpperCase()}`}
                  onChange={(event) =>
                    patch(at, {
                      weight: Math.min(
                        100,
                        Math.max(1, Math.trunc(Number(event.target.value) || 1))
                      )
                    })
                  }
                />
              </label>
              <span className="li-wf-share">
                {pct === null ? 'no copy — dropped on save' : `${pct}% of leads`}
              </span>
              {variants.length > 1 && (
                <button
                  className="li-mini-button li-mini-danger"
                  type="button"
                  aria-label={`Remove variant ${variant.id.toUpperCase()}`}
                  onClick={() => setRenormalised(variants.filter((_, index) => index !== at))}
                >
                  Remove
                </button>
              )}
            </div>
            <textarea
              ref={(element) => bind(key, element)}
              rows={4}
              value={variant.body}
              aria-label={`Copy for variant ${variant.id.toUpperCase()}`}
              onChange={(event) => patch(at, { body: event.target.value })}
              placeholder="Hi {{first_name}}, noticed {{company}}…"
            />
            <MergeRow
              onInsert={(name) =>
                insert(key, variant.body, `{{${name}}}`, (next) => patch(at, { body: next }))
              }
              trailing={<CharCount length={variant.body.length} max={BODY_MAX} />}
            />
            <TemplatePreview value={variant.body} />
          </div>
        );
      })}

      <div className="li-wf-split">
        <span className="li-wf-split-bar">
          {written.map((variant) => (
            <span
              className={`li-wf-split-fill li-wf-split-${variant.id.toLowerCase()}`}
              key={variant.id}
              style={{
                width: `${Math.round((Math.max(1, variant.weight) / total) * 100)}%`,
                background: VARIANT_FILL[variant.id.toLowerCase()]
              }}
            />
          ))}
        </span>
        <span className="li-hint">
          {written.length === 0
            ? 'No version has copy yet.'
            : written.length === 1
              ? `Every lead gets variant ${written[0].id.toUpperCase()}.`
              : written
                  .map(
                    (variant) =>
                      `${variant.id.toUpperCase()} ${Math.round((Math.max(1, variant.weight) / total) * 100)}%`
                  )
                  .join(' · ')}
        </span>
      </div>

      {minted ? (
        <div className="li-wf-split">
          <button className="li-mini-button" type="button" onClick={addVariant}>
            <Plus size={12} /> Add variant {minted.toUpperCase()}
          </button>
          <span className="li-hint">
            Up to {VARIANT_MAX} versions per step. Each one needs about 20 messages of its own
            before the results panel will name a winner, so a four-way test takes roughly four times
            as long to read as a two-way one.
          </span>
        </div>
      ) : (
        <span className="li-hint">
          {VARIANT_MAX} versions is the most one step can test. Remove one to try different wording.
        </span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Small shared parts.
 * ------------------------------------------------------------------------ */

/** The three variables the server accepts, as buttons, because they are a closed set. */
function MergeRow({
  onInsert,
  trailing
}: {
  onInsert: (variable: ManagerVariable) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="li-merge-row">
      {MANAGER_VARIABLES.map((variable) => (
        <button
          className="li-merge-button"
          type="button"
          key={variable}
          // Keeps the caret in the textarea the click is about to write into.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onInsert(variable)}
        >{`{{${variable}}}`}</button>
      ))}
      {trailing}
    </div>
  );
}

function CharCount({ length, max }: { length: number; max: number }) {
  return (
    <span className={`li-count${length > max ? ' is-over' : ''}`}>
      {length}/{max}
    </span>
  );
}

/** What one lead would actually read. Silent until something is written. */
function TemplatePreview({ value }: { value: string }) {
  if (!value.trim()) return null;
  return (
    <div className="li-wf-preview">
      <span className="li-wf-preview-label">
        Preview · {SAMPLE_LEAD.first_name} {SAMPLE_LEAD.last_name}, {SAMPLE_LEAD.company}
      </span>
      <p className="li-template">{renderSample(value)}</p>
    </div>
  );
}
