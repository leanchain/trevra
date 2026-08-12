/**
 * The four formatters every screen in the shell shares.
 *
 * They live outside App.tsx because Loop, Money, Ledger and the cost screen
 * all render money and all render a provider name, and a second copy of
 * `money()` with a different `maximumFractionDigits` is how two screens start
 * disagreeing about what the same number is.
 */

export const money = (amount: number, currency = 'EUR') => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, maximumFractionDigits: 0
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
 */
export const usd = (cents: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD'
}).format(cents / 100);

const SYMBOLS = new Map<string, string | null>();

function currencySymbol(code: string): string | null {
  const cached = SYMBOLS.get(code);
  if (cached !== undefined) return cached;
  let symbol: string | null = null;
  try {
    symbol = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
      .formatToParts(0).find((part) => part.type === 'currency')?.value ?? null;
  } catch {
    // Not an ISO 4217 code -- `INV`, `SOW`, an acronym in a sentence. Left alone.
    symbol = null;
  }
  SYMBOLS.set(code, symbol);
  return symbol;
}

/**
 * `EUR 1,850` -> `€1,850`, inside a sentence the server wrote.
 *
 * The recommendation engine builds its prose by concatenating a currency code
 * and an amount, so a card could read "an unpaid invoice for EUR 1,850" above
 * a chip reading "€1,850" -- one number, two notations, a hundred pixels
 * apart, and a reader with no way to know it is the same money.
 *
 * A presentation problem gets a presentation fix. This rewrites the NOTATION
 * and never the digits: no reformatting, no rounding, no locale grouping
 * applied to someone else's number. If the code is not a currency, or the
 * runtime does not know it, the text comes back untouched.
 */
export function moneyProse(text: string): string {
  return text.replace(/\b([A-Z]{3}) (?=\d)/g, (whole, code: string) => currencySymbol(code) ?? whole);
}

export function initials(value: string): string {
  return value.split(/[\s-]+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
}

export function prettyProvider(provider: string): string {
  return provider.replace('google-mail', 'Gmail').replace('gmail', 'Gmail').replace('microsoft', 'Microsoft 365').replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * `.client-copy small` is one clipped line about 145px wide, so anything past
 * it was invisible overflow rather than text. Cut here, kept in full on the
 * element's title.
 */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
