import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Award,
  CalendarClock,
  CircleAlert,
  CircleStop,
  CornerDownRight,
  Download,
  Eye,
  FileUp,
  LayoutTemplate,
  LoaderCircle,
  Mail,
  MessageSquare,
  Play,
  Plus,
  Save,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  Trash2,
  UserCheck,
  UserPlus,
  X
} from 'lucide-react';
import type { PlaybookRun, PlaybookStepRun } from '../shared/types';
import {
  ApiError,
  LINKEDIN_BRANCH_ON,
  LINKEDIN_EXPORT_FORMATS,
  LINKEDIN_INVITE_NOTE_MAX_CHARS,
  LINKEDIN_MERGE_FIELDS,
  PACED_KINDS,
  branchOnOptions,
  createLinkedInCampaign,
  decidePlaybookStep,
  draftLinkedInCampaign,
  exportLinkedInCampaign,
  getLinkedInCampaign,
  getLinkedInCampaigns,
  getLinkedInLeadSources,
  getLinkedInLeads,
  getLinkedInSequenceConfig,
  importLinkedInTargets,
  linkedInExportDownloadPath,
  planLinkedIn,
  saveLinkedInCampaignSequence,
  stopLinkedInCampaign,
  type BranchOn,
  type EditableSequenceStep,
  type ExportContact,
  type ExportFormat,
  type LinkedInCampaign,
  type LinkedInCampaignDetail,
  type LinkedInCampaignDraft,
  type LinkedInCeiling,
  type LinkedInLeadSource,
  type LinkedInLimitsReport,
  type LinkedInPlanResponse,
  type LinkedInSequence,
  type LinkedInSequenceConfig,
  type LinkedInSequenceTemplate,
  type PacedKind,
  type SequenceStepKind,
  type SequenceTone,
  type StepCondition
} from './api';
import { LinkedInCampaignBreakdown } from './LinkedInAnalyticsScreen';
import {
  ACTION_KIND_LABELS_ONE,
  EXPORT_FORMAT_LABELS,
  KIND_LABELS,
  TONE_LABELS,
  actionStatusLabel,
  errorMessage,
  humanizeRule,
  reloadOutreach,
  takeStagedTargets,
  useOutreachRefresh,
  useSeatLimits
} from './LinkedInSafety';
import { ConfidenceTag, Define } from './LinkedInViz';
import { ConfirmDrawer } from './ui/dialog';

/**
 * Campaigns, the sequence builder, and the plan preview.
 *
 * The screens are one file because they are one flow: a sequence is assembled,
 * the sequence is paced into slots, and the slots are what a human approves.
 * Nothing here sends anything -- `POST /api/linkedin/plan` is a dry run that
 * writes no ledger row, and an export is the APPROVED bytes rendered for the
 * operator's own tool, never a fresh plan.
 *
 * Authoring is the operator's, not the model's. A campaign is a name, a domain
 * and a list of targets; the steps below it are assembled by hand or seeded
 * from a draft, and every line of copy stays editable. The brief that used to
 * be the entrance is still here, folded away, for the operator who would rather
 * steer the draft than write it.
 */

const TONES: readonly SequenceTone[] = ['direct', 'consultative', 'peer'];

interface StepKindMeta {
  kind: SequenceStepKind;
  label: string;
  Icon: typeof Eye;
  /** False for the four steps that carry no message. */
  carriesCopy: boolean;
  /** What a step with no copy is for, said on the card in place of the copy field. */
  noCopyNote?: string;
}

/**
 * Every kind a step may be.
 *
 * The three ENGAGEMENT kinds join the four with the same standing as
 * `profile_view`: they carry no copy, they are paced by their own ceilings,
 * and they go through the identical safety gate -- liking 200 posts in an hour
 * is a ban signal however harmless one like is. They exist here because plan
 * 1.4's warm-up ramp is written in terms of them ("wk1 passive only
 * (views/likes, 0 invites)"), so a builder that could not schedule any of them
 * could only ever author half of a warm-up.
 */
const STEP_KINDS: readonly StepKindMeta[] = [
  {
    kind: 'profile_view', label: 'Profile view', Icon: Eye, carriesCopy: false,
    noCopyNote: 'A profile view carries no message. It warms the target before whatever comes next.'
  },
  { kind: 'invite', label: 'Invite', Icon: UserPlus, carriesCopy: true },
  { kind: 'dm', label: 'Message', Icon: MessageSquare, carriesCopy: true },
  { kind: 'inmail', label: 'InMail', Icon: Mail, carriesCopy: true },
  {
    kind: 'follow', label: 'Follow', Icon: UserCheck, carriesCopy: false,
    noCopyNote: 'A follow carries no message. It puts this seat in their notifications without asking for anything.'
  },
  {
    kind: 'like', label: 'Like', Icon: ThumbsUp, carriesCopy: false,
    noCopyNote: 'A like carries no message. It lands on their most recent post, and LinkedIn tells nobody whether it was noticed.'
  },
  {
    kind: 'endorse', label: 'Endorse', Icon: Award, carriesCopy: false,
    noCopyNote: 'An endorsement carries no message. It endorses a skill already on their profile — nothing here writes one.'
  }
];

/** Falls back to the message card rather than rendering a kind with no face. */
const stepKindMeta = (kind: SequenceStepKind): StepKindMeta =>
  STEP_KINDS.find((entry) => entry.kind === kind) ?? STEP_KINDS[2];

/* -------------------------------------------------------------------------
 * Branching.
 *
 * A step may wait on an EARLIER step's outcome, which is what turns a list
 * into a sequence that reacts. Two rules make it decidable, and both are the
 * server's (`branching.ts`), restated here so an operator hears about a broken
 * branch while they are editing it rather than in a 400 after six steps:
 *
 *   1. EARLIER ONLY. A branch reads a step that has already run, which is also
 *      what makes the graph acyclic.
 *   2. ONLY AN OUTCOME-BEARING STEP CAN ANSWER. LinkedIn tells nobody whether
 *      a stranger saw a profile view, a follow, a like or an endorsement, so a
 *      branch on one of those could never be decided either way -- it would be
 *      a step that stays pending for the life of the campaign. And only a
 *      connection request can be *accepted*.
 *
 * `always` is the fifth value and it is the default. It renders as nothing at
 * all -- no chip, no indent, no connector -- because it is what every existing
 * sequence already is, and decorating the ordinary case is how the branched
 * one stops standing out.
 * ---------------------------------------------------------------------- */

const BRANCH_ON_LABELS: Record<BranchOn, string> = {
  always: 'Always',
  accepted: 'Only if accepted',
  replied: 'Only if replied to',
  not_accepted: 'Only if not accepted',
  not_replied: 'Only if there was no reply'
};

/** The chip on a branched card. Written as the operator would say it aloud. */
const BRANCH_SENTENCES: Record<Exclude<BranchOn, 'always'>, (stepId: string) => string> = {
  accepted: (stepId) => `if ${stepId} was accepted`,
  replied: (stepId) => `if ${stepId} was replied to`,
  not_accepted: (stepId) => `if ${stepId} was not accepted`,
  not_replied: (stepId) => `if ${stepId} got no reply`
};

/** The chip's text, or null when this step is the unremarkable unconditional case. */
function branchSentence(condition: StepCondition | null | undefined): string | null {
  if (!condition || condition.on === 'always') return null;
  return BRANCH_SENTENCES[condition.on](condition.ofStepId);
}

/** Kinds whose outcome a branch can read. `reply` is one too, but no step schedules one. */
const RESULT_BEARING_KINDS: readonly SequenceStepKind[] = ['invite', 'dm', 'inmail'];

/** The earlier steps that could answer `on`. Empty means that branch is not offerable here. */
function eligibleAnchors(
  steps: readonly EditableSequenceStep[],
  index: number,
  on: BranchOn
): EditableSequenceStep[] {
  const earlier = steps.slice(0, Math.max(0, index));
  if (on === 'always') return earlier;
  if (on === 'accepted' || on === 'not_accepted') return earlier.filter((step) => step.kind === 'invite');
  return earlier.filter((step) => RESULT_BEARING_KINDS.includes(step.kind));
}

/**
 * The one sentence a broken branch deserves, or null.
 *
 * Surfaced on the card AND it blocks the save, exactly like an unknown merge
 * field: the alternative is a 400 that arrives after the whole sequence has
 * been written, naming one step by an id the operator has to go and find.
 */
function branchProblem(steps: readonly EditableSequenceStep[], index: number): string | null {
  const condition = steps[index]?.condition;
  if (!condition || condition.on === 'always') return null;

  const ofStepId = condition.ofStepId?.trim() ?? '';
  if (!ofStepId) return 'This branch names no step to wait on, so nothing would decide whether it runs.';

  const anchor = steps.slice(0, index).find((step) => step.id === ofStepId);
  if (!anchor) {
    return steps.some((step) => step.id === ofStepId)
      ? `This step waits on ${ofStepId}, which now comes after it. A branch can only read a step that has already run.`
      : `This step waits on ${ofStepId}, which is no longer in this sequence, so nothing would decide whether it runs.`;
  }
  if (!RESULT_BEARING_KINDS.includes(anchor.kind)) {
    return `A ${stepKindMeta(anchor.kind).label.toLowerCase()} is never accepted or replied to, so this branch could never be `
      + 'decided either way. Point it at an invite, a message or an InMail.';
  }
  if ((condition.on === 'accepted' || condition.on === 'not_accepted') && anchor.kind !== 'invite') {
    return `Only a connection request can be accepted, and ${ofStepId} is a ${stepKindMeta(anchor.kind).label.toLowerCase()}.`;
  }
  return null;
}

