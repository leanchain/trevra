import {
  SELECTORS,
  normalisedProfileUrl,
  parseConnectionDegree,
  profileUrlFor,
  type LinkedInDriverResult,
  type LinkedInFailureKind,
  type LinkedInPage
} from './driver.js';
import { hoverClick, readPage, settle } from './human.js';

/**
 * The three ENGAGEMENT routines: follow a profile, like their most recent
 * post, endorse their listed skills.
 *
 * This is `driver.ts`'s sibling and it lives under exactly the same rules --
 * re-read that file's header, all of it applies here without amendment:
 *
 *   - it is reachable only from `local-worker.ts`, which is reachable only on
 *     a self-hosted deployment (plan 4.3);
 *   - it stores no credential and echoes no argument into a `detail` string;
 *   - NOTHING HERE THROWS. Every path returns a `LinkedInDriverResult`, so a
 *     batch can never end at an unknown point with an unclaimed action;
 *   - the six failure kinds are `driver.ts`'s and are imported rather than
 *     re-declared, because the worker branches on them and a seventh kind
 *     invented here would be a kind nothing handles.
 *
 * WHY THESE THREE ACTIONS EXIST AT ALL (plan 4A, "extra actions: endorse,
 * follow, like -- driver has invite/dm/view only", and 6A which schedules
 * them). Dripify and Waalaxy ship them; we did not. They are also the actions
 * plan 1.4's warm-up ramp is literally written in terms of -- "wk1 passive
 * only (views/likes, 0 invites)" -- so until now the warm-up could perform
 * only half of what the research says a warm-up IS.
 *
 * THEY ARE PASSIVE, AND PASSIVE IS NOT UNPACED. Both halves matter and they
 * pull in opposite directions, which is why both are written down:
 *
 *   passive     -- `limits.ts` `PASSIVE_KINDS` must contain all three, so the
 *                  warm-up multiplier does not zero them. A seat that does
 *                  nothing for seven days and then starts acting is the
 *                  "Slide and Spike" shape of plan 1.3; a warm-up that
 *                  performs no actions is not a warm-up.
 *   not unpaced -- every one of these still gets a per-kind daily ceiling
 *                  (`engagement.ts`) and still goes through
 *                  `evaluateLinkedInSafety`. Two hundred likes in an hour is
 *                  a ban signal no matter how harmless one like is.
 *
 * WHAT THIS FILE DOES NOT DO: it does not decide whether an action is allowed.
 * It is handed a target and it drives a page. The gate ran before the call,
 * one action earlier, in `local-worker.ts`.
 */

/**
 * `driver.ts` keeps these three private, so they are restated here rather than
 * exported from there.
 *
 * They are deliberately identical values -- two driver files that time out
 * differently would be a difference an operator reading a ledger could not
 * explain.
 */
const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;
/**
 * The post-load and post-click pause is `settle()` from `human.ts`, drawn from
 * a band and seeded per step. It was `1_500` here and in four sibling files --
 * see the note where `driver.ts` used to declare it for why five files
 * agreeing on a millisecond value was the problem.
 */

/**
 * The post container on a profile's activity feed, and the anchor for
 * "the most recent one".
 *
 * `>> nth=0` is Playwright's own selector-chaining syntax, the same engine
 * syntax `driver.ts` already uses for its `text=/.../i` selectors. It is here
 * because the structural `LinkedInLocator` slice offers `first()` and nothing
 * else: without an anchor, "the Like button" would mean "the topmost Like
 * button anywhere on the feed", which is a DIFFERENT post the moment the most
 * recent one is already liked. Scoping in the selector is what makes
 * `likeRecentPost` actually about the recent post.
 */
const ACTIVITY_POST = 'main div[data-urn*="urn:li:activity:"]';

/**
 * EVERY ENGAGEMENT SELECTOR, IN ONE TABLE, for the reasons `driver.ts`
 * `SELECTORS` gives at length: LinkedIn changes these, drift is the expected
 * steady state, a miss on a control we were about to click is
 * `selector_drift` and never "the action failed".
 *
 * Shared controls (the walls, the challenge form, the More menu) are imported
 * from `SELECTORS` rather than copied, so a repair there fixes both files.
 *
 * ONE HAZARD IS WORTH NAMING because it is invisible: `[aria-label^="Follow"]`
 * ALSO matches `aria-label="Following ..."`, so a naive follow selector clicks
 * UNFOLLOW on someone this seat already follows. Every follow selector below
 * therefore carries an explicit `:not([aria-label^="Following"])`, and
 * `followProfile` reads `followingState` before it looks for anything to
 * click. Belt and braces, on purpose: the failure mode is silent and it
 * removes a relationship rather than adding one.
 */
