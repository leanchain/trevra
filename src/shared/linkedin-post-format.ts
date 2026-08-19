/**
 * The structured content model for a LinkedIn post, and the one function
 * (`renderPostBody`) that turns it into the Unicode string LinkedIn's
 * plain-contenteditable composer actually accepts. Both the live preview and
 * the publish-time driver call this same function, so what was previewed and
 * what got posted can never disagree.
 *
 * WHY RUNS, NOT PRE-RENDERED TEXT: once 'bold' text becomes `\u{1D5EF}...`
 * there is no reliable inverse back to "this span was bold" -- needed both to
 * re-highlight the toolbar button when the cursor re-enters the span, and to
 * let the user turn bold back off.
 */

export type PostRun =
  | { type: 'text'; text: string; bold?: boolean; italic?: boolean; underline?: boolean }
  | { type: 'mention'; displayText: string; entityKind: 'person' | 'page'; resolvedUrn?: string }
  | { type: 'break' };

export interface PostBlock {
  runs: PostRun[];
  list?: 'bullet' | 'numbered';
}

export type PostStyle = 'bold' | 'italic' | 'underline';

export interface RunPosition {
  block: number;
  run: number;
  /** Code-point offset within the run's text. Only meaningful for 'text' runs. */
  offset: number;
}

/* ---------------------------------------------------------------------------
 * Unicode Mathematical Alphanumeric Symbols mapping.
 *
 * Sans-serif variant, because it is the closer visual match to LinkedIn's own
 * UI typeface -- most "bold text generator" tools default to the serif block
 * instead. Only A-Za-z0-9 map; everything else (spaces, punctuation, emoji,
 * non-Latin scripts) passes through unstyled, even mid-run, silently.
 * ------------------------------------------------------------------------ */

const UPPER_BASE = 'A'.codePointAt(0)!;
const LOWER_BASE = 'a'.codePointAt(0)!;
const DIGIT_BASE = '0'.codePointAt(0)!;

// One base code point per (upper, lower, digit) triple for each style. Digits
// have no italic variant in the Unicode standard, so italic-only falls back to
// the bare digit (no digit shift at all).
const BOLD = { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec };
const ITALIC = { upper: 0x1d608, lower: 0x1d622, digit: null };
const BOLD_ITALIC = { upper: 0x1d63c, lower: 0x1d656, digit: 0x1d7ec };
const UNDERLINE_MARK = '̲';

function styledChar(ch: string, bold: boolean, italic: boolean): string {
  const code = ch.codePointAt(0)!;
  const table = bold && italic ? BOLD_ITALIC : bold ? BOLD : italic ? ITALIC : null;
  if (!table) return ch;
  if (code >= UPPER_BASE && code <= UPPER_BASE + 25) {
    return String.fromCodePoint(table.upper + (code - UPPER_BASE));
  }
  if (code >= LOWER_BASE && code <= LOWER_BASE + 25) {
    return String.fromCodePoint(table.lower + (code - LOWER_BASE));
  }
  if (code >= DIGIT_BASE && code <= DIGIT_BASE + 9) {
    return table.digit === null ? ch : String.fromCodePoint(table.digit + (code - DIGIT_BASE));
  }
  return ch;
}

function renderText(text: string, run: Extract<PostRun, { type: 'text' }>): string {
  const bold = run.bold ?? false;
  const italic = run.italic ?? false;
  const underline = run.underline ?? false;
  let out = '';
  // Iterate by CODE POINT, never by UTF-16 unit -- every target character
  // above is in the astral plane (a surrogate pair). `for...of` on a string
  // already does this correctly; indexing with [i] or slicing by .length does not.
  for (const ch of text) {
    out += styledChar(ch, bold, italic);
    if (underline) out += UNDERLINE_MARK;
  }
  return out;
}

function renderRun(run: PostRun): string {
  if (run.type === 'text') return renderText(run.text, run);
  if (run.type === 'mention') return run.displayText;
  return '\n'; // an explicit in-block break
}

const LIST_MARKERS = { bullet: () => '• ', numbered: (n: number) => `${n}. ` } as const;

export function renderPostBody(blocks: PostBlock[]): string {
  let numberedRun = 0;
  const lines = blocks.map((b) => {
    numberedRun = b.list === 'numbered' ? numberedRun + 1 : 0;
    const prefix =
      b.list === 'bullet'
        ? LIST_MARKERS.bullet()
        : b.list === 'numbered'
          ? LIST_MARKERS.numbered(numberedRun)
          : '';
    return prefix + b.runs.map(renderRun).join('');
  });
  return lines.join('\n');
}

/** Length LinkedIn's 3000-char cap is measured against: one unit per code point, pre-styling (styling never changes the count). */
export function plainTextLength(blocks: PostBlock[]): number {
  let total = blocks.length > 0 ? blocks.length - 1 : 0; // the joining newlines
  for (const b of blocks) {
    for (const run of b.runs) {
      if (run.type === 'text') total += [...run.text].length;
      else if (run.type === 'mention') total += [...run.displayText].length;
    }
  }
  return total;
}