/** Everything the AI draft fills in and the operator may override. Secondary now, but not gone. */
interface CampaignBrief {
  role: string;
  segment: string;
  pain: string;
  offerName: string;
  summary: string;
  mechanism: string;
  proof: string;
  url: string;
  tone: SequenceTone;
  kind: PacedKind;
  horizonDays: number;
  format: ExportFormat;
  includeInMail: boolean;
  /** `none` asks the draft for a bare connection request. The default, because a template note reads as one. */
  inviteNote: 'drafted' | 'none';
}

const EMPTY_BRIEF: CampaignBrief = {
  role: '', segment: '', pain: '',
  offerName: '', summary: '', mechanism: '', proof: '', url: '',
  tone: 'consultative', kind: 'invite', horizonDays: 14, format: 'dripify', includeInMail: false,
  inviteNote: 'none'
};

/**
 * What DRAFTING from a brief needs, and the label to name it by.
 *
 * Only consulted when there are no steps to post. A campaign assembled from a
 * template or from the builder carries its own copy and needs none of this --
 * the brief stopped being a toll gate on the way to a campaign.
 */
const DRAFTABLE_BRIEF: ReadonlyArray<readonly [keyof CampaignBrief, string]> = [
  ['role', 'ICP role'],
  ['segment', 'Segment'],
  ['pain', 'Pain, in their words'],
  ['offerName', 'Offer name'],
  ['summary', 'What it does'],
  ['mechanism', 'Why it works']
];

const splitTargets = (value: string) => value.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);

/** Enough of a lead source to choose between two of them in one line. */
const LEAD_SOURCE_KINDS: Record<string, string> = { search: 'People search', post: 'Post engagement' };
const LEAD_SOURCE_STATUS: Record<string, string> = {
  pending: 'Queued', running: 'Walking', completed: 'Done', failed: 'Failed'
};

/** `https://www.linkedin.com/in/pankaj-x/` -> `linkedin.com/in/pankaj-x`. */
const shortSourceUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${`${parsed.pathname}${parsed.search}`.replace(/\/+$/, '')}`.slice(0, 72);
  } catch { return url.slice(0, 72); }
};

/** `label: value` per line. Anything without a colon is dropped rather than guessed at. */
function parseProof(value: string): Array<{ label: string; value: string }> {
  return value.split('\n').map((line) => line.split(':')).filter((parts) => parts.length >= 2)
    .map((parts) => ({ label: parts[0].trim(), value: parts.slice(1).join(':').trim() }))
    .filter((entry) => entry.label && entry.value).slice(0, 6);
}

/** `sequence` is `unknown` on the wire; this is the only place that narrows it. */
function asSequence(value: unknown): LinkedInSequence | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LinkedInSequence>;
  return Array.isArray(candidate.steps) ? candidate as LinkedInSequence : null;
}

const MERGE_TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * The merge fields in `template` the server would reject.
 *
 * Surfaced on the card, and it blocks the save. The alternative is a 400 that
 * arrives after the operator has written six steps, naming one of them.
 */
function unknownMergeFields(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(MERGE_TOKEN)) {
    if (!LINKEDIN_MERGE_FIELDS.includes(match[1])) found.add(match[1]);
  }
  return [...found];
}

/**
 * A new card's id: the lowest `step-N` this list is not already using.
 *
 * Deterministic, and that is not fussiness. An approval binds the hash of the
 * payload it was granted for, and a step id is part of that payload -- so the
 * same sequence assembled twice has to post the same bytes.
 */
function nextStepId(existing: readonly { id: string }[]): string {
  const used = new Set(existing.map((step) => step.id));
  let index = existing.length + 1;
  while (used.has(`step-${index}`)) index += 1;
  return `step-${index}`;
}

/**
 * Narrow whatever the draft route or a stored campaign hands us into steps.
 *
 * Written against a partial response: a missing array, a step with no `kind`, a
 * `day` that arrived as a string. Every one of those renders something rather
 * than blanking the screen.
 *
 * IDS ARE TAKEN AT FACE VALUE. The server guarantees every step it serves has
 * a unique, non-empty id (`withUniqueStepIds` in linkedin/templates.ts), so
 * nothing here rewrites one -- an id the operator sees is the id the library
 * published. Only a step that arrives without one is given a new one.
 */
function normalizeSteps(value: unknown): EditableSequenceStep[] {
  const nested = (value ?? null) as { steps?: unknown } | null;
  const list: unknown[] = Array.isArray(value) ? value : Array.isArray(nested?.steps) ? nested.steps : [];
  const normalized: EditableSequenceStep[] = [];
  list.forEach((entry, index) => {
    const step = (entry ?? {}) as Partial<EditableSequenceStep>;
    const kind = STEP_KINDS.some((meta) => meta.kind === step.kind) ? step.kind as SequenceStepKind : 'dm';
    const day = Number.isFinite(Number(step.day)) ? Math.max(0, Math.trunc(Number(step.day))) : index * 2;
    normalized.push({
      id: typeof step.id === 'string' && step.id.trim() ? step.id.trim() : nextStepId(normalized),
      day,
      kind,
      intent: typeof step.intent === 'string' ? step.intent : '',
      template: stepKindMeta(kind).carriesCopy && typeof step.template === 'string' ? step.template : '',
      // Read against the steps ALREADY normalised, which are exactly the ones
      // that came before it: a condition naming a later step, a step that is
      // not here, or a value outside the closed five is dropped rather than
      // carried into the builder as a branch nothing could ever decide.
      condition: normalizeCondition(step.condition, normalized)
    });
  });
  return normalized.sort((a, b) => a.day - b.day);
}

/** Null is the honest spelling of "runs unconditionally", and `always` means the same thing. */
function normalizeCondition(value: unknown, earlier: readonly EditableSequenceStep[]): StepCondition | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StepCondition>;
  const on = typeof candidate.on === 'string' && (LINKEDIN_BRANCH_ON as readonly string[]).includes(candidate.on)
    ? candidate.on as BranchOn
    : null;
  const ofStepId = typeof candidate.ofStepId === 'string' ? candidate.ofStepId.trim() : '';
  if (!on || on === 'always' || !ofStepId) return null;
  return earlier.some((step) => step.id === ofStepId) ? { on, ofStepId } : null;
}

/**
 * Did enrichment fail on this field?
 *
 * `degraded` entries are DOTTED FIELD PATHS -- `icp.role`, `offer.mechanism` --
 * exactly as `briefFromProfile` writes them, so this matches that one shape and
 * nothing else. Matching a bare `role` too would have made an `offer.role` that
 * does not exist blank out the ICP's, and case-folding a path the server
 * generates was a guess at a promise nobody made.
 */
function isDegraded(degraded: string[], group: 'icp' | 'offer', field: string): boolean {
  return degraded.includes(`${group}.${field}`);
}

/**
 * Prefill the brief from a draft.
 *
 * A field named in `degraded` is written EMPTY even when the response carries
 * something for it. That is the whole point of the list: whatever is there was
 * not determined, and the screen does not pass it off as if it were.
 */
function applyDraftBrief(
  current: CampaignBrief,
  brief: LinkedInCampaignDraft['brief'] | undefined,
  degraded: string[]
): CampaignBrief {
  const icp = brief?.icp ?? {};
  const offer = brief?.offer ?? {};
  const text = (group: 'icp' | 'offer', field: string, value: unknown) =>
    isDegraded(degraded, group, field) || typeof value !== 'string' ? '' : value;
  return {
    ...current,
    role: text('icp', 'role', icp.role),
    segment: text('icp', 'segment', icp.segment),
    pain: text('icp', 'pain', icp.pain),
    offerName: text('offer', 'name', offer.name),
    summary: text('offer', 'summary', offer.summary),
    mechanism: text('offer', 'mechanism', offer.mechanism),
    url: text('offer', 'url', offer.url),
    proof: isDegraded(degraded, 'offer', 'proof') || !Array.isArray(offer.proof)
      ? ''
      : offer.proof
        .filter((entry) => entry && typeof entry.label === 'string' && typeof entry.value === 'string')
        .map((entry) => `${entry.label}: ${entry.value}`).join('\n')
  };
}


/**
 * Lay proposed fields over the blanks they were proposed for.
 *
 * ONLY OVER BLANKS. A field the site stated wins over a field a model guessed,
 * every time -- `offer.summary` came off the page with an evidence row behind
 * it, and overwriting it with something that reads better would throw away the
 * only part of this brief a recipient could check.
 */
function applySuggestedBrief(brief: CampaignBrief, suggested: LinkedInCampaignDraft['suggested']): CampaignBrief {
  if (!suggested) return brief;
  const fill = (current: string, proposed: unknown) =>
    current.trim() || (typeof proposed === 'string' ? proposed.trim() : '');
  return {
    ...brief,
    role: fill(brief.role, suggested.role),
    segment: fill(brief.segment, suggested.segment),
    pain: fill(brief.pain, suggested.pain),
    mechanism: fill(brief.mechanism, suggested.mechanism)
  };
}

/** Which fields a suggestion actually filled, by the label the form uses. */
function suggestedFieldLabels(suggested: LinkedInCampaignDraft['suggested']): string[] {
  if (!suggested) return [];
  return ([['role', 'Role'], ['segment', 'Segment'], ['pain', 'Pain'], ['mechanism', 'Mechanism']] as const)
    .filter(([key]) => suggested[key]?.trim())
    .map(([, label]) => label);
}

/**
 * The ceiling this campaign's chosen kind is actually bound by, today.
 *
 * Safety computes "12 invites left today, bound by warm-up-week-2" and then the
 * form that sets a horizon rendered nothing about it -- the product worked out
 * the constraint and hid it from the field that violates it. Shown inline,
 * confidence tag and binding rule intact, or said plainly to be unknown.
 */
function BindingCeiling({ limits, kind }: { limits: LinkedInLimitsReport | null; kind: PacedKind }) {
  const ceiling: LinkedInCeiling | undefined = limits?.limits
    .find((limit) => limit.kind === kind && limit.window === 'day');
  if (!ceiling) {
    return <small className="li-hint">
      No seat is configured, so no ceiling applies yet. Safety will name the rule that binds once one is.
    </small>;
  }
  return <small className="li-hint">
    {ceiling.remaining} of {ceiling.ceiling} {KIND_LABELS[kind].toLowerCase()} left today, bound by{' '}
    {humanizeRule(ceiling.boundBy)}. The horizon spreads targets across days; it never raises that number, so a horizon
    too short for the list simply plans fewer of them.{' '}
    <ConfidenceTag confidence={ceiling.confidence} source={ceiling.source} compact />
  </small>;
}

/**
 * `#/outreach/campaigns` -- assemble a campaign, and read how the others did.
 *
 * The ceilings are read here rather than handed down: this screen is its own
 * route now, and `BindingCeiling` below is the whole reason it wants them --
 * the product computes “N of M left today, bound by <rule>” and used to hide
 * that from the one field that violates it.
 */