export const ENGAGE_SELECTORS = {
  /** The primary Follow on the profile action bar. */
  followButton: 'button[aria-label^="Follow"]:not([aria-label^="Following"])',
  /** LinkedIn hides Follow behind "More" on profiles where Connect is primary. */
  followInMoreMenu: 'div[role="button"][aria-label^="Follow"]:not([aria-label^="Following"])',
  /** Already following. The control we must NOT click. */
  followingState: 'button[aria-label^="Following"], button[aria-label^="Unfollow"]',
  /** Confirmation after choosing to stop following. */
  unfollowConfirm:
    'div[role="dialog"] button:has-text("Unfollow"), div[role="dialog"] button[aria-label*="Unfollow" i]',
  /** Destructive relationship control, available only from the profile More menu. */
  removeConnectionInMoreMenu:
    'div[role="menu"] [role="menuitem"]:has-text("Remove connection"), div[role="menu"] button:has-text("Remove connection")',
  removeConnectionConfirm:
    'div[role="dialog"] button:has-text("Remove"), div[role="dialog"] button[aria-label*="Remove connection" i]',

  /** Every post on the activity feed. Counted only to answer "are there any?". */
  activityPost: ACTIVITY_POST,
  /** LinkedIn's own words for an empty activity feed. */
  activityEmpty:
    'text=/hasn.t posted|has not posted|No posts yet|Nothing to see for now|doesn.t have any activity/i',
  /** The most recent post's Like control, unreacted. */
  firstPostLike: `${ACTIVITY_POST} >> nth=0 >> button[aria-label^="React Like"]`,
  /** The most recent post's Like control, already reacted by this seat. */
  firstPostLiked: `${ACTIVITY_POST} >> nth=0 >> button[aria-label^="Unreact Like"]`,

  /** An un-endorsed skill on the profile's skills detail page. */
  endorseButton: 'main button[aria-label^="Endorse"]',
  /** A skill this seat has already endorsed. */
  endorsedState:
    'main button[aria-label^="Remove endorsement"], main button[aria-label^="Endorsed"]',
  /** LinkedIn sometimes asks "how well does X know this skill?" after an endorse. */
  endorseDialogDismiss:
    'div[role="dialog"] button[aria-label="Dismiss"], div[role="dialog"] button[aria-label^="Close"]'
} as const;

/** Where a checkpoint lands. URL-level, so it is caught before any selector is read. */
const CHECKPOINT_PATH = /\/(checkpoint|uas\/login)\//i;

/**
 * The gap between two clicks INSIDE one action, in milliseconds.
 *
 * NOT `ACTION_GAP_SECONDS`, and the difference is the whole reason this
 * constant exists. That range (30-120s, plan 1.4, REPORTED) is the gap between
 * two LEDGER ACTIONS and `local-worker.ts` owns it. Endorsing three skills is
 * ONE ledger action, and a human who waited two minutes between clicking
 * Endorse twice on the same page would be the anomaly, not the cover.
 *
 * The fixed upper bound is conservative UI/load spacing between multiple
 * clicks inside one explicit action. Safety-critical ceilings remain in
 * `engagement.ts` and the gate.
 */
const ENGAGE_GAP_MS = { min: 700, max: 2_600 };

/** Fixed conservative maximum pause between multiple clicks inside one explicit action. */
export function engageGapMs(_seed: string): number {
  return ENGAGE_GAP_MS.max;
}

/**
 * What every engagement routine accepts beyond its target.
 *
 * Both fields exist for the same reason the driver takes a `page` instead of
 * launching one: the caller owns the clock. `sleep` is injected so tests do
 * not really wait; `seed` is retained for call-site compatibility/log labels.
 */
export interface EngageOptions {
  /** Compatibility/replay label. Defaults to the target string. */
  seed?: string;
  /** Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EndorseOptions extends EngageOptions {
  /**
   * How many listed skills to endorse. Default 3, clamped to 1..10.
   *
   * Three is the number LinkedIn's own profile card shows before "show all",
   * so endorsing three is the shape of a person who read the top of the
   * section and stopped -- and it is UNVERIFIED-VENDOR, a judgement about
   * plausible behaviour rather than a published limit. The upper clamp exists
   * because "endorse every skill this stranger lists" is not a thing a human
   * does, and one ledger action must not be able to become thirty clicks.
   */
  limit?: number;
}

