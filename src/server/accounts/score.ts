import type { Db } from '../db.js';
import {
  ACCOUNT_SIGNAL_KINDS,
  type AccountScore,
  type AccountSignal,
  type AccountSignalKind,
  type AccountTier,
  type ScoreComponent,
  type ScoreRationale
} from './types.js';

/**
 * The intent scorer: the module that decides which ten companies are worth a
 * message this week, and -- far more importantly -- which four hundred are not.
 *
 * ONE RIGHT COMPANY BEATS A HUNDRED PLAUSIBLE ONES. Every number below is
 * chosen against that sentence, and the design goal is deliberately lopsided:
 * THIS SCORER IS BUILT TO BE CONFIDENTLY WRONG ABOUT MOST COMPANIES AND RIGHT
 * ABOUT THE TOP TEN. A scorer that ranks two hundred accounts at 60 has told
 * an operator nothing they did not already know -- they still have to read two
 * hundred rows. A scorer that puts six accounts above 70 and everything else
 * under 35 has done the only job worth doing, and it is allowed to be wrong
 * about the middle of the list to buy that.
 *
 * FIVE RULES, and each one is why a piece of this file exists.
 *
 * 1. A SINGLE SIGNAL IS NEVER ENOUGH. No weight in `SIGNAL_WEIGHTS` reaches the
 *    hot threshold on its own, `SINGLE_KIND_CAP` holds a one-kind score below
 *    that threshold no matter how many times the kind fired, and `tierFor`
 *    refuses 'hot' outright without two distinct kinds. Three independent
 *    mechanisms, because this is the failure that ruins the product: a careers
 *    page that added a receptionist is not a buying signal, and one false 'hot'
 *    costs more trust than ten missed 'warm's.
 *
 * 2. LAYERING IS THE THESIS. Two DIFFERENT kinds of change inside one window
 *    are worth materially more than the sum of their parts, because they were
 *    read off different surfaces and cannot both be an artefact of the same
 *    noisy detector. `COMBINATION_BONUSES` pays per PAIR of distinct kinds, and
 *    the number of pairs grows quadratically, so three kinds are "more again"
 *    than two without any special-cased third term.
 *
 * 3. A SIGNAL DECAYS FROM THE MOMENT IT POPS. `decayFor` halves a signal's
 *    worth every three weeks. "They posted four platform roles" is a reason to
 *    write today, a conversation-starter in a month, and an embarrassment in a
 *    quarter -- the same fact, and the only thing that changed is when.
 *
 * 4. VOLUME IS NOT EVIDENCE. Five `hiring-up` events off one careers page is
 *    one company hiring, observed five times. Repeats of a kind are tapered
 *    geometrically (`REPEAT_TAPER`), so a chatty detector cannot buy a ranking.
 *
 * 5. THE OPERATOR'S REJECTIONS OUTRANK THE ARITHMETIC. When a scored shape
 *    matches one the operator already called not-a-fit, it takes a penalty big
 *    enough to move a tier. Learning from a human's "no" is the cheapest
 *    precision available, and refusing to apply it is how a list stays wrong
 *    confidently in the wrong direction.
 *
 * PURE AT THE CORE. `scoreAccount` is a deterministic function of its inputs:
 * no clock, no database, no randomness, no locale. Same signals plus the same
 * `now` produce a byte-identical rationale, which is what makes "why is this an
 * 87" answerable in a month and testable exhaustively without Postgres. The
 * database functions at the bottom are a thin read-score-upsert shell around
 * it and contain no scoring judgement of their own.
 *
 * THE ARITHMETIC IS SELF-CHECKING. For every rationale this module produces,
 * `score === Math.round(rationaleTotal(rationale))` -- components, bonuses and
 * adjustments always sum to the number on the screen, including when a clamp or
 * a cap bit. A "why this score" panel that cannot be reconciled against the
 * score is a panel nobody believes twice.
 */

/* ---------------------------------------------------------------------------
 * The dials.
 * ------------------------------------------------------------------------ */

/**
 * How far back a signal can be and still count AT ALL. Sixty days is two
 * sweep-and-forget cycles: long enough that a pricing change in June still
 * corroborates a hiring burst in August, short enough that "recent" keeps
 * meaning something to the person who has to open with it.
 */
export const DEFAULT_WINDOW_DAYS = 60;

/**
 * Three weeks to lose half its worth. Chosen against the sentence an operator
 * actually sends: a change they can name to the day reads as attention, and the
 * same change at six weeks reads as a form letter with a date in it.
 */
export const DEFAULT_HALF_LIFE_DAYS = 21;

/**
 * Decay never reaches zero inside the window. A 55-day-old pricing move is
 * nearly worthless ALONE -- and that is what 0.05 buys -- but it is still real
 * corroboration when something fresh lands beside it, and zeroing it would
 * delete that from the layering count as well as from the points.
 */
export const DECAY_FLOOR = 0.05;

/**
 * What the n-th repeat of a kind keeps: full, then 35%, then 12%, then noise.
 *
 * The second `hiring-up` in a window is mostly the same news as the first,
 * because it came off the same page read by the same detector. It is not
 * NOTHING -- sustained hiring is a real pattern -- so the taper is geometric
 * rather than a hard "first one only", and a kind can contribute at most about
 * 1.54x its base however often it fires.
 */
export const REPEAT_TAPER = 0.35;