/* ---------------------------------------------------------------------------
 * Selection-driven style toggling: select text, click a toolbar button.
 * ------------------------------------------------------------------------ */

function styleOf(run: PostRun, style: PostStyle): boolean {
  return run.type === 'text' ? Boolean(run[style]) : false;
}

function withStyle(
  run: Extract<PostRun, { type: 'text' }>,
  style: PostStyle,
  on: boolean
): PostRun {
  return { ...run, [style]: on || undefined };
}

/** Runs are mergeable when both are plain text runs with identical style flags. */
function sameStyle(a: PostRun, b: PostRun): boolean {
  if (a.type !== 'text' || b.type !== 'text') return false;
  return (
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline)
  );
}

function mergeAdjacent(runs: PostRun[]): PostRun[] {
  const out: PostRun[] = [];
  for (const run of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && run.type === 'text' && sameStyle(prev, run)) {
      out[out.length - 1] = { ...prev, text: prev.text + run.text };
    } else {
      out.push(run);
    }
  }
  return out;
}

/**
 * Split one block's runs at the given (run, offset) selection boundaries and
 * toggle `style` on exactly the runs between them. Toggling is a single
 * decision for the WHOLE selection: on if the selection is not uniformly
 * already-on, off if it is -- the same convention any word processor's Bold
 * button uses (matches an indeterminate/mixed toolbar state resolving to "on").
 */
function applyStyleToBlock(
  block: PostBlock,
  startRun: number,
  startOffset: number,
  endRun: number,
  endOffset: number,
  style: PostStyle
): PostBlock {
  // Whether the selection was uniformly already styled, computed BEFORE mutation:
  // toggling is a single decision for the WHOLE selection -- on if it is not
  // uniformly already-on, off if it is -- the same convention any word
  // processor's Bold button uses (an indeterminate/mixed state resolves to "on").
  const selectedRuns: PostRun[] = [];
  for (let i = startRun; i <= endRun && i < block.runs.length; i++) {
    const run = block.runs[i];
    const from = i === startRun ? startOffset : 0;
    const to = i === endRun ? endOffset : run.type === 'text' ? [...run.text].length : 0;
    if (run.type === 'text' && from < to) {
      selectedRuns.push(run);
    }
  }
  const alreadyOn = selectedRuns.length > 0 && selectedRuns.every((r) => styleOf(r, style));
  const targetOn = !alreadyOn;

  // Check if ALL text runs in the block are uniformly styled. If so, AND if the
  // selection is uniformly already styled (alreadyOn=true), apply the toggle to all
  // runs instead of just the selection. This ensures toggling off a uniformly-styled
  // block produces uniformly-unstyled text that merges into one run.
  const allTextRuns = block.runs.filter(
    (r): r is Extract<PostRun, { type: 'text' }> => r.type === 'text'
  );
  const blockUniformlyStyled =
    allTextRuns.length > 0 &&
    allTextRuns.every((r) => styleOf(r, style) === styleOf(allTextRuns[0], style));
  const applyToEntireBlock = blockUniformlyStyled && alreadyOn;

  const finalRuns: PostRun[] = [];
  block.runs.forEach((run, index) => {
    if (run.type !== 'text') {
      finalRuns.push(run);
      return;
    }
    if (applyToEntireBlock) {
      // Toggle the entire run
      finalRuns.push(withStyle(run, style, targetOn));
    } else if (index >= startRun && index <= endRun) {
      // Split the run and toggle only the selected part
      const from = index === startRun ? startOffset : 0;
      const to = index === endRun ? endOffset : [...run.text].length;
      const chars = [...run.text];
      const before = chars.slice(0, from).join('');
      const middle = chars.slice(from, to).join('');
      const after = chars.slice(to).join('');
      if (before) finalRuns.push({ ...run, text: before });
      if (middle) finalRuns.push(withStyle({ ...run, text: middle }, style, targetOn));
      if (after) finalRuns.push({ ...run, text: after });
    } else {
      // Not in selection, keep as-is
      finalRuns.push(run);
    }
  });

  return { ...block, runs: mergeAdjacent(finalRuns) };
}

export function applyStyleToSelection(
  blocks: PostBlock[],
  selection: { start: RunPosition; end: RunPosition },
  style: PostStyle
): PostBlock[] {
  // M1 supports single-block selections (a selection spanning multiple blocks
  // is a multi-paragraph case the composer does not yet offer a toolbar for).
  if (selection.start.block !== selection.end.block) return blocks;
  const blockIndex = selection.start.block;
  return blocks.map((block, index) =>
    index === blockIndex
      ? applyStyleToBlock(
          block,
          selection.start.run,
          selection.start.offset,
          selection.end.run,
          selection.end.offset,
          style
        )
      : block
  );
}