const DEFAULT_ENDORSE_LIMIT = 3;
const MAX_ENDORSE_LIMIT = 10;

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function fail(failureKind: LinkedInFailureKind, detail: string): LinkedInDriverResult {
  return { ok: false, failureKind, detail };
}

async function present(page: LinkedInPage, selector: string): Promise<boolean> {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    // A locator that cannot even be evaluated is drift, not presence. Reporting
    // `false` here would let a routine sail past a limit wall it failed to read.
    return false;
  }
}

/**
 * The three "stop now" reads, done BEFORE anything is clicked.
 *
 * Byte-for-byte the ordering `driver.ts` uses, and for the same reason: a
 * challenge outranks a limit wall outranks a missing profile, because a
 * checkpoint page can also render the words "invitation limit" and the
 * human-intervention case is the one that must win.
 */
async function detectWall(page: LinkedInPage): Promise<LinkedInFailureKind | null> {
  if (CHECKPOINT_PATH.test(page.url())) return 'challenge';
  if (await present(page, SELECTORS.challengeForm)) return 'challenge';
  if (await present(page, SELECTORS.restrictionNotice)) return 'limit_wall';
  if (await present(page, SELECTORS.limitWall)) return 'limit_wall';
  if (await present(page, SELECTORS.profileUnavailable)) return 'not_found';
  return null;
}

/**
 * The canonical `https://www.linkedin.com/in/<handle>/` for a target, or null.
 *
 * Two exported helpers do the work rather than a third parser: `profileUrlFor`
 * applies the ALLOWED_HOSTS check (a `target_ref` is an opaque string a human
 * typed, and this driver navigates an AUTHENTICATED browser to it), and
 * `normalisedProfileUrl` reduces it to the exact `/in/<handle>/` form.
 *
 * Both engagement sub-pages are built by APPENDING to this string, which is
 * why the second step is not optional: appending `recent-activity/all/` to
 * `https://www.linkedin.com/in/x/?trk=nav` produces a URL that is not anyone's
 * activity feed. A target that does not reduce is REFUSED rather than
 * repaired -- guessing at a profile URL is the thing plan 1.2 says we do not
 * do.
 */
function canonicalProfileFor(target: string): string | null {
  const url = profileUrlFor(target);
  if (!url) return null;
  return normalisedProfileUrl(url);
}

