/**
 * How a Trevra action LOOKS to LinkedIn while it is happening.
 *
 * Everything in this file is about the shape of the interaction, never about
 * whether the interaction is allowed: the ceilings live in `limits.ts`, the
 * gate in `guard.ts`, and the between-action spacing in `local-worker.ts`.
 * This is the inside of a single action -- the seconds between the page load
 * and the click, and between the click and the send.
 *
 * WHY IT EXISTS. The 2026-08-14 investigation (docs/) found that Trevra had
 * been flagged with ZERO invites and ZERO messages sent. What LinkedIn saw was
 * the client, not the volume: a browser that loaded a page, waited exactly
 * 1,500ms, read every card by selector and navigated again, emitting no
 * pointer movement, no wheel event and no keystroke in a telemetry stream
 * (`li/track`) that LinkedIn keeps per member and scores. A constant is a
 * fingerprint. A page that is never scrolled is a fingerprint. Text that
 * appears in a composer in one input event, with no keydown before it, is a
 * fingerprint.
 *
 * FOUR RULES HOLD FOR EVERY FUNCTION HERE:
 *
 *   1. NO `Math.random()`. Ever. Every pause is drawn from a seeded mulberry32,
 *      the same generator as `pacing.ts`, so a batch's timing is reproducible
 *      from the ledger and a test can assert a cadence instead of tolerating
 *      one. Unpredictable to LinkedIn is the goal; unreproducible to us is not.
 *   2. LOOKING HUMAN NEVER CHANGES WHAT IS SENT. `typeLike` puts the caller's
 *      bytes in the field or it falls back to `fill`, which puts the caller's
 *      bytes in the field. There is no path where a note is typed differently
 *      from how it was approved.
 *   3. DECORATION NEVER FAILS AN ACTION. A hover that misses, a wheel event on
 *      a page object with no mouse, a scroll that throws -- all swallowed. The
 *      click that follows is the action, and its error propagates exactly as
 *      it did before this file existed.
 *   4. EVERY CAPABILITY IS OPTIONAL. Every test fake in this repo implements a
 *      `click`/`fill`/`waitForTimeout` slice and nothing else. Absent mouse,
 *      absent keyboard and absent `pressSequentially` all degrade to precisely
 *      the pre-existing behaviour, which is why wiring this in changed no
 *      driver test.
 */

import { createHash } from 'node:crypto';

/* ---------------------------------------------------------------------------
 * The structural slices. Declared here rather than imported from `driver.ts`
 * so this file closes no cycle: every driver imports it, it imports no driver.
 * ------------------------------------------------------------------------ */

export interface HumanPage {
  waitForTimeout(ms: number): Promise<void>;
  /** Absent on every test fake, and on any page object that cannot point. */
  mouse?: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  /** Needed only to put a newline in a composer without pressing Enter. */
  keyboard?: {
    press(key: string, options?: { delay?: number }): Promise<void>;
  };
}

export interface HumanLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(text: string, options?: { timeout?: number }): Promise<void>;
  /** Playwright has it; the fakes do not. Missing means "click without hovering first". */
  hover?(options?: { timeout?: number }): Promise<void>;
  /** Playwright's per-key typing. Missing means "set the value in one event". */
  pressSequentially?(text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
}

/* ---------------------------------------------------------------------------
 * Randomness that is not random.
 * ------------------------------------------------------------------------ */

/**
 * mulberry32 over a sha256 of the seed. Copied, not imported, for the reason
 * `driver-engage.ts` and `local-worker.ts` both record: `pacing.ts` keeps it
 * private and widening a public surface to save four lines is the worse trade.
 */