export function OutreachCampaigns({ setToast, campaignId = null }: {
  setToast: (message: string) => void;
  /** From `#/outreach/campaigns/:id`. A link to a campaign has to open it. */
  campaignId?: string | null;
}) {
  const { limits } = useSeatLimits();
  const [campaigns, setCampaigns] = useState<LinkedInCampaign[]>([]);
  const [detail, setDetail] = useState<LinkedInCampaignDetail | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [targets, setTargets] = useState('');
  const [contacts, setContacts] = useState<ExportContact[]>([]);
  const [steps, setSteps] = useState<EditableSequenceStep[]>([]);
  const [brief, setBrief] = useState<CampaignBrief>(EMPTY_BRIEF);
  const [briefOpen, setBriefOpen] = useState(false);
  const [degraded, setDegraded] = useState<string[]>([]);
  /** null means the picker has never been opened; [] means it opened and there was nothing. */
  const [templates, setTemplates] = useState<LinkedInSequenceTemplate[] | null>(null);
  /**
   * Lead sourcing, read from the builder rather than only handed to it.
   *
   * `stageTargets` still works, but it is a one-shot in-memory handoff that a
   * reload drops -- so it cannot be the only way stored people reach this
   * field. Same two reads the Leads screen makes, one panel closer to the
   * campaign they are for. Null means the picker has never been opened.
   */
  const [leadSources, setLeadSources] = useState<LinkedInLeadSource[] | null>(null);
  /** The server's own sentence when lead sourcing is off. Rendered verbatim. */
  const [leadSourcingOff, setLeadSourcingOff] = useState<string | null>(null);
  /**
   * Brief fields a model PROPOSED rather than the site stating them.
   *
   * Held separately from `brief` so the screen can say which is which. Cleared
   * the moment the operator edits anything, because a field they rewrote is
   * theirs and labelling it "suggested" after that would be wrong.
   */
  const [suggestedFields, setSuggestedFields] = useState<string[]>([]);
  /**
   * What the server says a sequence may contain. Read once, on mount, because
   * the branch control has to render the right five values before anybody
   * opens a template picker -- and because a client that hardcodes them drifts
   * from the server that validates them.
   */
  const [sequenceConfig, setSequenceConfig] = useState<LinkedInSequenceConfig | null>(null);
  /** The campaign the builder writes back to. Null while assembling a new one. */
  const [boundId, setBoundId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [format, setFormat] = useState<ExportFormat>('dripify');
  /** The step whose delete is waiting on a confirmation. One drawer serves every card. */
  const [confirmRemove, setConfirmRemove] = useState<EditableSequenceStep | null>(null);
  const copyRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const loadList = async () => {
    try { setCampaigns(await getLinkedInCampaigns()); }
    catch (err) { setError(errorMessage(err, 'Unable to load LinkedIn campaigns')); }
  };

  /** Opening a campaign BINDS the builder to it: what you edit below is that campaign's sequence. */
  const openCampaign = async (id: string) => {
    setBusy(id);
    try {
      const next = await getLinkedInCampaign(id);
      setDetail(next);
      setBoundId(next.campaign?.id ?? id);
      setName(next.campaign?.name ?? '');
      setSteps(normalizeSteps(next.campaign?.sequence));
      setTemplates(null);
      setError('');
    }
    catch (err) { setError(errorMessage(err, 'Unable to load that campaign')); }
    finally { setBusy(null); }
  };

  // A link to a campaign has to open it. Guarded on `boundId` so editing the
  // campaign you are already bound to never reloads it out from under you.
  useEffect(() => {
    if (!campaignId || campaignId === boundId) return;
    void openCampaign(campaignId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  const startNew = () => {
    setDetail(null);
    setBoundId(null);
    setName('');
    setDomain('');
    setTargets('');
    setContacts([]);
    setSteps([]);
    setBrief(EMPTY_BRIEF);
    setDegraded([]);
    setTemplates(null);
    setError('');
  };

  useEffect(() => { void loadList(); }, []);

  useEffect(() => {
    // A failed read is not worth an error banner: `branchOnOptions` falls back
    // to the five values this build already knows, and the rest of the screen
    // does not depend on it.
    void (async () => {
      try { setSequenceConfig(await getLinkedInSequenceConfig()); }
      catch { /* the branch vocabulary has a local fallback */ }
    })();
  }, []);

  /**
   * Targets handed over from lead sourcing.
   *
   * Taken exactly once, appended rather than replacing, and it creates
   * nothing: they land in the field the operator is about to read, and they
   * can still cut the list before naming the campaign.
   */
  useEffect(() => {
    const staged = takeStagedTargets();
    if (staged.length === 0) return;
    setTargets((current) => [...new Set([...splitTargets(current), ...staged])].join('\n'));
    setToast(`${staged.length} profile URL(s) from lead sourcing are in the targets field below. `
      + 'Nothing is saved until you create the campaign.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Re-read on the shell's Refresh, and after anything anywhere changed the
   * ledger. The open campaign is re-read with the list: a detail pane showing
   * an approval that was decided in another tab is the one stale thing on this
   * screen that could cost something.
   */
  useOutreachRefresh(async () => {
    await loadList();
    if (boundId) await openCampaign(boundId);
  });

  /* ---- the builder ---------------------------------------------------- */

  const updateStep = (id: string, patch: Partial<EditableSequenceStep>) =>
    setSteps((current) => current.map((step) => step.id === id ? { ...step, ...patch } : step));

  const sortSteps = () => setSteps((current) => [...current].sort((a, b) => a.day - b.day));

  /**
   * Move a card, and move its day with it.
   *
   * Swapping positions alone would leave the list out of day order, which is
   * the one thing the list promises. Swapping the day values back is what an
   * operator means by "earlier": the step moves, the schedule does not shuffle.
   */
  const moveStep = (id: string, direction: -1 | 1) => setSteps((current) => {
    const index = current.findIndex((step) => step.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current];
    next[index] = { ...current[target], day: current[index].day };
    next[target] = { ...current[index], day: current[target].day };
    return next;
  });

  /**
   * Delete a step, and clear every branch that was waiting on it.
   *
   * Leaving them would be a save the server refuses, naming a step the
   * operator just deleted -- and "this branch has nothing to wait on any more"
   * is a fact about the deletion, not a mistake to make them find.
   */
  const removeStep = (id: string) => setSteps((current) => current
    .filter((step) => step.id !== id)
    .map((step) => step.condition?.ofStepId === id ? { ...step, condition: null } : step));

  const addStep = (kind: SequenceStepKind) => setSteps((current) => [...current, {
    id: nextStepId(current),
    day: current.length === 0 ? 0 : current[current.length - 1].day + 2,
    kind,
    intent: '',
    template: '',
    // Unconditional, like every step that has ever existed in this product.
    condition: null
  }]);

  /** Insert at the caret, not at the end -- a merge field belongs mid-sentence. */
  const insertMerge = (id: string, field: string) => {
    const element = copyRefs.current[id];
    const token = `{{${field}}}`;
    const start = element?.selectionStart ?? null;
    const end = element?.selectionEnd ?? null;
    setSteps((current) => current.map((step) => {
      if (step.id !== id) return step;
      const from = start ?? step.template.length;
      const to = end ?? step.template.length;
      return { ...step, template: `${step.template.slice(0, from)}${token}${step.template.slice(to)}` };
    }));
    requestAnimationFrame(() => {
      if (!element) return;
      const caret = (start ?? element.value.length) + token.length;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  /*
   * A cleared branch is sent as NO FIELD rather than as null.
   *
   * Both mean unconditional to the server, and omitting it keeps the posted
   * bytes identical to what every unbranched sequence has always posted --
   * which matters because an approval binds the hash of those bytes.
   */
  const orderedSteps = (): EditableSequenceStep[] => [...steps].sort((a, b) => a.day - b.day)
    .map(({ condition, ...rest }) => ({
      ...rest,
      intent: rest.intent.trim(),
      template: rest.template.trim(),
      ...(condition && condition.on !== 'always' ? { condition } : {})
    }));

  const rejectedFields = [...new Set(steps.flatMap((step) => unknownMergeFields(step.template)))];
  const branchOn = branchOnOptions(sequenceConfig?.branchOn ?? null);
  const branchIssues = steps
    .map((step, index) => ({ step, problem: branchProblem(steps, index) }))
    .filter((entry): entry is { step: EditableSequenceStep; problem: string } => entry.problem !== null);

  /* ---- drafting ------------------------------------------------------- */

  const draftSequence = async (templateId?: string) => {
    if (!domain.trim()) {
      setError('Add your domain first — the draft is written from what is on it.');
      return;
    }
    const list = splitTargets(targets);
    setBusy('draft');
    setError('');
    try {
      const result = await draftLinkedInCampaign({
        domain: domain.trim(),
        ...(list.length > 0 ? { targets: list } : {}),
        ...(templateId ? { templateId } : {})
      });
      const missing = Array.isArray(result?.degraded) ? result.degraded.map(String) : [];
      setDegraded(missing);
      setSteps(normalizeSteps(result?.sequence?.steps));
      // The read fields first, then the proposed ones on top of the blanks they
      // are proposals FOR. Never the other way round: a suggestion must not
      // overwrite something the site actually said.
      const suggested = result?.suggested;
      setBrief((current) => applySuggestedBrief(applyDraftBrief(current, result?.brief, missing), suggested));
      setSuggestedFields(suggestedFieldLabels(suggested));
      setTemplates(null);
      const filled = suggestedFieldLabels(suggested).length;
      setToast(filled > 0
        ? `Draft ready. ${filled} field(s) the site does not state were SUGGESTED from it — read them before they go anywhere, `
          + 'and clear any you disagree with. Nothing about your offer’s proof was suggested.'
        : missing.length > 0
          ? `Draft ready. ${missing.length} brief field(s) came back empty — enrichment could not determine them and nothing was guessed.`
          : 'Draft ready. Every step below is editable, and nothing is saved until you create the campaign.');
    } catch (err) {
      setError(errorMessage(err, 'Unable to draft that campaign'));
    } finally { setBusy(null); }
  };

  const toggleTemplates = async () => {
    if (templates !== null) { setTemplates(null); return; }
    if (sequenceConfig) { setTemplates(sequenceConfig.templates); return; }
    setBusy('templates');
    setError('');
    try {
      const config = await getLinkedInSequenceConfig();
      setSequenceConfig(config);
      setTemplates(config.templates);
    }
    catch (err) { setError(errorMessage(err, 'Unable to load sequence templates')); }
    finally { setBusy(null); }
  };

  const useTemplate = (template: LinkedInSequenceTemplate) => {
    setSteps(normalizeSteps(template?.steps));
    setTemplates(null);
    setToast(`Loaded “${template?.name ?? 'template'}”. Every line is yours to edit — nothing is saved yet.`);
  };

  /**
   * Open (or close) the list of walks lead sourcing has stored.
   *
   * Read every time it opens rather than cached: a walk finishing is the whole
   * reason to look again, and the list is a handful of rows.
   */
  const toggleLeadSources = async () => {
    if (leadSources !== null) { setLeadSources(null); return; }
    setBusy('leads');
    setError('');
    try {
      const result = await getLinkedInLeadSources(50);
      setLeadSources(result.sources);
      setLeadSourcingOff(result.offReason);
    }
    catch (err) { setError(errorMessage(err, 'Unable to read the lead sources')); }
    finally { setBusy(null); }
  };

  /**
   * Append one walk's people to the targets field.
   *
   * APPENDED AND DEDUPED, never replacing: a campaign assembled from two
   * searches is a normal thing to want, and a click that silently discarded a
   * typed list would be the expensive kind of surprise. Creates nothing --
   * exclusions are still applied where the plan is produced.
   */
  const pullLeadSource = async (source: LinkedInLeadSource) => {
    setBusy(`leads:${source.id}`);
    setError('');
    try {
      const result = await getLinkedInLeads(source.id, 500);
      const pulled = result.leads.map((lead) => lead.profileUrl).filter(Boolean);
      if (pulled.length === 0) {
        setToast('That walk stored nobody, so nothing was added. Nothing is invented to fill the gap.');
        return;
      }
      const before = splitTargets(targets);
      const merged = [...new Set([...before, ...pulled])];
      setTargets(merged.join('\n'));
      const added = merged.length - before.length;
      setToast(`${added} profile URL(s) added to targets (${pulled.length - added} already there). `
        + 'Nothing is saved until you create the campaign.');
      setLeadSources(null);
    }
    catch (err) { setError(errorMessage(err, 'Unable to read the people that source found')); }
    finally { setBusy(null); }
  };

  const uploadTargets = async (file: File) => {
    setBusy('import');
    setError('');
    try {
      const result = await importLinkedInTargets(file, brief.kind);
      setTargets(result.targets.join('\n'));
      setContacts(result.contacts);
      setToast(`${result.parsed} row(s) read, ${result.targets.length} usable. `
        + `${result.excluded.length} excluded, ${result.alreadyContacted.length} already contacted, ${result.skippedRows.length} unreadable. Nothing was saved.`);
    } catch (err) {
      setError(errorMessage(err, 'Unable to read that CSV'));
    } finally { setBusy(null); }
  };

  /* ---- create and save ------------------------------------------------ */

  const create = async () => {
    const list = splitTargets(targets);
    if (!name.trim() || list.length === 0) {
      setError('A campaign needs a name and at least one target.');
      return;
    }
    if (rejectedFields.length > 0) {
      setError(`Remove the merge fields the server does not accept: ${rejectedFields.map((field) => `{{${field}}}`).join(', ')}.`);
      return;
    }
    if (branchIssues.length > 0) {
      setError(`Fix the branch on step ${branchIssues[0].step.id}: ${branchIssues[0].problem}`);
      return;
    }

    /*
     * ONE POST. THE COPY GOES UP WITH THE CAMPAIGN.
     *
     * Steps assembled here -- from a template, from the AI draft, or typed by
     * hand -- ARE the campaign's sequence, and the route takes them directly.
     * This used to be a create followed immediately by an edit, which meant two
     * playbook runs, two approvals, and a generated sequence nobody asked for
     * being thrown away a moment after it was written.
     *
     * With no steps at all there is nothing to post, so the brief becomes the
     * input again and the server drafts from it. That is the only path the
     * brief is still required for.
     */
    const assembled = orderedSteps();
    const missing = DRAFTABLE_BRIEF.filter(([field]) => !String(brief[field]).trim()).map(([, label]) => label);
    if (assembled.length === 0 && missing.length > 0) {
      setError('Add a step below, start from a template, or draft one with AI — a campaign is its sequence. '
        + `To have Trevra draft it from the brief instead, that still needs: ${missing.join(', ')}.`);
      return;
    }

    const shared = {
      targets: list,
      tone: brief.tone,
      includeInMail: brief.includeInMail,
      inviteNote: brief.inviteNote,
      kind: brief.kind,
      horizonDays: brief.horizonDays,
      format: brief.format,
      ...(contacts.length > 0 ? { contacts } : {})
    };

    setBusy('create');
    setError('');
    try {
      const created = await createLinkedInCampaign({
        name: name.trim(),
        input: assembled.length > 0
          ? { ...shared, sequenceSteps: assembled }
          : {
            ...shared,
            icp: { role: brief.role.trim(), segment: brief.segment.trim(), pain: brief.pain.trim() },
            offer: {
              name: brief.offerName.trim(),
              summary: brief.summary.trim(),
              mechanism: brief.mechanism.trim(),
              proof: parseProof(brief.proof),
              ...(brief.url.trim() ? { url: brief.url.trim() } : {})
            }
          }
      });
      const note = created.excluded.length > 0
        ? `Campaign created. ${created.excluded.length} target(s) skipped: on the exclusion list.`
        : 'Campaign created.';
      setToast(`${note} Approve the plan to export it.`);
      await loadList();
      await openCampaign(created.campaign.id);
    } catch (err) {
      setError(errorMessage(err, 'Unable to create that campaign'));
    } finally { setBusy(null); }
  };

  const saveSequence = async () => {
    if (!boundId) return;
    if (steps.length === 0) { setError('A sequence needs at least one step.'); return; }
    if (rejectedFields.length > 0) {
      setError(`Remove the merge fields the server does not accept: ${rejectedFields.map((field) => `{{${field}}}`).join(', ')}.`);
      return;
    }
    if (branchIssues.length > 0) {
      setError(`Fix the branch on step ${branchIssues[0].step.id}: ${branchIssues[0].problem}`);
      return;
    }
    setBusy('save');
    setError('');
    try {
      const saved = await saveLinkedInCampaignSequence(boundId, orderedSteps());
      setToast(saved.approvalInvalidated
        ? 'Sequence saved. It was re-planned, so any approval given before this has to be given again.'
        : 'Sequence saved and re-planned.');
      // The list, the open campaign, the ceilings and the per-campaign table
      // below are all describing something that just changed.
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to save that sequence'));
    } finally { setBusy(null); }
  };

  const decide = async (campaignId: string, run: PlaybookRun, step: PlaybookStepRun, decision: 'approve' | 'reject') => {
    setBusy(`decide-${step.stepId}`);
    try {
      await decidePlaybookStep(run.id, step.stepId, decision);
      setToast(decision === 'approve'
        ? 'Plan approved. The approval is bound to the exact bytes you read; a changed plan would need a new one.'
        : 'Plan rejected. Nothing was exported.');
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to record that decision'));
    } finally { setBusy(null); }
  };

  const runExport = async (campaignId: string) => {
    setBusy('export');
    try {
      const result = await exportLinkedInCampaign(campaignId, format);
      setToast(result.rendered
        ? `Rendered ${result.export.filename}. ${result.recorded?.written ?? 0} slot(s) filed as exported, ${result.recorded?.duplicate ?? 0} duplicate.`
        : `Already rendered from these exact approved bytes — same file, no second ledger write.`);
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to export that campaign'));
    } finally { setBusy(null); }
  };

  const stop = async (campaignId: string) => {
    setBusy('stop');
    try {
      const result = await stopLinkedInCampaign(campaignId);
      setToast(`Campaign stopped. ${result.releasedActions} queued slot(s) released. This stops one campaign, not the seat — Pause everything, in the stop bar at the top of every screen, does that.`);
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to stop that campaign'));
    } finally { setBusy(null); }
  };

  const sequence = detail ? asSequence(detail.campaign.sequence) : null;
  const approval = detail?.run?.steps.find((step) => step.stepType === 'approval') ?? null;
  const lastDay = steps.length > 0 ? steps[steps.length - 1].day : 0;

  return <div className="page-stack">
    {error && <div className="error-banner">{error}</div>}

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Campaigns</h3>
        </div>
        {boundId && <button className="ghost-button" onClick={startNew}><Plus size={14} /> New campaign</button>}
      </div>
      {campaigns.length === 0
        ? <p className="empty-copy">No campaigns yet. Name one below, then draft a sequence or assemble it step by step.</p>
        : <div className="li-campaign-list">
          {campaigns.map((campaign) => <button
            key={campaign.id}
            className={`li-campaign-row ${detail?.campaign.id === campaign.id ? 'is-open' : ''}`}
            onClick={() => void openCampaign(campaign.id)}
          >
            <span className="li-campaign-name">{campaign.name}</span>
            <span className={`li-chip li-campaign-${campaign.status}`}>{campaign.status}</span>
            <span className="li-campaign-date">{new Date(campaign.createdAt).toLocaleDateString()}</span>
            {busy === campaign.id && <LoaderCircle className="spin" size={14} />}
          </button>)}
        </div>}
    </section>

    {/* How the campaigns above did, absorbed from the Analytics tab. It is the
        question you ask with the list already in front of you, and it used to
        be two clicks and a different window away. Held back on an empty
        workspace: one “nothing yet” panel is honest, two is a wall. */}
    {campaigns.length > 0 && <LinkedInCampaignBreakdown />}
    {detail && <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>{detail.campaign.name}</h3>
          <p>
            {detail.run ? `Run ${detail.run.id} · ${detail.run.status.replaceAll('_', ' ')}` : 'No playbook run attached.'}
            {detail.campaign.stopRequestedAt && ' · stop requested'}
          </p>
        </div>
        <div className="li-detail-actions">
          <select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)} aria-label="Export format">
            {LINKEDIN_EXPORT_FORMATS.map((option) => <option key={option} value={option}>{EXPORT_FORMAT_LABELS[option]}</option>)}
          </select>
          <button className="secondary-button" disabled={busy === 'export'} onClick={() => void runExport(detail.campaign.id)}>
            {busy === 'export' ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />} Render export
          </button>
          <button className="ghost-button" disabled={busy === 'stop' || detail.campaign.status === 'stopped'} onClick={() => void stop(detail.campaign.id)}>
            <CircleStop size={14} /> Stop campaign
          </button>
        </div>
      </div>

      {approval && <ApprovalBlock
        step={approval}
        busy={busy === `decide-${approval.stepId}`}
        onDecide={(decision) => detail.run && void decide(detail.campaign.id, detail.run, approval, decision)}
      />}

      <h4 className="li-subhead">Sequence</h4>
      {sequence
        ? <>
          <SequenceNotes sequence={sequence} />
          <p className="li-hint">
            {sequence.steps.length} step(s), loaded into the builder below. Edit them there and save.
          </p>
        </>
        : <p className="empty-copy">This campaign has no sequence yet — its run has not produced one.</p>}

      {detail.exports.length > 0 && <>
        <h4 className="li-subhead">Exports</h4>
        <div className="li-table-scroll">
          <table className="li-table">
            <thead><tr><th>File</th><th>Format</th><th>Status</th><th>Size</th><th>Rendered</th><th /></tr></thead>
            <tbody>{detail.exports.map((record) => <tr key={record.id}>
              <td>{record.filename}</td>
              <td>{record.format}</td>
              <td>{record.status}</td>
              <td className="li-num">{record.size}</td>
              <td>{new Date(record.createdAt).toLocaleString()}</td>
              <td><a className="li-link" href={linkedInExportDownloadPath(record.campaignId, record.id)}>Download</a></td>
            </tr>)}</tbody>
          </table>
        </div>
      </>}

      <h4 className="li-subhead">Filed actions ({detail.actions.length})</h4>
      {detail.actions.length === 0
        ? <p className="empty-copy">No slot has been filed for this campaign yet. Slots enter the ledger when an approved plan is exported.</p>
        : <div className="li-table-scroll">
          <table className="li-table">
            <thead><tr><th>Target</th><th>Kind</th><th>Status</th><th>Planned for</th></tr></thead>
            <tbody>{detail.actions.slice(0, 50).map((action) => <tr key={action.id}>
              <td className="li-target">{action.targetRef ?? '—'}</td>
              <td>{ACTION_KIND_LABELS_ONE[action.kind]}</td>
              <td><span className={`li-chip li-status-${action.status}`}>{actionStatusLabel(action.status)}</span></td>
              <td>{action.plannedFor ? new Date(action.plannedFor).toLocaleString() : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>}
    </section>}

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>{boundId ? 'Editing an existing campaign' : 'New campaign'}</h3>
          <p>{boundId
            ? 'The builder below is bound to the open campaign. Saving writes these steps back to it.'
            : 'A name, your domain, and who to reach. The copy is written below — the brief is optional and only steers the AI draft.'}</p>
        </div>
      </div>

      <div className="li-form-grid">
        <label>Campaign name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Q3 RevOps founders" /></label>
        <label>Your domain<input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="trevra.com" /></label>
      </div>

      <div className="li-form-grid">
        <label className="li-span-2">Targets — one handle or profile URL per line
          <textarea rows={6} value={targets} onChange={(event) => setTargets(event.target.value)} />
        </label>
        <div className="li-form-side">
          <button
            className="secondary-button"
            type="button"
            disabled={busy === 'leads'}
            onClick={() => void toggleLeadSources()}
          >
            {busy === 'leads' ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}
            {leadSources !== null ? ' Hide lead sources' : ' Pull from lead sourcing'}
          </button>
          <label className="file-picker">
            {busy === 'import' ? <LoaderCircle className="spin" size={15} /> : <FileUp size={15} />}
            <span>&nbsp;Import a target CSV</span>
            <input type="file" accept=".csv,text/csv" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadTargets(file);
              event.target.value = '';
            }} />
          </label>
          <p className="panel-note">
            The import persists nothing. It reads the file, drops anyone on the exclusion list, reports who this seat has
            already contacted, and leaves the usable list here for you to read before any of it becomes a plan.
            {contacts.length > 0 && <> {contacts.length} contact record(s) held for the export’s merge fields.</>}
          </p>
        </div>
      </div>

      {/* The picker renders under the field it fills, and its refusal renders
          as an explanation rather than an error: lead sourcing being off is a
          deliberate posture set in config, not a fault of this click. */}
      {leadSources !== null && <div className="li-lead-picker">
        {leadSourcingOff && <div className="li-degraded">
          <strong>Lead sourcing is off, on purpose.</strong>
          <p>{leadSourcingOff}</p>
          <p>Walks already stored are still listed below; only queueing a new one is refused.</p>
        </div>}
        {leadSources.length === 0
          ? <p className="empty-copy">No source has been walked yet. Queue one on Outreach → Leads, then pull it in here.</p>
          : <div className="li-source-list">
            {leadSources.map((source) => <button
              key={source.id}
              type="button"
              className="li-source-row"
              disabled={busy === `leads:${source.id}` || source.resultCount === 0}
              onClick={() => void pullLeadSource(source)}
            >
              <span className="li-source-top">
                <span className="li-chip">{LEAD_SOURCE_KINDS[source.kind] ?? source.kind}</span>
                <span className={`li-chip li-lead-${source.status}`}>{LEAD_SOURCE_STATUS[source.status] ?? source.status}</span>
                <span className="li-source-count">
                  {busy === `leads:${source.id}`
                    ? 'Reading…'
                    : source.resultCount === 0 ? 'nobody stored' : `Pull ${source.resultCount} →`}
                </span>
              </span>
              <span className="li-source-url">{shortSourceUrl(source.url)}</span>
            </button>)}
          </div>}
        <p className="panel-note">
          Pulling appends the profile URLs this walk stored to the field above and creates nothing. Exclusions are
          applied where the plan is produced, so anyone who asked to be left alone is dropped before a payload exists.
        </p>
      </div>}

      <div className="li-create-actions">
        <button className="primary-button" disabled={busy === 'draft'} onClick={() => void draftSequence()}>
          {busy === 'draft' ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Draft with AI
        </button>
        <button className="secondary-button" disabled={busy === 'templates'} onClick={() => void toggleTemplates()}>
          {busy === 'templates' ? <LoaderCircle className="spin" size={15} /> : <LayoutTemplate size={15} />} Start from a template
        </button>
        <small className="li-hint">Both fill the builder below, and both are a starting point — every step stays editable.</small>
      </div>

      {templates !== null && (templates.length === 0
        ? <p className="empty-copy">No sequence templates are published yet. Add steps by hand below, or draft one.</p>
        : <div className="li-template-list">
          {templates.map((template) => <article className="li-template-card" key={template?.id ?? template?.name}>
            <div>
              <strong>{template?.name ?? 'Untitled template'}</strong>
              <p>{template?.description ?? ''}</p>
              <div className="li-template-steps">
                {(Array.isArray(template?.steps) ? template.steps : []).map((step, index) => <span
                  className="li-chip"
                  key={`${template?.id ?? 'template'}-${step?.id ?? index}`}
                >
                  Day {Number.isFinite(Number(step?.day)) ? Number(step.day) : 0} · {stepKindMeta(step?.kind).label}
                </span>)}
              </div>
            </div>
            <button className="secondary-button" onClick={() => useTemplate(template)}>Use this</button>
          </article>)}
        </div>)}

      <details className="li-brief-fold" open={briefOpen} onToggle={(event) => setBriefOpen(event.currentTarget.open)}>
        <summary><Sparkles size={13} /> Fine-tune the brief</summary>
        <p className="li-hint">
          The tone, kind, horizon and format below always travel with the campaign. The ICP and offer do not: they are
          only read when there are no steps to post, and the server drafts a sequence from them instead. Assemble the
          sequence below and none of that is needed.
        </p>

        {/* Two different statements, and they must not be one block. The first
            is "the site did not say this"; the second is "so a model guessed,
            and here is what it guessed". A field can be in both. */}
        {degraded.length > 0 && <div className="li-degraded">
          <strong>Enrichment could not determine {degraded.length} field(s)</strong>
          <ul>{degraded.map((field) => <li key={field}>{field}</li>)}</ul>
          <p>
            They are not stated on your site. {suggestedFields.length > 0
              ? 'Some were filled below by suggestion — marked as such, and yours to correct.'
              : 'Nothing was guessed — write them yourself, or leave them blank.'}
          </p>
        </div>}

        {suggestedFields.length > 0 && <div className="li-suggested">
          <Sparkles size={14} />
          <div>
            <strong>Suggested, not read: {suggestedFields.join(', ')}</strong>
            <p>
              A model proposed these from what your site publishes, because a homepage states what a company does and
              never who it sells to. READ THEM BEFORE THEY GO ANYWHERE — they are the only fields on this screen with
              nothing behind them, and they are yours to rewrite or clear. Nothing about your proof was suggested: that
              stays bound to numbers enrichment actually counted.
            </p>
            <button className="ghost-button" type="button" onClick={() => {
              setBrief((current) => ({ ...current, role: '', segment: '', pain: '', mechanism: '' }));
              setSuggestedFields([]);
            }}>Clear the suggested fields</button>
          </div>
        </div>}

        {/* FOUR controls that always apply, then six that apply on one path
            only. Eight fields in one undifferentiated block asked the operator
            to work out which of them they were obliged to answer, and the
            answer depended on something two panels further down. */}
        <h4 className="li-subhead">Pacing and format</h4>
        <p className="li-hint">These four travel with every campaign, whichever way its copy arrives. Each already has a
          working default — change one when you have a reason to.</p>

        <div className="li-form-grid">
          <label>Tone
            <select value={brief.tone} onChange={(event) => setBrief({ ...brief, tone: event.target.value as SequenceTone })}>
              {TONES.map((tone) => <option key={tone} value={tone}>{TONE_LABELS[tone]}</option>)}
            </select>
            <Define term="Tone">how the draft addresses the target. It steers what the AI writes; it changes nothing about
              what is sent or when.</Define>
          </label>
          <label>Paced kind
            <select value={brief.kind} onChange={(event) => setBrief({ ...brief, kind: event.target.value as PacedKind })}>
              {PACED_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
            </select>
            <Define term="Paced kind">the action this campaign spends its daily budget on. Each kind carries its own
              ceiling, and Safety says which rule set it.</Define>
          </label>
          <label>Horizon (days)
            <input type="number" min={1} max={90} value={brief.horizonDays}
              onChange={(event) => setBrief({ ...brief, horizonDays: Number(event.target.value) || 1 })} />
            <BindingCeiling limits={limits} kind={brief.kind} />
          </label>
          <label>Export format
            <select value={brief.format} onChange={(event) => setBrief({ ...brief, format: event.target.value as ExportFormat })}>
              {LINKEDIN_EXPORT_FORMATS.map((option) => <option key={option} value={option}>{EXPORT_FORMAT_LABELS[option]}</option>)}
            </select>
            <Define term="Export format">which tool’s CSV an approved plan is rendered for. Trevra sends nothing; you run
              the file.</Define>
          </label>
        </div>

        {/* Folded, because the whole point of the builder below is that this is
            no longer the way in. Opened, it is honest about being all-or-nothing. */}
        <details className="li-manual-fields">
          <summary><Sparkles size={13} /> Have Trevra draft the sequence from a brief instead</summary>
          <p className="li-hint">
            Read only when there is no step below to post. The six fields marked <b>*</b> are required on this path and
            required together — the server drafts from them, and one left empty is one the draft will invent. Assemble
            the sequence yourself below and none of this is needed.
          </p>

          <div className="li-form-grid">
            <label>ICP role *<input aria-required="true" value={brief.role} onChange={(event) => setBrief({ ...brief, role: event.target.value })} placeholder="Head of RevOps" /></label>
            <label>Segment *<input aria-required="true" value={brief.segment} onChange={(event) => setBrief({ ...brief, segment: event.target.value })} placeholder="Series A B2B SaaS" /></label>
            <label className="li-span-2">Pain, in their words *<input aria-required="true" value={brief.pain} onChange={(event) => setBrief({ ...brief, pain: event.target.value })} placeholder="Pipeline reviews take a day a week and still miss slippage" /></label>
          </div>

          <div className="li-form-grid">
            <label>Offer name *<input aria-required="true" value={brief.offerName} onChange={(event) => setBrief({ ...brief, offerName: event.target.value })} /></label>
            <label>Offer URL<input value={brief.url} onChange={(event) => setBrief({ ...brief, url: event.target.value })} placeholder="https://…" /></label>
            <label className="li-span-2">What it does *<input aria-required="true" value={brief.summary} onChange={(event) => setBrief({ ...brief, summary: event.target.value })} /></label>
            <label className="li-span-2">Why it works — the mechanism, not the outcome *<input aria-required="true" value={brief.mechanism} onChange={(event) => setBrief({ ...brief, mechanism: event.target.value })} /></label>
            <label className="li-span-2">Proof, one <code>label: value</code> per line
              <textarea rows={3} value={brief.proof} onChange={(event) => setBrief({ ...brief, proof: event.target.value })} placeholder={'Cycle time: 41 days to 22\nSeats: 300'} />
            </label>
          </div>
        </details>

        <label className="li-inline-check">
          <input
            type="checkbox"
            checked={brief.inviteNote === 'none'}
            onChange={(event) => setBrief({ ...brief, inviteNote: event.target.checked ? 'none' : 'drafted' })}
          />
          <span>Send the connection request with no note</span>
        </label>
        <small className="li-hint">
          On by default. A note written before anyone has accepted anything is the most-read line in the sequence and the
          least earned; a templated one reads as templated. Unticking this asks the draft for a note you can then edit.
        </small>

        <label className="li-inline-check">
          <input type="checkbox" checked={brief.includeInMail} onChange={(event) => setBrief({ ...brief, includeInMail: event.target.checked })} />
          <span>Ask the draft for an InMail step</span>
          <ConfidenceTag confidence="HARD FACT" source="docs/linkedin-outreach-plan.md 1.1" compact />
        </label>
        <small className="li-hint">InMail is capped at 50 per seat per month by LinkedIn itself — the one published number in this product.</small>
      </details>
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Sequence</h3>
          <p>{steps.length === 0
            ? 'Empty. Draft one with AI, start from a template, or add the first step below.'
            : `${steps.length} step(s) across ${lastDay + 1} day(s), in day order. Day 0 is the day the campaign starts.`}</p>
        </div>
      </div>

      {steps.length === 0
        ? <p className="empty-copy">Nothing here yet. A sequence is a list of actions with the gap you choose between them.</p>
        : <div className="li-sequence">
          {steps.map((step, index) => <SequenceStepCard
            key={step.id}
            step={step}
            index={index}
            total={steps.length}
            branchOn={branchOn}
            anchorsFor={(on) => eligibleAnchors(steps, index, on)}
            problem={branchProblem(steps, index)}
            onChange={(patch) => updateStep(step.id, patch)}
            onMove={(direction) => moveStep(step.id, direction)}
            onRemove={() => setConfirmRemove(step)}
            onSort={sortSteps}
            bindCopy={(element) => { copyRefs.current[step.id] = element; }}
            onInsertMerge={(field) => insertMerge(step.id, field)}
          />)}
        </div>}

      <div className="li-add-step">
        <span className="li-filter-label">Add step</span>
        <div className="li-add-step-buttons">
          {STEP_KINDS.map(({ kind, label, Icon }) => <button className="li-mini-button" key={kind} onClick={() => addStep(kind)}>
            <Icon size={12} /> {label}
          </button>)}
        </div>
      </div>

      <p className="li-hint">
        <b>Follow</b>, <b>like</b> and <b>endorse</b> carry no copy, like a profile view. They are still paced by their
        own daily ceilings and still go through every safety check — liking two hundred posts in an hour is a ban signal
        however harmless one like is.{' '}
        <ConfidenceTag confidence="REPORTED" source="src/server/linkedin/limits.ts LINKEDIN_LIMITS" compact />
      </p>

      <p className="li-hint li-merge-legend">
        Merge fields are substituted by your own tool, never rendered here. These four are the whole set —
        {' '}{LINKEDIN_MERGE_FIELDS.map((field) => <code key={field}>{`{{${field}}}`}</code>)} — and the server rejects any
        other. LinkedIn truncates a connection-request note at {LINKEDIN_INVITE_NOTE_MAX_CHARS} characters.
        {' '}<ConfidenceTag confidence="HARD FACT" source="src/server/linkedin/sequence.ts INVITE_NOTE_MAX_CHARS" compact />
      </p>

      <div className="panel-footer">
        <span>{boundId
          ? 'Saving re-plans this campaign, and an approval given before it has to be given again.'
          : 'Creating posts these steps as the campaign’s sequence, runs the safety gate, and stops for your approval.'}</span>
        {boundId
          ? <button className="primary-button" disabled={busy === 'save'} onClick={() => void saveSequence()}>
            {busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} Save sequence
          </button>
          : <button className="primary-button" disabled={busy === 'create'} onClick={() => void create()}>
            {busy === 'create' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} Create campaign
          </button>}
      </div>
    </section>

    {/* A step is authored copy. One click on a 12px trash icon between two
        reorder arrows it sits flush against was the whole of the ceremony. */}
    {confirmRemove && <ConfirmDrawer
      title={`Delete the day ${confirmRemove.day} ${stepKindMeta(confirmRemove.kind).label.toLowerCase()}?`}
      tone="danger"
      body={<>
        <p>
          {confirmRemove.intent.trim()
            ? `Its stated purpose: “${confirmRemove.intent.trim()}”.`
            : 'It has no stated purpose written on it.'}
          {confirmRemove.template.trim()
            ? ` ${confirmRemove.template.trim().length} characters of copy go with it, and nothing here keeps a second copy.`
            : ' It carries no copy.'}
        </p>
        <p>{boundId
          ? 'This changes the builder only — the campaign on the server keeps its current sequence until you save.'
          : 'This changes the builder only — no campaign exists yet, so nothing on the server changes either way.'}</p>
      </>}
      confirmLabel="Delete this step"
      onConfirm={() => {
        removeStep(confirmRemove.id);
        setConfirmRemove(null);
        setToast(`Step deleted from the builder. ${boundId ? 'The saved campaign is unchanged until you save the sequence.' : 'Nothing was saved.'}`);
      }}
      onCancel={() => setConfirmRemove(null)}
    />}
  </div>;
}

/**
 * One action node.
 *
 * The day control is a delay, not a date: `Day 2` means two days after the
 * campaign starts, and the plan engine is the only thing that turns that into
 * a calendar instant inside the seat's own business hours.
 */
function SequenceStepCard({ step, index, total, branchOn, anchorsFor, problem, onChange, onMove, onRemove, onSort, bindCopy, onInsertMerge }: {
  step: EditableSequenceStep;
  index: number;
  total: number;
  /** The closed five, as the server published them, `always` first. */
  branchOn: readonly BranchOn[];
  /** Earlier steps that could answer a given branch. Empty means it is not offerable here. */
  anchorsFor: (on: BranchOn) => EditableSequenceStep[];
  /** What is wrong with this step's branch, in one sentence, or null. */
  problem: string | null;
  onChange: (patch: Partial<EditableSequenceStep>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onSort: () => void;
  bindCopy: (element: HTMLTextAreaElement | null) => void;
  onInsertMerge: (field: string) => void;
}) {
  const meta = stepKindMeta(step.kind);
  const { Icon } = meta;

  /**
   * A bare connection request -- no note at all.
   *
   * The server has no flag for this: an invite with an empty template IS a
   * noteless invite, all the way down to `driver.ts` `sendInvite`, which takes
   * the "send without a note" path when there is nothing to type. So this is a
   * VIEW state, seeded from the copy and never posted. It exists because an
   * empty textarea is ambiguous -- half-written or deliberately blank -- and
   * only the operator can say which. Ticking it clears the copy; unticking it
   * hands back an empty field to write in.
   */
  const [noNote, setNoNote] = useState(step.kind === 'invite' && step.template.trim().length === 0);
  const bareInvite = step.kind === 'invite' && noNote;
  const carriesCopy = meta.carriesCopy && !bareInvite;

  const overLimit = step.kind === 'invite' && step.template.length > LINKEDIN_INVITE_NOTE_MAX_CHARS;
  const rejected = carriesCopy ? unknownMergeFields(step.template) : [];

  const condition = step.condition && step.condition.on !== 'always' ? step.condition : null;
  const anchors = condition ? anchorsFor(condition.on) : [];
  // A first step has nothing earlier to wait on, so it is offered no control at
  // all rather than a dropdown whose only option is the default.
  const canBranch = index > 0;

  /**
   * Picking `Always` clears the branch rather than storing it.
   *
   * Null and `always` mean the same thing to the server, and null is the
   * honest spelling: it is what every step in this product was before
   * branching existed, and it keeps the posted bytes identical to what an
   * unbranched sequence has always posted.
   */
  const changeBranch = (on: BranchOn) => {
    if (on === 'always') { onChange({ condition: null }); return; }
    const candidates = anchorsFor(on);
    if (candidates.length === 0) { onChange({ condition: null }); return; }
    const keep = condition && candidates.some((candidate) => candidate.id === condition.ofStepId)
      ? condition.ofStepId
      // The nearest earlier step that can answer, because that is what an
      // operator means by "if that worked".
      : candidates[candidates.length - 1].id;
    onChange({ condition: { on, ofStepId: keep } });
  };

  return <article className={`li-step li-step-card${condition ? ' li-step-branched' : ''}`}>
    <header>
      <span className={`li-chip li-kind-chip li-kind-${step.kind}`}><Icon size={12} /> {meta.label}</span>
      {condition && <span className="li-chip li-branch-chip">
        <CornerDownRight size={12} /> {branchSentence(condition)}
      </span>}
      <label className="li-day-control">
        <span>Day</span>
        <input
          type="number"
          min={0}
          max={90}
          value={step.day}
          aria-label={`Day offset for step ${index + 1}`}
          onChange={(event) => onChange({ day: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })}
          onBlur={onSort}
        />
      </label>
      <div className="li-step-tools">
        <button className="li-mini-button" disabled={index === 0} aria-label="Move step earlier" onClick={() => onMove(-1)}>
          <ArrowUp size={12} />
        </button>
        <button className="li-mini-button" disabled={index === total - 1} aria-label="Move step later" onClick={() => onMove(1)}>
          <ArrowDown size={12} />
        </button>
        <button className="li-mini-button li-mini-danger" aria-label="Delete step" onClick={onRemove}>
          <Trash2 size={12} />
        </button>
      </div>
    </header>

    {canBranch && <div className="li-branch-row">
      <label className="li-branch-control">
        <span>Run this step…</span>
        <select
          value={condition?.on ?? 'always'}
          aria-label={`When step ${index + 1} runs`}
          onChange={(event) => changeBranch(event.target.value as BranchOn)}
        >
          {branchOn.map((value) => {
            const unavailable = value !== 'always' && anchorsFor(value).length === 0;
            return <option key={value} value={value} disabled={unavailable}>
              {BRANCH_ON_LABELS[value]}{unavailable ? ' — no earlier step can answer this' : ''}
            </option>;
          })}
        </select>
      </label>
      {condition && <label className="li-branch-control">
        <span>…of</span>
        <select
          value={condition.ofStepId}
          aria-label={`Which earlier step step ${index + 1} waits on`}
          onChange={(event) => onChange({ condition: { on: condition.on, ofStepId: event.target.value } })}
        >
          {anchors.map((anchor) => <option key={anchor.id} value={anchor.id}>
            {anchor.id} · day {anchor.day} · {stepKindMeta(anchor.kind).label}
          </option>)}
          {/* A dangling reference stays visible rather than snapping to another
              step: the operator is told what broke, not shown a branch they
              did not write. */}
          {!anchors.some((anchor) => anchor.id === condition.ofStepId) && <option value={condition.ofStepId}>
            {condition.ofStepId} — no longer eligible
          </option>}
        </select>
      </label>}
    </div>}

    {problem && <small className="li-merge-warn">{problem}</small>}

    {step.kind === 'invite' && <label className="li-inline-check">
      <input
        type="checkbox"
        checked={noNote}
        onChange={(event) => {
          setNoNote(event.target.checked);
          if (event.target.checked) onChange({ template: '' });
        }}
      />
      <span>Send this connection request with no note</span>
    </label>}

    <div className="li-form-grid li-step-fields">
      <label className="li-span-2">What this step is for
        <input value={step.intent} onChange={(event) => onChange({ intent: event.target.value })}
          placeholder="Open the loop without pitching" />
      </label>
      {carriesCopy && <label className="li-span-2">Copy
        <textarea
          ref={bindCopy}
          rows={step.kind === 'invite' ? 3 : 6}
          value={step.template}
          onChange={(event) => onChange({ template: event.target.value })}
          placeholder={`Hi {{firstName}} — …`}
        />
      </label>}
    </div>

    {carriesCopy
      ? <>
        <div className="li-merge-row">
          {LINKEDIN_MERGE_FIELDS.map((field) => <button
            className="li-merge-button"
            key={field}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onInsertMerge(field)}
          >{`{{${field}}}`}</button>)}
          {step.kind === 'invite' && <span className={`li-count ${overLimit ? 'is-over' : ''}`}>
            {step.template.length}/{LINKEDIN_INVITE_NOTE_MAX_CHARS}
          </span>}
        </div>
        {overLimit && <small className="li-merge-warn">
          LinkedIn truncates the note at {LINKEDIN_INVITE_NOTE_MAX_CHARS} characters. A cut mid-sentence reads worse than
          one you shortened yourself.
        </small>}
        {rejected.length > 0 && <small className="li-merge-warn">
          {rejected.map((field) => `{{${field}}}`).join(', ')}{' '}
          {rejected.length === 1 ? 'is not a merge field' : 'are not merge fields'} the server accepts. Replace or remove
          before saving.
        </small>}
      </>
      : <p className="li-hint">{bareInvite
        ? 'Nothing is sent with the request. The first thing they read is the message after they accept, which is the '
          + 'only copy in this sequence anyone has agreed to receive.'
        : meta.noCopyNote ?? 'This step carries no message.'}</p>}
  </article>;
}

/**
 * What the critic said about the STORED copy.
 *
 * Kept on the campaign rather than in the builder because it is a verdict on
 * bytes the server has read, not on the ones being typed. Silent when the copy
 * passed -- an empty warning block would read as a warning.
 */
function SequenceNotes({ sequence }: { sequence: LinkedInSequence }) {
  const notes = Array.isArray(sequence.antiSlopNotes) ? sequence.antiSlopNotes : [];
  if (sequence.antiSlopPassed || notes.length === 0) return null;
  return <div className="li-warn-block">
    <CircleAlert size={16} />
    <div>
      <strong>The critic flagged {notes.length} thing(s) in this copy.</strong>
      <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
    </div>
  </div>;
}
function ApprovalBlock({ step, busy, onDecide }: {
  step: PlaybookStepRun;
  busy: boolean;
  onDecide: (decision: 'approve' | 'reject') => void;
}) {
  const waiting = step.status === 'waiting_approval';
  return <div className={`li-approval ${waiting ? 'is-waiting' : ''}`}>
    <div>
      <strong>{waiting ? 'This plan is waiting for you' : `Approval step: ${step.status.replaceAll('_', ' ')}`}</strong>
      <p>
        Approving binds the hash of the exact payload below: the plan, the copy and the format.
        {step.approvalPayloadHash && <> Payload hash <code>{step.approvalPayloadHash.slice(0, 16)}…</code></>}
      </p>
    </div>
    {/* This button BINDS a hash. It used to be the same 34px green rectangle as
        “Save cap”, which is a control that changes a number you can change back.
        Heavier, and it says what it binds rather than naming the screen it is
        on. */}
    {waiting && <div className="li-approval-actions">
      <button className="primary-button auth-submit" type="button" disabled={busy} onClick={() => onDecide('approve')}>
        {busy ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
        {step.approvalPayloadHash ? ` Approve these exact bytes · ${step.approvalPayloadHash.slice(0, 8)}…` : ' Approve these exact bytes'}
      </button>
      <button className="ghost-button" type="button" disabled={busy} onClick={() => onDecide('reject')}><X size={14} /> Reject</button>
    </div>}
  </div>;
}

/* -------------------------------------------------------------------------
 * Plan preview.
 * ---------------------------------------------------------------------- */

/**
 * The calendar of exact slots, from `POST /api/linkedin/plan`.
 *
 * A DRY RUN, and the screen says so in the place a founder looks: no slot here
 * is a `linkedin_actions` row, nothing is scheduled, and running it twice costs
 * nothing. Slots become real only downstream of a campaign approval.
 */
export function OutreachPlan({ setToast }: { setToast: (message: string) => void }) {
  const { limits } = useSeatLimits();
  const [kind, setKind] = useState<PacedKind>('invite');
  const [horizonDays, setHorizonDays] = useState(14);
  const [targets, setTargets] = useState('');
  const [result, setResult] = useState<LinkedInPlanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    const list = splitTargets(targets);
    if (list.length === 0) { setError('Add at least one target to plan.'); return; }
    setBusy(true);
    setError('');
    try {
      const response = await planLinkedIn({ kind, targets: list, horizonDays });
      setResult(response);
      setToast(`Planned ${response.plan.slots.length} slot(s) across ${horizonDays} days. Nothing was saved.`);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err, 'Unable to plan those targets'));
    } finally { setBusy(false); }
  };

  const byDay = new Map<string, LinkedInPlanResponse['plan']['slots']>();
  for (const slot of result?.plan.slots ?? []) {
    const day = slot.plannedFor.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), slot]);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const busiest = Math.max(1, ...days.map(([, slots]) => slots.length));

  return <div className="page-stack">
    <section className="li-dryrun">
      <CalendarClock size={20} />
      <div>
        <strong>This is a dry run.</strong>
        <p>
          It reads the seat’s real ledger and prices a plan against every ceiling at once, then throws the result away.
          No row is written, nothing is scheduled, and no one is contacted.
        </p>
      </div>
    </section>

    {error && <div className="error-banner">{error}</div>}

    <section className="page-panel">
      <div className="li-filter-row">
        <label>Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as PacedKind)}>
            {PACED_KINDS.map((option) => <option key={option} value={option}>{KIND_LABELS[option]}</option>)}
          </select>
        </label>
        <label>Horizon (days)
          <input type="number" min={1} max={90} value={horizonDays} onChange={(event) => setHorizonDays(Number(event.target.value) || 1)} />
        </label>
        <button className="primary-button" disabled={busy} onClick={() => void run()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} Preview plan
        </button>
      </div>
      <p className="panel-note"><BindingCeiling limits={limits} kind={kind} /></p>
      <label className="li-block-label">Targets — one handle or profile URL per line
        <textarea rows={5} value={targets} onChange={(event) => setTargets(event.target.value)} />
      </label>
    </section>

    {result && <>
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3>Why the plan looks like this</h3>
          </div>
          <ConfidenceTag confidence="REPORTED" source="docs/linkedin-outreach-plan.md 1.3 and 1.4" compact />
        </div>
        <ol className="li-reasons">{result.plan.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ol>
        <div className="li-chip-row">
          {result.plan.ceilingsApplied.map((ceiling) => <span className="li-chip" key={ceiling}>{ceiling.replaceAll('-', ' ')}</span>)}
        </div>
        {result.excluded.length > 0 && <p className="panel-note">
          {result.excluded.length} target(s) were dropped before planning because they are on the exclusion list:{' '}
          {result.excluded.map((entry) => entry.targetRef).join(', ')}. Exclusions are applied before a plan exists, never at
          send time.
        </p>}
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3>{result.plan.slots.length} slot(s) across {days.length} day(s)</h3>
            <p>Seat <code>{result.plan.seatKey}</code>. Times shown in your browser’s timezone; the engine placed them inside the seat’s own business hours.</p>
          </div>
        </div>
        {days.length === 0
          ? <p className="empty-copy">Every ceiling that applies right now leaves no room to schedule anything. The Safety screen says which rule bound.</p>
          : <div className="li-calendar">
            {days.map(([day, slots]) => <div className="li-cal-day" key={day}>
              <header>
                <strong>{new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${day}T12:00:00Z`))}</strong>
                <span>{slots.length}</span>
              </header>
              <i className="li-cal-load" style={{ width: `${(slots.length / busiest) * 100}%` }} />
              <ul>{slots.map((slot) => <li key={`${slot.plannedFor}-${slot.targetRef}`}>
                <time>{new Date(slot.plannedFor).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                <span className="li-target">{slot.targetRef}</span>
              </li>)}</ul>
            </div>)}
          </div>}
      </section>
    </>}
  </div>;
}
