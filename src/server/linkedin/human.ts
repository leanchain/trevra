/**
 * Small interaction helpers shared by the LinkedIn drivers.
 *
 * These helpers are deliberately boring and intentionally transparent. They exist only for UI stability and
 * lazy-loading correctness; they do not add synthetic mouse movement, typing
 * cadence, random dwell time, or any other behaviour intended to disguise
 * automation. Safety comes from the ledger, rate limits, work windows and
 * challenge/limit-wall handling, not from imitating a person.
 */

export interface HumanPage {
  waitForTimeout(ms: number): Promise<void>;
  mouse?: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard?: {
    press(key: string, options?: { delay?: number }): Promise<void>;
  };
}

export interface HumanLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(text: string, options?: { timeout?: number }): Promise<void>;
  hover?(options?: { timeout?: number }): Promise<void>;
  pressSequentially?(text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
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

/**
 * Perform one functional scroll so lazy-loaded rows can render. No pointer
 * choreography or variable reading pattern is generated.
 */
export async function readPage(page: HumanPage, _seed: string): Promise<void> {
  if (!page.mouse) return;
  try {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(250);
  } catch {
    // Lazy-loading assistance is optional; the caller still reads what exists.
  }
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