function seededRandom(seed: string): () => number {
  const digest = createHash('sha256').update(seed).digest('hex');
  let state = Number.parseInt(digest.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The pause after a page load or a click, DRAWN AND NOT FIXED.
 *
 * 900-4,200ms is UNVERIFIED-VENDOR: a judgement about how long a person looks
 * at a page before doing the next thing, not a published number. It bounds
 * nothing safety-critical -- the ceilings do that -- so being wrong here costs
 * plausibility, not an account. What matters is that it is a BAND and not the
 * 1,500.000ms constant every driver used to wait.
 */
const SETTLE_MS_RANGE = { min: 900, max: 4_200 } as const;

export function settleMs(seed: string): number {
  const random = seededRandom(seed);
  return Math.round(SETTLE_MS_RANGE.min + random() * (SETTLE_MS_RANGE.max - SETTLE_MS_RANGE.min));
}

/**
 * WHAT KEEPS TWO SITTINGS FROM BEING THE SAME SITTING.
 *
 * Seeding from the URL and the step made every pause reproducible, which is
 * what this file wants -- and it also made them REPEATABLE, which it does not.
 * Opening the same profile twice drew the same 2,143ms dwell twice, to the
 * millisecond, and a worker restarted at noon replayed the morning's exact
 * rhythm. Nobody does anything twice at exactly the same speed.
 *
 * The salt is mixed into every behavioural draw (never into `settleMs` itself,
 * which stays a pure function a test can assert). `local-worker.ts` sets it per
 * browser open, to the seat and the hour -- so a run is still reproducible from
 * the ledger, and no two sittings share a rhythm.
 */
let sessionSalt = '';
export function setHumanSessionSalt(salt: string): void {
  sessionSalt = salt;
}

/**
 * THE SALT AND THE SEED, AND DELIBERATELY NOTHING ELSE.
 *
 * Two counters were tried here and both were wrong, which is worth recording
 * because the pull towards them is strong. A global monotonic counter makes
 * every draw depend on how many unrelated draws happened first, so adding a
 * call site silently changes the timing of every other one and a test that
 * asserts a cadence is really asserting the order of the whole program. A
 * per-seed counter is order-independent but still breaks the contract this
 * subsystem is built on -- `listPendingInvites` run twice with the same seed
 * must pace identically, and it is asserted -- for a benefit the salt already
 * delivers: the salt changes every sitting, so the same step never draws the
 * same pause on two different days anyway.
 *
 * Repeated identical seeds inside ONE sitting are handled where they belong,
 * at the call sites: every step that can repeat already numbers itself
 * (`#more:${index}`, `:reactors:${step}`, `#endorse:${index}`).
 */
function drawSeed(seed: string): string {
  return `${sessionSalt}:${seed}`;
}

/** `waitForTimeout(settleMs(...))`, which is what nearly every call site wants. */
export async function settle(page: HumanPage, seed: string, factor = 1): Promise<void> {
  await page.waitForTimeout(Math.round(settleMs(drawSeed(seed)) * factor));
}

/* ---------------------------------------------------------------------------
 * Behaviour.
 * ------------------------------------------------------------------------ */

/**
 * Read the page the way a person reads it: move the pointer onto it and scroll.
 *
 * THREE THINGS DEPEND ON THIS, and only one of them is about looking human.
 * LinkedIn lazy-loads rows below the fold, so an unscrolled page can hold
 * fewer cards than a walk thinks it does. LinkedIn's client tracking reports
 * viewport and engagement events, and a session with none of them is an
 * outlier in a stream it already scores. And a wheel event is the cheapest
 * possible evidence that something with a pointing device is on the far end.
 *
 * A FEW PASSES, NOT A FULL SWEEP: the point is to look like reading, not to
 * reach the bottom. Selectors read the page afterwards regardless of where the
 * viewport stopped.
 */
export async function readPage(page: HumanPage, seed: string): Promise<void> {
  const mouse = page.mouse;
  if (!mouse) return;
  const random = seededRandom(drawSeed(seed));
  try {
    // NOT ALWAYS THE SAME READ. The first version of this did one pointer move
    // and then three to six identical wheel ticks on every page it ever saw --
    // varied enough to beat a constant and uniform enough to be its own
    // signature. A glance, a normal read and a long one are different
    // behaviours, and which one happens is drawn per page.
    const appetite = random();
    const passes = appetite < 0.25 ? 1 + Math.floor(random() * 2) : appetite < 0.8 ? 3 + Math.floor(random() * 3) : 6 + Math.floor(random() * 5);
    await mouse.move(Math.round(280 + random() * 700), Math.round(180 + random() * 460), { steps: 6 + Math.floor(random() * 12) });
    for (let pass = 0; pass < passes; pass += 1) {
      await mouse.wheel(0, Math.round(180 + random() * 620));
      await page.waitForTimeout(Math.round(150 + random() * (random() < 0.15 ? 2_400 : 700)));
      // The pointer does not sit at one coordinate while a person reads a
      // page. It drifts, and it drifts more often than it clicks.
      if (random() < 0.45) {
        await mouse.move(Math.round(240 + random() * 760), Math.round(160 + random() * 500), { steps: 4 + Math.floor(random() * 10) });
      }
    }
    // A short scroll back up. People overshoot and correct; a strictly
    // monotonic downward scroll is its own small tell. Not every time, though
    // -- always correcting is as mechanical as never correcting.
    if (random() < 0.7) {
      await mouse.wheel(0, -Math.round(90 + random() * 240));
      await page.waitForTimeout(Math.round(200 + random() * 500));
    }
  } catch {
    // Reading the page is the job. Looking human while doing it is not worth
    // failing the walk over.
  }
}

/**
 * Hover the control, pause, then click it.
 *
 * WHY THE HOVER MATTERS. Playwright's `click()` teleports: it dispatches at the
 * element's centre with no intervening pointer movement, so the DOM sees
 * `mousedown` on a control the pointer never travelled to and never rested on.
 * A real click is always preceded by `mousemove` and `mouseover`, and LinkedIn
 * ships a bundle that listens for exactly those. `hover()` walks the mouse
 * there for real, and the pause is the fraction of a second a person spends
 * confirming they are about to click the right thing.
 *
 * THE HOVER IS DECORATION AND THE CLICK IS THE ACTION. A hover that throws --
 * covered element, animating menu, a fake with no `hover` -- is swallowed and
 * the click still happens, with its own error propagating to the caller
 * unchanged. That is what keeps this safe to drop into a post-click path where
 * the difference between "nothing was clicked" and `unknown` is load-bearing.
 */
export async function hoverClick(
  page: HumanPage,
  locator: HumanLocator,
  seed: string,
  timeoutMs: number
): Promise<void> {
  const random = seededRandom(drawSeed(seed));
  if (typeof locator.hover === 'function') {
    try {
      await locator.hover({ timeout: timeoutMs });
    } catch {
      // Not being able to hover it says nothing about being able to click it.
    }
  }
  // THE PAUSE HAPPENS EITHER WAY. It used to live inside the hover branch, so
  // a control that could not be hovered -- or a page object with no `hover` at
  // all -- went straight from "found it" to `mousedown` with nothing in
  // between, which is the teleporting click this function exists to stop.
  await page.waitForTimeout(Math.round(120 + random() * 520));
  await locator.click({ timeout: timeoutMs });
}

/**
 * Put the caller's text in the field the way a person puts it there: one key
 * at a time, in bursts, with the odd pause for thought.
 *
 * WHY. `fill()` sets `value` and fires ONE `input` event. Nothing else. No
 * `keydown`, no `keypress`, no `keyup`, no composition, no per-character
 * timing -- and LinkedIn's `li/track` stream batches typing events precisely
 * because it collects them. A 300-character invite note that materialises in a
 * textarea between two frames, followed by a Send click, is the clearest
 * possible statement that no person wrote it.
 *
 * THE BYTES ARE THE CALLER'S, ALWAYS. `pressSequentially` appends exactly the
 * characters it is given, and if anything at all goes wrong mid-way this falls
 * back to `fill(text)`, which replaces the field's whole contents with the
 * approved string. There is no path that sends a partial note: either the
 * field holds `text` or the call threw and the caller reports it.
 *
 * NEWLINES ARE THE ONE HAZARD, and they are handled explicitly. In LinkedIn's
 * composer, Enter can SEND -- typing a `\n` in the middle of a two-paragraph
 * message would post half of it. So multi-line text is typed one line at a
 * time with `Shift+Enter` between lines, which inserts a break in both the
 * textarea and the contenteditable and never submits. If the page object has
 * no keyboard to press it with, multi-line text takes the `fill` path instead.
 * `\r` is not typeable at all without changing bytes, so text containing one
 * always takes the `fill` path.
 *
 * NOT USED FOR CREDENTIALS. `loginWithCredentials` keeps `fill`, deliberately:
 * that file's standing guarantee is that no failure path can echo a password,
 * and `fill`'s error text is audited for it. Typing an email and a password is
 * more human and it is not worth re-opening that guarantee for.
 */
export async function typeLike(
  page: HumanPage,
  locator: HumanLocator,
  text: string,
  seed: string,
  timeoutMs: number
): Promise<void> {
  const lines = text.split('\n');
  const random = seededRandom(drawSeed(seed));
  const typeable =
    typeof locator.pressSequentially === 'function' &&
    text.length > 0 &&
    !text.includes('\r') &&
    (lines.length === 1 || typeof page.keyboard?.press === 'function');
  if (!typeable) {
    await locator.fill(text, { timeout: timeoutMs });
    // EVEN THE PASTE PATH WAITS. Whatever put the text there, the human who
    // "wrote" it does not hit Send in the same animation frame -- and this
    // branch is the one a page object without `pressSequentially` always
    // takes, so leaving it instantaneous would leave the loudest composer
    // signal in place for exactly the callers that cannot type.
    await page.waitForTimeout(Math.round(900 + random() * 3_400));
    return;
  }

  try {
    // A person clicks into the box before typing in it.
    await locator.click({ timeout: timeoutMs });
    await page.waitForTimeout(Math.round(180 + random() * 620));
    for (let line = 0; line < lines.length; line += 1) {
      let index = 0;
      const body = lines[line];
      while (index < body.length) {
        // Bursts, not a metronome: people type a handful of characters, stop,
        // then type a handful more.
        const chunk = body.slice(index, index + 3 + Math.floor(random() * 8));
        await locator.pressSequentially!(chunk, {
          delay: Math.round(45 + random() * 115),
          timeout: timeoutMs
        });
        index += chunk.length;
        if (index < body.length) {
          // One pause in eight is a long one -- rereading, or deciding.
          await page.waitForTimeout(Math.round(90 + random() * (random() < 0.125 ? 1_700 : 520)));
        }
      }
      if (line < lines.length - 1) {
        await page.keyboard!.press('Shift+Enter');
        await page.waitForTimeout(Math.round(140 + random() * 480));
      }
    }
    // The beat before hitting send, which is where a person rereads it.
    await page.waitForTimeout(Math.round(400 + random() * 1_900));
  } catch {
    // Whatever went wrong, the field must end up holding exactly what was
    // approved. `fill` clears and sets it; if that throws too, the caller's
    // catch reports it exactly as it did before typing existed.
    await locator.fill(text, { timeout: timeoutMs });
  }
}