/** At or above this, and with two distinct kinds, an account is worth acting on today. */
export const HOT_SCORE = 70;

/** Below this, nothing has meaningfully moved. Deliberately high: 'warm' has to cost something. */
export const WARM_SCORE = 25;

/**
 * The ceiling on a score built from ONE kind, whatever it is and however often
 * it fired. Set below `HOT_SCORE` on purpose and by a wide margin: the tier gate
 * already refuses 'hot' without two kinds, and without this cap the ranked list
 * would still sort a 96-point single-signal 'warm' above a 71-point layered
 * 'hot' -- which is the exact mistake the tier gate exists to prevent, made one
 * column to the left.
 */
export const SINGLE_KIND_CAP = 45;

/**
 * What a shape the operator has already rejected costs. Large enough to drop a
 * layered, fresh account out of 'hot' entirely, because the operator's judgement
 * about a SHAPE ("hiring-up with a headline change, nothing else") is better
 * evidence than anything this file computes about the shape.
 */
export const REJECTED_SHAPE_PENALTY = -40;

/**
 * What an account pays when everything it has is older than one half-life.
 * "Two signals, both from six weeks ago" is a company that WAS moving; the
 * penalty is what stops it from sitting in the same band as a company that is
 * moving now, which is the only band an operator has time for.
 */
export const STALENESS_PENALTY = -12;

/** Inside a week, a signal is still something you can open a message with. */
export const FRESH_DAYS = 7;

/**
 * Base points per signal kind, before decay. The whole premise is encoded here,
 * so every number carries its argument.
 *
 * The scale is calibrated against `HOT_SCORE`: NO SINGLE KIND REACHES 70, and
 * no two of the weakest kinds do either. Reaching 'hot' requires a strong pair
 * plus its combination bonus plus recency -- which is precisely the claim
 * "several different things moved here, recently" and nothing weaker.
 */
export const SIGNAL_WEIGHTS: Record<AccountSignalKind, number> = {
  // ZERO, BY CONTRACT AND BY ARGUMENT. `first-capture` says we looked at this
  // company for the first time, which is a fact about US, not about them. A
  // baseline is the ruler, not the measurement; any weight here would score
  // every freshly imported CSV row above every quiet account we have watched
  // all year, which is exactly backwards.
  'first-capture': 0,

  // THE HIGHEST SINGLE SIGNAL WE CAN READ: public intent, in the prospect's own
  // words, timestamped and quotable. Every other kind is us INFERRING a state
  // of mind from a diff; this one is a human describing their problem in a
  // thread we can link to. It is also the only kind that makes the opening
  // sentence write itself, which is what turns a score into a sent message.
  // Still under `HOT_SCORE`: someone complaining in public is a person with a
  // problem, not yet a company with a project.
  'thread-mention': 34,

  // MONEY COMMITTED TO A PROBLEM, WITH A JOB TITLE ATTACHED. A new role is a
  // budget line that survived somebody's approval, it names the function that
  // owns our category, and it is checkable by the recipient -- the three
  // properties that make an opener land. Just below `thread-mention` because it
  // is an inference (they hired, therefore they care) rather than a statement.
  'hiring-up': 30,

  // THEY ARE REPACKAGING HOW THEY SELL. A pricing page does not change by
  // accident: someone re-tiered, re-named or re-priced, which means the
  // commercial story is open inside that company right now and there is a human
  // who owns it. Marginally under `hiring-up` only because a pricing diff can
  // be a copy edit, where a new role cannot be.
  'pricing-changed': 28,

  // POSITIONING DRIFT. Rewriting the homepage headline means the story changed
  // -- new segment, new wedge, new funding narrative -- and that is worth
  // knowing. It is MODERATE rather than strong because a story is not a
  // purchase, and because headlines get A/B tested by people whose job is
  // headlines, with no budget and no project behind the change.
  'headline-changed': 16,

  // THEY INSTALLED SOMETHING. Real, deliberate, and occasionally the perfect
  // opening ("you just put in Segment"). Moderate rather than strong for one
  // honest reason: this is our NOISIEST read. A tag manager, a CDN migration or
  // a marketing site rebuild all shake the detected stack without anyone having
  // decided anything, so it earns a seat at the table and never the head of it.
  'tech-added': 15,

  // WEAK POSITIVE, AND KEPT DELIBERATELY LOW. Ripping a tool out means a gap
  // exists, which is now and then the best opening in this entire list. But our
  // detector's false negatives MANUFACTURE this signal -- a script moved behind
  // a tag manager reads as a removal -- so it may corroborate a decision and
  // must never carry one.
  'tech-removed': 6,

  // NEGATIVE, AND THE SIGN IS THE POINT. For most sellers a shrinking team is a
  // shrinking budget and a hiring freeze upstream of it, so contraction should
  // move an account DOWN the list, not up it by virtue of having "activity".
  // Kept small (-4, not -20) because we are reading a careers page, not a P&L:
  // roles also disappear because they were filled, and a company that closes
  // three roles and changes its pricing is repositioning, not dying. The sign
  // matters far more than the magnitude -- with a negative weight, an account
  // whose only news is a contraction scores zero and is never surfaced, which
  // is the correct outcome for a seller with a finite week.
  'hiring-down': -4
};

/**
 * The canonical order kinds are considered in, so two runs over the same
 * signals emit components, pairs and shapes in the same order and the stored
 * rationale is byte-identical. Unknown kinds sort after all known ones,
 * alphabetically.
 */
