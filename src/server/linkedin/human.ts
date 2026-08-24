/**
 * Small interaction helpers shared by the LinkedIn drivers.
 *
 * These helpers are deliberately boring and intentionally transparent. They
 * exist only for UI stability: they do not add synthetic mouse movement,
 * typing cadence, or random dwell time, and that remains true -- a fill is one
 * fill and a click is one click.
 *
 * THE SCOPE OF THAT PROMISE IS ONE INTERACTION, and the previous wording
 * overreached past it. `pacing.ts` and `local-worker.ts` DO vary when actions
 * are scheduled and how far apart they are sent, and they should: a fixed
 * 120-second gap repeated six times is an interval the scheduler generates
 * that no real process would, so removing it is subtraction rather than
 * disguise. Nothing about that reaches this file. Faking the timing of a
 * keypress would be inventing a person; spacing two independent sends is not,
 * and conflating the two is what made this comment wrong.
 *
 * Safety still comes from the ledger, the rate limits, the work windows and
 * the challenge/limit-wall handling -- never from timing, here or anywhere.
 */

export interface HumanPage {
  waitForTimeout(ms: number): Promise<void>;
  keyboard?: {
    press(key: string, options?: { delay?: number }): Promise<void>;
  };
}

export interface HumanLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(text: string, options?: { timeout?: number }): Promise<void>;
}

/** Fixed UI-settle delay. The seed remains in the signature for call-site compatibility. */
const SETTLE_MS = 1_000;

export function settleMs(_seed: string): number {
  return SETTLE_MS;
}

/** Kept as a compatibility no-op; interaction timing is no longer session-shaped. */
export function setHumanSessionSalt(_salt: string): void {}

/** Give LinkedIn's SPA a short, predictable moment to render after navigation/clicks. */
export async function settle(page: HumanPage, _seed: string, factor = 1): Promise<void> {
  await page.waitForTimeout(Math.max(0, Math.round(SETTLE_MS * factor)));
}

/** Click the control directly. No hover/pause is added to imitate a human. */
export async function hoverClick(
  _page: HumanPage,
  locator: HumanLocator,
  _seed: string,
  timeoutMs: number
): Promise<void> {
  await locator.click({ timeout: timeoutMs });
}

/** Put exactly the approved bytes into the field in one operation. */
export async function typeLike(
  _page: HumanPage,
  locator: HumanLocator,
  text: string,
  _seed: string,
  timeoutMs: number
): Promise<void> {
  await locator.fill(text, { timeout: timeoutMs });
}
