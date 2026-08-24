/**
 * One count, one noun, one verb -- worded the same way on every screen.
 *
 * These two lines were pasted into five screen files, and copies drift: four
 * of them printed the count raw while the fifth grouped its thousands, so the
 * same imported list read "1400 leads" on Leads and "1,400 leads" on the lead
 * configuration step. The verb drifted further -- only one file had ever grown
 * the agreement half, which is why a queue holding a single row could still
 * announce "1 lead are waiting" on every other screen.
 *
 * A LEAF MODULE ON PURPOSE: it imports nothing, so a screen, a test, and the
 * execution-blocker ladder can all reach the same sentence without dragging a
 * component in behind it.
 */

/**
 * "1 lead", "4 leads".
 *
 * `many` is for the nouns English refuses to regularise -- `plural(2, 'person',
 * 'people')` -- and for the ones that are already their own plural, such as the
 * "min" in a step delay.
 */
export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The same sentence with digit grouping, for counts that come off an imported
 * file rather than out of a queue.
 *
 * A CSV genuinely carries six figures, and "142731 leads" is a number the
 * reader has to count across on the screen. A step delay or a day threshold
 * never gets big enough to earn the separator, so it stays out of `plural` --
 * the two are one rule with one deliberate difference, not two rules.
 */
export const pluralGrouped = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** Subject-verb agreement, so a count of one never reads "1 lead are waiting". */
export const are = (count: number) => (count === 1 ? 'is' : 'are');