const KIND_ORDER: readonly string[] = ACCOUNT_SIGNAL_KINDS;

/** How each kind is said out loud, for the generic combination sentence. */
const KIND_LABELS: Record<AccountSignalKind, string> = {
  'first-capture': 'a baseline capture',
  'hiring-up': 'a hiring increase',
  'hiring-down': 'a hiring drop',
  'pricing-changed': 'a pricing change',
  'headline-changed': 'a homepage rewrite',
  'tech-added': 'a new tool on their site',
  'tech-removed': 'a tool disappearing from their site',
  'thread-mention': 'a public thread'
};

/**
 * Weight for a kind. ANYTHING UNKNOWN SCORES ZERO -- a signal kind this build
 * has never heard of is stored, shown and counted as evidence, and contributes
 * nothing, because a scorer that silently guessed at unknown input would be
 * unfalsifiable exactly where it is least trustworthy.
 */
export function weightFor(kind: AccountSignalKind | string): number {
  return SIGNAL_WEIGHTS[kind as AccountSignalKind] ?? 0;
}

function labelFor(kind: string): string {
  return KIND_LABELS[kind as AccountSignalKind] ?? kind;
}

function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

function compareKinds(a: string, b: string): number {
  return kindRank(a) - kindRank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/* ---------------------------------------------------------------------------
 * Recency.
 * ------------------------------------------------------------------------ */

/**
 * What a signal is still worth, `ageDays` after it was observed.
 *
 * Exponential with a 21-day half-life, floored at `DECAY_FLOOR`, never above 1.
 * THE DECAY STARTS THE MOMENT THE SIGNAL POPS, which is the whole reason this
 * is a curve and not a window flag: the difference between a change spotted
 * yesterday and the same change spotted three weeks ago is the difference
 * between a message that reads as attention and one that reads as a mail merge,
 * and a step function at the window edge would price those identically.
 *
 * Exponential rather than linear because that is the shape of how a fact
 * actually ages: almost nothing is lost in the first few days -- which is why
 * a fresh signal keeps its full punch -- and then it falls away fast.
 *
 * ROUNDED TO FOUR PLACES so that two machines computing the same rationale
 * store the same bytes; `Math.pow` is not guaranteed identical across engines,
 * and a determinism claim we only mostly keep is not a determinism claim.
 *
 * A negative age (a signal timestamped slightly in the future by a clock skew
 * we do not own) is treated as brand new rather than as an error, because a
 * skewed clock is somebody else's bug and dropping their signal is ours.
 */
export function decayFor(ageDays: number, halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return DECAY_FLOOR;
  const raw = Math.pow(0.5, ageDays / halfLifeDays);
  return Math.max(DECAY_FLOOR, Math.min(1, round4(raw)));
}

/* ---------------------------------------------------------------------------
 * Layering: the part that makes this a scorer rather than a sum.
 * ------------------------------------------------------------------------ */

export interface CombinationBonus {
  /** The pair, in canonical order. Matched unordered. */
  kinds: readonly [AccountSignalKind, AccountSignalKind];
  bonus: number;
  /**
   * What this pair MEANS, in a sentence written for the founder reading the
   * ranked list -- not a label, not a rule id. Goes verbatim into
   * `ScoreRationale.combinations[].why`.
   */
  why: string;
}

/**
 * Named pairs, and the bonus each one earns.
 *
 * WHY A BONUS AT ALL, AND WHY IT IS BIG. Two signals of different kinds are not
 * two units of the same evidence, they are two INDEPENDENT witnesses. Our
 * detectors are individually unreliable in known ways -- a careers page can be
 * re-templated, a pricing page can be re-deployed, a stack read can be fooled by
 * a tag manager -- but those failure modes do not correlate. A company where a
 * careers page AND a pricing page AND a public thread all moved inside three
 * weeks is a company where something actually happened, and the joint
 * probability of two unrelated false positives landing together is far below the
 * probability of either one alone. The bonus is that gap, priced.
 *
 * WHY PER PAIR. The bonus is paid for every unordered pair of distinct
 * positively-weighted kinds present. Pairs grow quadratically -- two kinds is
 * one pair, three is three, four is six -- so "three or more, more again" falls
 * out of the counting and needs no separately tuned third term to drift out of
 * step with the pair values.
 *
 * WHY SOME PAIRS ARE NAMED. A generic pair says "two different things moved".
 * A named pair says something specific enough to open a message with, and the
 * `why` string is written to be read out loud, because that sentence is the
 * actual product: the operator is not buying a number, they are buying a reason.
 *
 * Only kinds with a POSITIVE weight can pair. A contraction corroborates
 * nothing, and a baseline capture corroborates nothing -- pairing them would let
 * "we looked at this company, and they also shrank" clear the two-kind gate,
 * which would make the gate a formality.
 */
export const COMBINATION_BONUSES: readonly CombinationBonus[] = [
  {
    kinds: ['hiring-up', 'thread-mention'],
    bonus: 22,
    why: 'They described this problem publicly and they are hiring the person who would own it: stated intent with budget behind it, which is the strongest pair this scorer can see.'
  },
  {
    kinds: ['hiring-up', 'pricing-changed'],
    bonus: 20,
    why: 'They are growing and repackaging at the same time -- headcount going in while the commercial story is being rewritten is what a company mid-change looks like from the outside.'
  },
  {
    kinds: ['pricing-changed', 'thread-mention'],
    bonus: 18,
    why: 'They said the problem out loud and their pricing moved in the same window: someone inside is already rebuilding how this gets sold, and they have told you what is bothering them.'
  },
  {
    kinds: ['hiring-up', 'tech-added'],
    bonus: 12,
    why: 'They installed something and then staffed around it -- an implementation with an owner and a deadline, not an evaluation that may never start.'
  },
  {
    kinds: ['pricing-changed', 'headline-changed'],
    bonus: 12,
    why: 'Price and positioning moved together, which makes this a repositioning rather than a copy tweak, and repositionings have a named person running them.'
  },
  {
    kinds: ['headline-changed', 'thread-mention'],
    bonus: 12,
    why: 'Their public story changed and someone there is talking about the problem underneath it -- the rewrite has a motive you can name back to them.'
  },
  {
    kinds: ['tech-added', 'tech-removed'],
    bonus: 10,
    why: 'One tool out, another in: a migration in progress, which is the narrow window where switching costs are already being paid.'
  }
];

/**
 * What any other pair of distinct positive kinds is worth.
 *
 * Deliberately modest. Two weak signals that happen to co-occur -- a headline
 * rewrite and a tool appearing -- are corroboration of SOMETHING, and 8 points
 * says so without letting two shrugs add up to an appointment. Two generic
 * kinds at full freshness land around 40: firmly 'warm', nowhere near 'hot'.
 */
export const GENERIC_PAIR_BONUS = 8;

function combinationFor(a: string, b: string): { bonus: number; why: string } {
  for (const entry of COMBINATION_BONUSES) {
    const [first, second] = entry.kinds;
    if ((first === a && second === b) || (first === b && second === a)) {
      return { bonus: entry.bonus, why: entry.why };
    }
  }
  return {
    bonus: GENERIC_PAIR_BONUS,
    why: `Two unrelated kinds of change in the same window -- ${labelFor(a)} and ${labelFor(b)} were read off different surfaces, so they corroborate each other rather than repeat each other.`
  };
}

/* ---------------------------------------------------------------------------
 * Tiers.
 * ------------------------------------------------------------------------ */

/**
 * The tier, from the score AND the number of distinct kinds behind it.
 *
 * WHY THE KIND COUNT IS A GATE AND NOT SIMPLY MORE POINTS. Points are
 * fungible: anything expressible as points can be bought with volume, and
 * volume is the one thing a noisy detector produces for free. If breadth were
 * only worth points, five `hiring-up` events off one re-templated careers page
 * would buy the same 'hot' as a hiring burst plus a pricing move -- and those
 * are not the same claim about the world. One is a single unreliable
 * measurement repeated; the other is two independent measurements agreeing.
 *
 * A gate cannot be bought with more of the same evidence. That is its entire
 * value: 'hot' means "two different things moved here", full stop, and an
 * operator who learns to trust that sentence can act on the badge without
 * re-deriving it. The moment 'hot' can also mean "one thing moved a lot", the
 * badge means "look into it", which is what they were already doing.
 *
 * 'warm' has no gate, because 'warm' is an invitation to look, not a claim.
 */
export function tierFor(score: number, distinctKinds: number): AccountTier {
  if (score >= HOT_SCORE && distinctKinds >= 2) return 'hot';
  if (score >= WARM_SCORE) return 'warm';
  return 'cold';
}

/**
 * The learnable SHAPE of a set of signals: distinct kinds, sorted, joined by
 * ','. The same string `account_feedback.signal_shape` stores, defined here so
 * that the thing which WRITES a rejection and the thing which APPLIES it cannot
 * drift apart -- a rejection recorded under a shape the scorer never produces
 * is a lesson silently thrown away.
 *
 * Every kind present counts, including zero-weighted and negative ones: the
 * operator rejected what they were LOOKING at, and "hiring-up on its own" and
 * "hiring-up next to a contraction" are different things to have looked at.
 */
export function signalShape(kinds: readonly string[]): string {
  return [...new Set(kinds)].sort(compareKinds).join(',');
}

/* ---------------------------------------------------------------------------
 * The scorer.
 * ------------------------------------------------------------------------ */

export interface ScoreAccountOptions {
  /** The clock, supplied by the caller. This module never reads one. */
  now: Date;
  /** How far back signals still count. Defaults to `DEFAULT_WINDOW_DAYS`. */
  windowDays?: number;
  /**
   * Shapes the operator has already called not-a-fit, as produced by
   * `signalShape`. Supplied by the caller; this module never queries for them.
   */
  rejectedShapes?: readonly string[];
}

export interface ScoreAccountResult {
  score: number;
  tier: AccountTier;
  distinctKinds: number;
  newestSignalAt: string | null;
  rationale: ScoreRationale;
}

/**
 * Score one account's signals. PURE: no clock, no database, no I/O, no state.
 *
 * SIGNALS OUTSIDE THE WINDOW ARE EXCLUDED ENTIRELY, and their exclusion is NOT
 * mentioned in the rationale. The rationale explains the score, not the
 * archive; a "why this score" panel padded with eleven lines about things that
 * did not count is a panel an operator stops reading, and the point of the
 * rationale is that it gets read.
 *
 * The order of operations, which is also the order the rationale renders in:
 *
 *   components  -- every in-window signal, decayed, repeat-tapered
 *   + bonuses   -- one per pair of distinct positive kinds
 *   + penalties -- rejected shape, staleness, single-kind cap, clamps
 *   = score     -- rounded to an integer, always inside 0..100
 *
 * The cap and the clamps are emitted as explicit adjustment lines rather than
 * applied silently, so the sum on the screen always reconciles with the number
 * on the screen. A score of 100 that shows "(capped: -52.5)" is a score an
 * operator can argue with; a bare 100 is one they can only distrust.
 */
export function scoreAccount(signals: readonly AccountSignal[], opts: ScoreAccountOptions): ScoreAccountResult {
  const windowDays = Math.max(1, opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const nowMs = opts.now.getTime();

  // 1. The window. Age is floored to whole days FIRST and everything downstream
  //    is derived from that floored number, so every figure in a rendered
  //    component can be recomputed from the component itself -- `decay` is
  //    exactly `decayFor(ageDays)` for a first occurrence, and an auditor with
  //    the row and this file needs nothing else.
  const inWindow: { signal: AccountSignal; ageDays: number }[] = [];
  for (const signal of signals) {
    const observedMs = parseTime(signal.observedAt);
    // An unparseable timestamp cannot be aged, and a signal that cannot be aged
    // cannot be claimed as recent -- which is the only claim that makes it
    // worth points. It drops out rather than defaulting to "today".
    if (observedMs === null) continue;
    const ageDays = Math.max(0, Math.floor((nowMs - observedMs) / 86_400_000));
    if (ageDays > windowDays) continue;
    inWindow.push({ signal, ageDays });
  }

  // 2. Repeat taper, applied per kind, strongest occurrence first. Recency
  //    order IS strength order within a kind (same base weight), so the newest
  //    occurrence keeps its full decay and the ones behind it fade fast.
  const byKind = new Map<string, { signal: AccountSignal; ageDays: number }[]>();
  for (const entry of inWindow) {
    const bucket = byKind.get(entry.signal.kind);
    if (bucket) bucket.push(entry);
    else byKind.set(entry.signal.kind, [entry]);
  }

  const components: ScoreComponent[] = [];
  for (const [kind, entries] of byKind) {
    const base = weightFor(kind);
    entries.sort((a, b) => a.ageDays - b.ageDays || compareIds(a.signal, b.signal));
    entries.forEach((entry, index) => {
      // The taper is folded into `decay` rather than into `base`, because
      // `base` is the published weight of the kind and must stay recognisable
      // as the table value. `decay` is therefore the FULL multiplier this
      // occurrence earned: recency times repetition. A reader wanting the two
      // factors apart recomputes recency as `decayFor(ageDays)`; what is left
      // is the taper.
      const decay = round4(decayFor(entry.ageDays) * Math.pow(REPEAT_TAPER, index));
      components.push({
        kind,
        detail: entry.signal.detail,
        evidenceUrl: entry.signal.evidenceUrl,
        observedAt: entry.signal.observedAt,
        ageDays: entry.ageDays,
        base,
        decay,
        points: round1(base * decay)
      });
    });
  }

  // Rendered strongest first: the panel's first line should be the reason the
  // account is on the screen. Ties fall back to recency, then to the canonical
  // kind order, then to id -- fully determined, never dependent on input order.
  components.sort(
    (a, b) =>
      b.points - a.points ||
      a.ageDays - b.ageDays ||
      compareKinds(a.kind, b.kind) ||
      (a.evidenceUrl < b.evidenceUrl ? -1 : a.evidenceUrl > b.evidenceUrl ? 1 : 0)
  );

  // 3. Layering. ONLY POSITIVE KINDS COUNT as layers -- see `COMBINATION_BONUSES`
  //    for why a contraction or a baseline must not clear the two-kind gate.
  const positiveKinds = [...byKind.keys()].filter((kind) => weightFor(kind) > 0).sort(compareKinds);
  const distinctKinds = positiveKinds.length;

  const combinations: ScoreRationale['combinations'] = [];
  for (let i = 0; i < positiveKinds.length; i += 1) {
    for (let j = i + 1; j < positiveKinds.length; j += 1) {
      const { bonus, why } = combinationFor(positiveKinds[i], positiveKinds[j]);
      combinations.push({ kinds: [positiveKinds[i], positiveKinds[j]], bonus, why });
    }
  }

  // 4. Adjustments, in the order they are argued.
  const penalties: ScoreRationale['penalties'] = [];
  let total = round1(
    components.reduce((sum, component) => sum + component.points, 0) +
      combinations.reduce((sum, combination) => sum + combination.bonus, 0)
  );

  const shape = signalShape(inWindow.map((entry) => entry.signal.kind));
  const rejected = shape.length > 0 && (opts.rejectedShapes ?? []).includes(shape);
  if (rejected) {
    penalties.push({
      reason: `You already marked this exact combination of signals (${shape}) as not a fit, so it is scored down wherever it appears.`,
      points: REJECTED_SHAPE_PENALTY
    });
    total = round1(total + REJECTED_SHAPE_PENALTY);
  }

  // Staleness is about the NEWEST thing we have: one fresh signal is recent
  // corroboration for everything behind it, and its absence is what makes the
  // rest an archive rather than a lead. Only charged against an account that
  // actually earned points -- there is nothing to make stale at zero.
  const newestAge = inWindow.length > 0 ? Math.min(...inWindow.map((entry) => entry.ageDays)) : null;
  if (total > 0 && newestAge !== null && newestAge > DEFAULT_HALF_LIFE_DAYS) {
    penalties.push({
      reason: `Nothing here is recent -- the freshest signal is ${newestAge} days old, past the ${DEFAULT_HALF_LIFE_DAYS}-day half-life, and nothing new has corroborated it since.`,
      points: STALENESS_PENALTY
    });
    total = round1(total + STALENESS_PENALTY);
  }

  if (distinctKinds <= 1 && total > SINGLE_KIND_CAP) {
    const delta = round1(SINGLE_KIND_CAP - total);
    penalties.push({
      reason: `Only one kind of signal here, so the score is held at ${SINGLE_KIND_CAP}. One kind repeating is one observation repeated, not two things agreeing.`,
      points: delta
    });
    total = round1(total + delta);
  }

  if (total > 100) {
    const delta = round1(100 - total);
    penalties.push({ reason: 'Capped at 100; the evidence went past the top of the scale.', points: delta });
    total = round1(total + delta);
  } else if (total < 0) {
    const delta = round1(0 - total);
    penalties.push({ reason: 'Floored at 0; a score is a ranking position and there is nothing below the bottom of the list.', points: delta });
    total = round1(total + delta);
  }

  const score = Math.round(total);
  const newestSignalAt = newestSignalTimestamp(inWindow);
  const rationale: ScoreRationale = {
    components,
    combinations,
    penalties,
    windowDays,
    summary: summarize({ components, distinctKinds, windowDays, newestAge, rejected })
  };

  return { score, tier: tierFor(score, distinctKinds), distinctKinds, newestSignalAt, rationale };
}

/**
 * The arithmetic of a rationale, reconciled: components + bonuses +
 * adjustments. `score === Math.round(rationaleTotal(rationale))` holds for
 * every rationale this module produces, and the "why this score" panel is
 * expected to check it rather than trust it.
 */
export function rationaleTotal(rationale: ScoreRationale): number {
  return round1(
    rationale.components.reduce((sum, component) => sum + component.points, 0) +
      rationale.combinations.reduce((sum, combination) => sum + combination.bonus, 0) +
      rationale.penalties.reduce((sum, penalty) => sum + penalty.points, 0)
  );
}

/* ---------------------------------------------------------------------------
 * The sentence.
 * ------------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const;

function numberWord(value: number): string {
  return NUMBER_WORDS[value] ?? String(value);
}

/**
 * "spotted 4 days ago" / "spotted on 2 Aug".
 *
 * Days for the first fortnight and a date after that, because a number of days
 * is how a person holds a recent event ("that was Tuesday") and a date is how
 * they hold an older one. Rendered from UTC parts with a fixed month table
 * rather than a locale formatter: the summary is stored in the rationale and
 * must not change because the server moved region.
 */
function recencyPhrase(ageDays: number, observedAt: string): string {
  if (ageDays <= 0) return 'spotted today';
  if (ageDays === 1) return 'spotted yesterday';
  if (ageDays < 14) return `spotted ${ageDays} days ago`;
  const observedMs = parseTime(observedAt);
  if (observedMs === null) return `spotted ${ageDays} days ago`;
  const date = new Date(observedMs);
  return `spotted on ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function trimPeriod(detail: string): string {
  return detail.trim().replace(/\.+$/, '');
}

function clauseFor(component: ScoreComponent): string {
  return `${trimPeriod(component.detail)} ${recencyPhrase(component.ageDays, component.observedAt)}`;
}

/**
 * ONE SENTENCE A FOUNDER COULD READ ALOUD, naming the actual signals and when
 * they landed.
 *
 * This is the product. The number sorts the list; the sentence is what makes
 * somebody open the row and write the message, and it has to survive being read
 * to a colleague without a legend. So: the signals' OWN WORDS, verbatim from
 * the detector that wrote them -- never a re-description, because the detail
 * line is the thing the recipient can check -- then when each landed, then the
 * one judgement the scorer is actually making, which is whether these are
 * independent and whether they are fresh.
 *
 * Two signals are named at most. A third clause turns a sentence into a report,
 * and the rest are counted rather than listed.
 */
function summarize(args: {
  components: readonly ScoreComponent[];
  distinctKinds: number;
  windowDays: number;
  newestAge: number | null;
  rejected: boolean;
}): string {
  const { components, distinctKinds, windowDays, rejected } = args;
  const rejectedTail = rejected ? ', and you have already marked this exact combination not a fit' : '';

  if (components.length === 0) {
    return `Nothing has been observed on this account in the last ${windowDays} days.`;
  }

  const named = components.filter((component) => component.points > 0);
  if (named.length === 0) {
    // Something is in the window, but it is a baseline or a contraction. Say
    // what it is and say plainly that it is not a reason to write, rather than
    // reporting a 0 with no sentence attached to it.
    return `${clauseFor(components[0])} -- nothing in the last ${windowDays} days carries any weight, so there is nothing to act on yet${rejectedTail}.`;
  }

  const headline = named.slice(0, 2).map(clauseFor).join(' and ');
  const more = named.length > 2 ? `, plus ${numberWord(named.length - 2)} more` : '';

  const newestByKind = new Map<string, number>();
  for (const component of named) {
    const current = newestByKind.get(component.kind);
    if (current === undefined || component.ageDays < current) newestByKind.set(component.kind, component.ageDays);
  }
  const freshest = Math.min(...named.map((component) => component.ageDays));
  const allFresh = [...newestByKind.values()].every((age) => age <= FRESH_DAYS);

  let verdict: string;
  if (distinctKinds <= 1) {
    verdict = 'one kind of signal, and one kind of signal is a coincidence until something else moves';
  } else if (allFresh && distinctKinds === 2) {
    verdict = 'two independent signals, both fresh';
  } else if (allFresh) {
    verdict = `${numberWord(distinctKinds)} independent signals, all fresh`;
  } else if (freshest === 0) {
    verdict = `${numberWord(distinctKinds)} independent signals, the newest from today`;
  } else if (freshest === 1) {
    verdict = `${numberWord(distinctKinds)} independent signals, the newest from yesterday`;
  } else {
    verdict = `${numberWord(distinctKinds)} independent signals, the freshest ${freshest} days old`;
  }

  return `${headline}${more}: ${verdict}${rejectedTail}.`;
}

/* ---------------------------------------------------------------------------
 * Small arithmetic.
 * ------------------------------------------------------------------------ */

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Milliseconds for a timestamp string, or null if it cannot be read.
 *
 * Accepts both ISO (`2026-08-02T09:00:00.000Z`) and PostgreSQL's rendering
 * (`2026-08-02 09:00:00+00`), because a signal reaches this module either
 * straight from a sweep or back out of a column, and the scorer must not care
 * which door it came through.
 */
function parseTime(value: string): number | null {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const patched = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(patched) ? null : patched;
}

/** Stable ordering for two signals observed in the same day. */
function compareIds(a: AccountSignal, b: AccountSignal): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function newestSignalTimestamp(entries: readonly { signal: AccountSignal; ageDays: number }[]): string | null {
  let newest: { signal: AccountSignal; ageDays: number } | null = null;
  for (const entry of entries) {
    const observedMs = parseTime(entry.signal.observedAt);
    if (observedMs === null) continue;
    const newestMs = newest === null ? null : parseTime(newest.signal.observedAt);
    if (newestMs === null || observedMs > newestMs) newest = entry;
  }
  return newest === null ? null : newest.signal.observedAt;
}

/* ---------------------------------------------------------------------------
 * Persistence: a thin shell around the pure function above.
 *
 * NOTHING BELOW THIS LINE MAKES A SCORING DECISION. It reads signals, calls
 * `scoreAccount`, and writes the answer down. Every judgement lives above, in
 * one place, where it can be tested without a database.
 *
 * THE QUERY COUNT IS BOUNDED, NEVER PER ACCOUNT. A workspace rescore after a
 * sweep touches hundreds of accounts; one round trip each is how a background
 * job becomes the reason the app is slow. Reads are one statement per chunk of
 * `RESCORE_CHUNK` accounts and writes are one multi-row upsert per chunk --
 * chunked rather than unbounded because a single statement carries at most
 * 65,535 bind parameters, and "one query" that fails at scale is worse than two
 * that do not.
 * ------------------------------------------------------------------------ */

/**
 * Accounts per read/write round trip. 200 accounts is 1,600 bind parameters on
 * the upsert -- comfortably inside Postgres' ceiling, comfortably inside a
 * statement timeout, and small enough that one bad row does not roll back a
 * workspace's worth of work.
 */
export const RESCORE_CHUNK = 200;

export interface RescoreOptions {
  /** The clock. Defaults to `new Date()` HERE, at the edge, and nowhere deeper. */
  now?: Date;
  /** Shapes the operator already rejected, from `account_feedback`. Supplied by the caller. */
  rejectedShapes?: readonly string[];
  /** Scoring window override; defaults to `DEFAULT_WINDOW_DAYS`. */
  windowDays?: number;
}

interface SignalRow {
  id: string;
  workspace_id: string;
  account_id: string;
  kind: string;
  detail: string;
  previous: string | null;
  current: string | null;
  evidence_url: string;
  observed_at: string;
  fingerprint: string;
  created_at: string;
}

const SIGNAL_COLUMNS = `
  id, workspace_id, account_id, kind, detail, previous, current,
  evidence_url, observed_at, fingerprint, created_at
`;

function toSignal(row: SignalRow): AccountSignal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    kind: row.kind,
    detail: row.detail,
    previous: row.previous,
    current: row.current,
    evidenceUrl: row.evidence_url,
    // Normalized on the way in, so a rationale never stores two renderings of
    // the same instant depending on whether the signal came from a live sweep
    // or back out of the column it was written to.
    observedAt: toIso(row.observed_at),
    fingerprint: row.fingerprint,
    createdAt: toIso(row.created_at)
  };
}

function toIso(value: string): string {
  const parsed = parseTime(value);
  return parsed === null ? value : new Date(parsed).toISOString();
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The active accounts to score, in id order.
 *
 * ONLY 'active' ACCOUNTS ARE SCORED. `not_a_fit` is a judgement the operator
 * already made -- migration 039 says such an account is kept, never swept and
 * never scored -- and recomputing a number for it would put a rejected company
 * back on a ranked screen with a fresh timestamp on it. `archived` is the same
 * decision without a reason attached. Both return `null`/absent rather than a
 * zero, so a caller can tell "we scored it at 0" from "we did not score it".
 */
async function activeAccountIds(db: Db, workspaceId: string, accountIds?: readonly string[]): Promise<string[]> {
  if (accountIds) {
    if (accountIds.length === 0) return [];
    const rows = await db
      .prepare(`SELECT id FROM accounts WHERE workspace_id=? AND id = ANY(?::text[]) AND status='active' ORDER BY id`)
      .all<{ id: string }>(workspaceId, [...new Set(accountIds)]);
    return rows.map((row) => row.id);
  }
  const rows = await db
    .prepare(`SELECT id FROM accounts WHERE workspace_id=? AND status='active' ORDER BY id`)
    .all<{ id: string }>(workspaceId);
  return rows.map((row) => row.id);
}

/**
 * Score one chunk of accounts and write the results: ONE read, ONE upsert.
 *
 * Accounts with no signals at all are scored and stored too, at zero. A ranked
 * list needs a row saying "nothing has moved here in 60 days" as much as it
 * needs the hot ones -- an account missing from `account_scores` is
 * indistinguishable from an account nobody has got to yet.
 */
async function rescoreChunk(
  db: Db,
  workspaceId: string,
  accountIds: readonly string[],
  now: Date,
  opts: RescoreOptions
): Promise<AccountScore[]> {
  if (accountIds.length === 0) return [];

  const rows = await db
    .prepare(
      `SELECT ${SIGNAL_COLUMNS} FROM account_signals
       WHERE workspace_id=? AND account_id = ANY(?::text[])
       ORDER BY account_id, observed_at DESC, id`
    )
    .all<SignalRow>(workspaceId, [...accountIds]);

  const byAccount = new Map<string, AccountSignal[]>();
  for (const accountId of accountIds) byAccount.set(accountId, []);
  for (const row of rows) byAccount.get(row.account_id)?.push(toSignal(row));

  const computedAt = now.toISOString();
  const scores: AccountScore[] = [];
  for (const accountId of accountIds) {
    const result = scoreAccount(byAccount.get(accountId) ?? [], {
      now,
      windowDays: opts.windowDays,
      rejectedShapes: opts.rejectedShapes
    });
    scores.push({
      workspaceId,
      accountId,
      score: result.score,
      tier: result.tier,
      distinctKinds: result.distinctKinds,
      newestSignalAt: result.newestSignalAt,
      rationale: result.rationale,
      computedAt
    });
  }

  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const score of scores) {
    tuples.push('(?,?,?,?,?,?,?,?)');
    values.push(
      score.workspaceId,
      score.accountId,
      score.score,
      score.tier,
      score.distinctKinds,
      score.newestSignalAt,
      JSON.stringify(score.rationale),
      score.computedAt
    );
  }

  await db
    .prepare(
      `INSERT INTO account_scores
         (workspace_id, account_id, score, tier, distinct_kinds, newest_signal_at, rationale_json, computed_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (workspace_id, account_id) DO UPDATE SET
         score = EXCLUDED.score,
         tier = EXCLUDED.tier,
         distinct_kinds = EXCLUDED.distinct_kinds,
         newest_signal_at = EXCLUDED.newest_signal_at,
         rationale_json = EXCLUDED.rationale_json,
         computed_at = EXCLUDED.computed_at`
    )
    .run(...values);

  // The objects returned are the rows just written, in the timestamps they were
  // written with. Reading them back with RETURNING would re-render every
  // timestamp in Postgres' own format and hand callers two different shapes for
  // the same field depending on which function produced it; the JSON is a
  // round trip of exactly what `rationale_json` now holds.
  return scores;
}

/**
 * Rescore one account and store the result. `null` when the workspace has no
 * such account, or when it is not 'active'.
 */
export async function rescoreAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
  opts: RescoreOptions = {}
): Promise<AccountScore | null> {
  const scores = await rescoreAccounts(db, workspaceId, [accountId], opts);
  return scores[0] ?? null;
}

/**
 * Rescore a named set of accounts. Ids that do not exist, or that the operator
 * has rejected or archived, are silently absent from the result -- a caller
 * handing us a stale id list should not get an exception, and should not get a
 * score for a company that is no longer in play either.
 */
export async function rescoreAccounts(
  db: Db,
  workspaceId: string,
  accountIds: readonly string[],
  opts: RescoreOptions = {}
): Promise<AccountScore[]> {
  const now = opts.now ?? new Date();
  const ids = await activeAccountIds(db, workspaceId, accountIds);
  const scores: AccountScore[] = [];
  for (const batch of chunk(ids, RESCORE_CHUNK)) {
    scores.push(...(await rescoreChunk(db, workspaceId, batch, now, opts)));
  }
  return scores;
}

/**
 * Rescore every active account in a workspace. Returns how many were scored.
 *
 * ONE `now` FOR THE WHOLE PASS, taken once at the top. A sweep that re-read the
 * clock per account would decay the last account marginally harder than the
 * first, and a ranked list whose order depends on the order the job happened to
 * visit rows in is a list that cannot be reproduced or defended.
 */
export async function rescoreWorkspace(db: Db, workspaceId: string, opts: RescoreOptions = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const ids = await activeAccountIds(db, workspaceId);
  let scored = 0;
  for (const batch of chunk(ids, RESCORE_CHUNK)) {
    const written = await rescoreChunk(db, workspaceId, batch, now, opts);
    scored += written.length;
  }
  return scored;
}
