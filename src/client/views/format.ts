/**
 * The four formatters every screen in the shell shares.
 *
 * They live outside App.tsx because Loop, Money, Ledger and the cost screen
 * all render money and all render a provider name, and a second copy of
 * `money()` with a different `maximumFractionDigits` is how two screens start
 * disagreeing about what the same number is.
 */

/**
 * A workspace's own money, in its reader's own notation.
 *
 * TWO SEPARATE DECISIONS, AND 'en-US' COLLAPSED THEM INTO ONE. The CURRENCY is
 * the workspace's: every caller with a workspace behind it passes what the
 * server stored for it -- `metrics.currency`, `client.currency`,
 * `cost.produced.currency`. The LOCALE decides grouping, decimal mark and
 * which side the symbol sits on, and that is a fact about the READER, not
 * about the money. Running a German workspace's own euros through 'en-US'
 * printed "€1,850" at somebody who writes "1.850 €" -- their currency, their
 * amount, somebody else's punctuation, and a thousands separator that reads as
 * a decimal point to them.
 *
 * `undefined` is not "no locale". It is the browser's, which is the only
 * locale this client actually knows something about: there is no workspace
 * locale field on any payload, and inventing a mapping from currency to locale
 * would be worse than either -- a Swiss workspace billing in EUR is not German.
 *
 * The `'EUR'` default is NOT a workspace currency and never stood in for one.
 * It is the fallback for the one caller formatting a RULE THRESHOLD rather
 * than a stored figure (App.tsx's auto-approve sentence), which has no
 * workspace row to read a currency off.
 */
export const money = (amount: number, currency = 'EUR') =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(amount);

/**
 * The agent budget travels in whole cents. A founder reads dollars, so cents
 * are converted here and the word never reaches the screen.
 *
 * This one is hard-USD on purpose and it is NOT the workspace's currency: it
 * is what a model provider billed, and providers bill in dollars. Every screen
 * that puts a `usd()` figure next to a `money()` figure has to say so in
 * words -- see LoopView -- because two symbols in one panel with nothing
 * naming the difference is how a founder stops trusting all of them.
 *
 * Hard-USD is a claim about the CURRENCY and not about the reader, so the
 * locale is theirs for the same reason as `money()` above. A founder in Paris
 * is still billed in dollars; "1 234,56 $US" is that same figure written the
 * way they read numbers, and pinning it to 'en-US' would have made the ONE
 * genuinely foreign number on the screen the only one that looked native.
 */
export const usd = (cents: number) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD'
  }).format(cents / 100);

export function initials(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function prettyProvider(provider: string): string {
  return provider
    .replace('google-mail', 'Gmail')
    .replace('gmail', 'Gmail')
    .replace('microsoft', 'Microsoft 365')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