/** Navigate, settle, and read the walls. Returns the failure to report, or null. */
async function openAt(page: LinkedInPage, url: string): Promise<LinkedInDriverResult | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await settle(page, `${url}#open`);
    // Follows, likes and endorsements all land here first, and all three are
    // "a person was looking at this page and reacted to it". Reading it before
    // reacting is what makes that true. Decoration only: never throws.
    await readPage(page, `${url}#read`);
  } catch (cause) {
    // Navigation failed, so no action was taken. Definite, and reported as
    // drift rather than `unknown`: nothing was clicked.
    return fail(
      'selector_drift',
      `Could not open ${url}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  const wall = await detectWall(page);
  if (!wall) return null;
  return fail(
    wall,
    wall === 'challenge'
      ? `LinkedIn is showing a challenge at ${page.url()}. A human has to clear it in the profile window; nothing else will.`
      : wall === 'limit_wall'
        ? `LinkedIn refused at ${url}: a limit or restriction notice is on screen. This is LinkedIn asking us to stop.`
        : `${url} does not resolve to a profile.`
  );
}

/** The refusal for a target this driver will not navigate to. */
function unopenable(target: string, page: string): LinkedInDriverResult {
  return fail(
    'not_found',
    `'${target}' does not reduce to a LinkedIn profile URL, so there is no ${page} to open. Targets are never resolved or guessed.`
  );
}

/* ---------------------------------------------------------------------------
 * follow
 * ------------------------------------------------------------------------ */

/**
 * Follow a profile.
 *
 * The cheapest signal we can send a target and the one plan 1.4's warm-up
 * leans on hardest: it puts this seat in their notifications without consuming
 * an invite, and it needs no approved copy, so there is nothing here for a
 * reviewer to have approved and nothing for this routine to compose.
 *
 * ALREADY FOLLOWING IS `already_connected`, NOT A FAILURE. That kind's
 * contract in `driver.ts` is "there is nothing to send. Definite.", which is
 * exactly the situation, and the vocabulary is closed on purpose -- inventing
 * an `already_following` kind would be a kind the worker's branch does not
 * handle. It is checked FIRST, before any control is looked for, because the
 * Follow and Following controls share an aria-label prefix and clicking the
 * wrong one UNFOLLOWS somebody.
 */
export async function followProfile(
  page: LinkedInPage,
  target: string
): Promise<LinkedInDriverResult> {
  const url = canonicalProfileFor(target);
  if (!url) return unopenable(target, 'profile');

  const blocked = await openAt(page, url);
  if (blocked) return blocked;

  if (await present(page, ENGAGE_SELECTORS.followingState)) {
    return fail(
      'already_connected',
      `This seat already follows ${url}; a second follow is not a thing to send.`
    );
  }

  // Follow is either on the action bar or behind "More". Both are read before
  // anything is clicked, so a miss on both is unambiguously "nothing happened".
  let follow = page.locator(ENGAGE_SELECTORS.followButton);
  if ((await follow.count()) === 0) {
    const more = page.locator(SELECTORS.moreActionsButton);
    if ((await more.count()) === 0) {
      return fail(
        'selector_drift',
        `Neither ${ENGAGE_SELECTORS.followButton} nor ${SELECTORS.moreActionsButton} matched on ${url}. Nothing was clicked.`
      );
    }
    try {
      await hoverClick(page, more.first(), `${url}#more`, CLICK_TIMEOUT_MS);
      await settle(page, `${url}#more-open`);
    } catch (cause) {
      return fail(
        'selector_drift',
        `Opening the More menu on ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    follow = page.locator(ENGAGE_SELECTORS.followInMoreMenu);
    if ((await follow.count()) === 0) {
      return fail(
        'selector_drift',
        `The More menu on ${url} contains no ${ENGAGE_SELECTORS.followInMoreMenu}. Nothing was clicked.`
      );
    }
  }

  // EVERYTHING BELOW THIS LINE IS POST-CLICK. An error from here on cannot
  // prove the follow did not register, so it reports `unknown` and the worker
  // holds the claim rather than retrying it into a second one.
  try {
    await hoverClick(page, follow.first(), `${url}#follow`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#after-follow`);

    const wall = await detectWall(page);
    if (wall) {
      return fail(
        wall,
        `LinkedIn answered the Follow click on ${url} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}. The follow was refused, not registered.`
      );
    }

    // The button flipping to "Following" is the confirmation. Without it we
    // clicked something and do not know what it did.
    if (await present(page, ENGAGE_SELECTORS.followingState)) {
      return { ok: true, externalRef: url, failureKind: null };
    }
    return fail(
      'unknown',
      `The Follow control on ${url} did not flip to a following state after the click; whether the follow registered is unknown.`
    );
  } catch (cause) {
    return fail(
      'unknown',
      `The follow of ${url} was interrupted after the click: ${cause instanceof Error ? cause.message : String(cause)}. Whether it registered is unknown.`
    );
  }
}

/* ---------------------------------------------------------------------------
 * unfollow / disconnect cleanup
 * ------------------------------------------------------------------------ */

/**
 * Stop following a profile. This is intentionally reversible: `followProfile`
 * can restore the state, and the worker paces it through the same follow bucket.
 */
export async function unfollowProfile(
  page: LinkedInPage,
  target: string
): Promise<LinkedInDriverResult> {
  const url = canonicalProfileFor(target);
  if (!url) return unopenable(target, 'profile');
  const blocked = await openAt(page, url);
  if (blocked) return blocked;

  const following = page.locator(ENGAGE_SELECTORS.followingState);
  if ((await following.count()) === 0) {
    if ((await page.locator(ENGAGE_SELECTORS.followButton).count()) > 0) {
      return fail('not_found', `This seat is not following ${url}; there is nothing to unfollow.`);
    }
    return fail(
      'selector_drift',
      `Neither a Following nor Follow state could be read on ${url}. Nothing was clicked.`
    );
  }

  try {
    await hoverClick(page, following.first(), `${url}#unfollow`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#unfollow-open`);
    const confirm = page.locator(ENGAGE_SELECTORS.unfollowConfirm);
    if ((await confirm.count()) > 0) {
      await hoverClick(page, confirm.first(), `${url}#unfollow-confirm`, CLICK_TIMEOUT_MS);
      await settle(page, `${url}#after-unfollow-confirm`);
    }
    const wall = await detectWall(page);
    if (wall)
      return fail(
        wall,
        `LinkedIn answered the Unfollow action on ${url} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}.`
      );
    if (
      (await page.locator(ENGAGE_SELECTORS.followingState).count()) === 0 &&
      (await page.locator(ENGAGE_SELECTORS.followButton).count()) > 0
    ) {
      return { ok: true, externalRef: url, failureKind: null };
    }
    return fail(
      'unknown',
      `The follow state on ${url} did not confirm that the unfollow registered; whether it changed is unknown.`
    );
  } catch (cause) {
    return fail(
      'unknown',
      `The unfollow of ${url} was interrupted after a click: ${cause instanceof Error ? cause.message : String(cause)}. Whether it registered is unknown.`
    );
  }
}

/**
 * Remove a 1st-degree connection, with two independent eligibility proofs:
 * LinkedIn's degree badge must read `1st`, and the destructive More-menu item
 * must exist. No readable 1st-degree state means no click.
 */
export async function disconnectProfile(
  page: LinkedInPage,
  target: string
): Promise<LinkedInDriverResult> {
  const url = canonicalProfileFor(target);
  if (!url) return unopenable(target, 'profile');
  const blocked = await openAt(page, url);
  if (blocked) return blocked;

  const badge = page.locator(SELECTORS.degreeBadge);
  if ((await badge.count()) === 0) {
    return fail(
      'selector_drift',
      `The connection-degree badge could not be found on ${url}. Nothing destructive was clicked.`
    );
  }
  const degree = parseConnectionDegree(
    await badge.first().textContent({ timeout: CLICK_TIMEOUT_MS })
  );
  if (degree === null) {
    return fail(
      'selector_drift',
      `The connection-degree badge on ${url} could not be read. Nothing destructive was clicked.`
    );
  }
  if (degree !== 1) {
    return fail(
      'not_found',
      `${url} is ${degree === 2 ? '2nd' : '3rd'}-degree, not a verified 1st-degree connection, so there is no connection Trevra may remove.`
    );
  }

  const more = page.locator(SELECTORS.moreActionsButton);
  if ((await more.count()) === 0) {
    return fail(
      'selector_drift',
      `The More menu could not be found on verified 1st-degree profile ${url}. Nothing destructive was clicked.`
    );
  }
  try {
    await hoverClick(page, more.first(), `${url}#disconnect-more`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#disconnect-menu`);
  } catch (cause) {
    return fail(
      'selector_drift',
      `Opening the More menu on ${url} failed before any destructive control was clicked: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  const remove = page.locator(ENGAGE_SELECTORS.removeConnectionInMoreMenu);
  if ((await remove.count()) === 0) {
    return fail(
      'selector_drift',
      `The verified 1st-degree profile ${url} has no readable Remove connection control. Nothing destructive was clicked.`
    );
  }

  // Everything from here is post-destructive-control: ambiguity is UNKNOWN,
  // never retried automatically.
  try {
    await hoverClick(page, remove.first(), `${url}#disconnect`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#disconnect-confirmation`);
    const confirm = page.locator(ENGAGE_SELECTORS.removeConnectionConfirm);
    if ((await confirm.count()) === 0) {
      return fail(
        'unknown',
        `Remove connection was chosen on ${url} but no confirmation control appeared. Whether LinkedIn changed the relationship is unknown.`
      );
    }
    await hoverClick(page, confirm.first(), `${url}#disconnect-confirm`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#after-disconnect`);
    const wall = await detectWall(page);
    if (wall)
      return fail(
        wall,
        `LinkedIn answered the disconnect confirmation on ${url} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}.`
      );
    const after = page.locator(SELECTORS.degreeBadge);
    const afterDegree =
      (await after.count()) > 0
        ? parseConnectionDegree(await after.first().textContent({ timeout: CLICK_TIMEOUT_MS }))
        : null;
    if (afterDegree !== 1) {
      return { ok: true, externalRef: url, failureKind: null };
    }
    return fail(
      'unknown',
      `LinkedIn still reports ${url} as 1st-degree after confirmation; whether the removal registered is unknown.`
    );
  } catch (cause) {
    return fail(
      'unknown',
      `Removing the connection to ${url} was interrupted after the destructive control was clicked: ${cause instanceof Error ? cause.message : String(cause)}. Whether it registered is unknown.`
    );
  }
}

/* ---------------------------------------------------------------------------
 * like
 * ------------------------------------------------------------------------ */

/**
 * Like the target's most recent post.
 *
 * AN EMPTY ACTIVITY FEED IS THE COMMON CASE AND IT IS NOT AN ERROR. Most
 * LinkedIn members post rarely or never, so "they have nothing to like" is the
 * ORDINARY outcome of this routine, not the exceptional one. It is reported as
 * `not_found` -- the kind whose contract is "definite; the action did not
 * happen and never will" -- and its `detail` is written to read as an ordinary
 * fact, because an operator scanning a ledger must not spend attention on it.
 * Nothing here is a fault, nothing needs fixing, and the wording says so.
 *
 * WHAT `externalRef` IS. The canonical PROFILE url, not the post permalink,
 * matching `viewProfile` and `sendInvite` and matching what migration 024 says
 * the column holds ("the profile URL the action landed on"), so ledger rows
 * stay comparable against `target_ref`. Reading the post's own URN would need
 * `getAttribute` on the locator slice, which `driver.ts` does not expose --
 * see the integration note in the module header of `engagement.ts`.
 */
export async function likeRecentPost(
  page: LinkedInPage,
  target: string,
  opts: EngageOptions = {}
): Promise<LinkedInDriverResult> {
  const profile = canonicalProfileFor(target);
  if (!profile) return unopenable(target, 'activity feed');
  const feed = `${profile}recent-activity/all/`;
  const sleep = opts.sleep ?? defaultSleep;

  const blocked = await openAt(page, feed);
  if (blocked) return blocked;

  const posts = await page.locator(ENGAGE_SELECTORS.activityPost).count();
  if (posts === 0 || (await present(page, ENGAGE_SELECTORS.activityEmpty))) {
    return fail(
      'not_found',
      `${profile} has no posts on their activity feed, so there is nothing to like. This is the ordinary outcome for most profiles, not a fault: nothing was attempted and nothing needs fixing.`
    );
  }

  if (await present(page, ENGAGE_SELECTORS.firstPostLiked)) {
    return fail(
      'already_connected',
      `This seat has already reacted to the most recent post on ${feed}; a second like is not a thing to send.`
    );
  }

  const like = page.locator(ENGAGE_SELECTORS.firstPostLike);
  if ((await like.count()) === 0) {
    return fail(
      'selector_drift',
      `${ENGAGE_SELECTORS.firstPostLike} did not match on ${feed}. Nothing was clicked.`
    );
  }

  // A person reads a post before reacting to it. Seeded, so this batch's
  // pauses are reproducible from the ledger.
  await sleep(engageGapMs(opts.seed ?? target));

  // EVERYTHING BELOW THIS LINE IS POST-CLICK.
  try {
    await hoverClick(page, like.first(), `${feed}#like`, CLICK_TIMEOUT_MS);
    await settle(page, `${feed}#after-like`);

    const wall = await detectWall(page);
    if (wall) {
      return fail(
        wall,
        `LinkedIn answered the Like click on ${feed} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}. The reaction was refused, not registered.`
      );
    }

    if (await present(page, ENGAGE_SELECTORS.firstPostLiked)) {
      return {
        ok: true,
        externalRef: profile,
        failureKind: null,
        detail: 'Liked the most recent post on the activity feed.'
      };
    }
    return fail(
      'unknown',
      `The Like control on ${feed} did not flip to a reacted state after the click; whether the reaction registered is unknown.`
    );
  } catch (cause) {
    return fail(
      'unknown',
      `The like on ${feed} was interrupted after the click: ${cause instanceof Error ? cause.message : String(cause)}. Whether it registered is unknown.`
    );
  }
}

/* ---------------------------------------------------------------------------
 * endorse
 * ------------------------------------------------------------------------ */

/**
 * Endorse up to `limit` of the target's listed skills. Default 3.
 *
 * ONE LEDGER ACTION, SEVERAL CLICKS, and that asymmetry is the thing to hold
 * on to while reading this: the gate ran once, for one `endorse`, so this
 * routine may not turn itself into N actions' worth of activity. `limit` is
 * clamped rather than trusted, and the pauses between clicks come from
 * `engageGapMs` rather than from `ACTION_GAP_SECONDS`, which paces LEDGER
 * actions and is the worker's to apply.
 *
 * The loop re-reads `endorseButton` every pass and always clicks `first()`,
 * which works because an endorsed skill's control changes label -- so the
 * un-endorsed set shrinks by one each time and the next `first()` is genuinely
 * the next skill. The count DROPPING is also the only confirmation available
 * that a click did anything, and it is what separates a real endorsement from
 * an `unknown`.
 *
 * NO SKILLS LISTED IS `not_found`, and like an empty activity feed it is an
 * ordinary outcome written to read as one. EVERY SKILL ALREADY ENDORSED is
 * `already_connected` -- there is nothing to send.
 *
 * A wall or an interruption PART WAY THROUGH reports the wall, with the number
 * already endorsed in the detail. It is not silently upgraded to a success:
 * the ledger row is one action either way, and an operator reading "limit wall
 * after 2 of 3" knows both facts, where "ok" would hide the one that matters.
 */
export async function endorseSkills(
  page: LinkedInPage,
  target: string,
  opts: EndorseOptions = {}
): Promise<LinkedInDriverResult> {
  const profile = canonicalProfileFor(target);
  if (!profile) return unopenable(target, 'skills page');
  const skillsUrl = `${profile}details/skills/`;
  const sleep = opts.sleep ?? defaultSleep;
  const limit = Math.min(
    MAX_ENDORSE_LIMIT,
    Math.max(1, Math.trunc(opts.limit ?? DEFAULT_ENDORSE_LIMIT))
  );

  const blocked = await openAt(page, skillsUrl);
  if (blocked) return blocked;

  const available = await page.locator(ENGAGE_SELECTORS.endorseButton).count();
  if (available === 0) {
    if (await present(page, ENGAGE_SELECTORS.endorsedState)) {
      return fail(
        'already_connected',
        `This seat has already endorsed every skill listed on ${skillsUrl}; there is nothing left to endorse.`
      );
    }
    return fail(
      'not_found',
      `${profile} lists no endorsable skills, so there is nothing to endorse. This is an ordinary outcome, not a fault: nothing was attempted and nothing needs fixing.`
    );
  }

  let endorsed = 0;
  for (let index = 0; index < limit; index += 1) {
    const buttons = page.locator(ENGAGE_SELECTORS.endorseButton);
    const before = await buttons.count();
    if (before === 0) break;

    if (index > 0) await sleep(engageGapMs(`${opts.seed ?? target}:${index}`));

    // EVERYTHING BELOW THIS LINE IS POST-CLICK, for this iteration.
    try {
      await hoverClick(page, buttons.first(), `${skillsUrl}#endorse:${index}`, CLICK_TIMEOUT_MS);
      await settle(page, `${skillsUrl}#after-endorse:${index}`);
    } catch (cause) {
      return fail(
        'unknown',
        `Endorsement ${endorsed + 1} on ${skillsUrl} was interrupted after the click: ${cause instanceof Error ? cause.message : String(cause)}. ${endorsed} endorsement(s) had already registered; whether this one did is unknown.`
      );
    }

    const wall = await detectWall(page);
    if (wall) {
      return fail(
        wall,
        `LinkedIn answered endorsement ${endorsed + 1} on ${skillsUrl} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}, after ${endorsed} had registered.`
      );
    }

    // "How well does X know this skill?" -- a modal, not an answer we have.
    // Dismissed rather than filled in: nobody approved a proficiency claim.
    const dismiss = page.locator(ENGAGE_SELECTORS.endorseDialogDismiss);
    if ((await dismiss.count()) > 0) {
      try {
        await hoverClick(page, dismiss.first(), `${skillsUrl}#dismiss:${index}`, CLICK_TIMEOUT_MS);
        await settle(page, `${skillsUrl}#after-dismiss:${index}`);
      } catch {
        // An undismissable modal blocks the next click but says nothing about
        // the endorsement behind it, which the count check below settles.
      }
    }

    if ((await buttons.count()) >= before) {
      return fail(
        'unknown',
        `The endorse control on ${skillsUrl} did not change state after click ${endorsed + 1}; ${endorsed} endorsement(s) had registered and whether this one did is unknown.`
      );
    }
    endorsed += 1;
  }

  return {
    ok: true,
    externalRef: profile,
    failureKind: null,
    detail: `Endorsed ${endorsed} of the ${available} skill(s) listed on the profile (limit ${limit}).`
  };
}
