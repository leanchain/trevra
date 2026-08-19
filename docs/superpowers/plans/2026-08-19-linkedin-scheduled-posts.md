# LinkedIn Scheduled Posts (Milestone 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose a LinkedIn feed post with real LinkedIn-native rich formatting (bold/italic/underline/lists via Unicode, hashtags, links), schedule it for an explicit date/time (including "now"), and have the existing companion-browser worker publish it unattended — no cadence queue, no @mentions, no images yet (Milestones 2 and 3).

**Architecture:** New surface area alongside (not inside) the existing outreach campaign system. A pure `src/shared/linkedin-post-format.ts` module owns the structured-run content model and the selection-driven toolbar logic; a new `linkedin_posts` table and `posts.ts` store hold drafts/scheduled posts; a new `driver-post.ts` (own selector table, mirrors `driver-engage.ts`'s per-surface pattern) drives the actual LinkedIn compose flow; a new `runLinkedInPostTick` job, wired into the existing `linkedinCycle` in `src/worker/index.ts`, is the ONLY thing that ever calls it — confirmed by grep that `src/server/app.ts` never imports the driver, so "publish now" is sugar for `scheduled_at = now()`, not a synchronous API call.

**Tech Stack:** TypeScript, Express, PostgreSQL (`pg`, `?`-placeholder `Db.prepare().get/.all/.run()`), zod, React 18, vitest, Playwright (optional dependency, worker process only).

## Global Constraints

- **PostgreSQL only.** No SQLite, no embedded fallback.
- **`src/server/app.ts` (and anything it imports) may never import from `./linkedin/driver.js` or any `driver-*.js` file.** Verified by grep against the current tree — Playwright is an optional 400MB dependency the API/marketing build must keep compiling without. Only `local-worker.ts` / `jobs.ts`, running inside `src/worker/index.ts`, may touch a driver.
- **Post bodies are typed with `human.ts`'s existing `typeLike`, never `.fill()` directly.** `human.ts`'s own header explains why: text that materializes in a composer in one `input` event with no preceding keystroke is one of the loudest automation signals LinkedIn's telemetry catches. `typeLike` already splits on `\n` with `Shift+Enter`, which is exactly what block-per-paragraph rendering needs — do not reinvent a bulk-insert path.
- **Each LinkedIn surface keeps its own DOM selector table**, per `driver-engage.ts`'s existing precedent (its own `ENGAGE_SELECTORS`, not additions to `driver.ts`'s shared `SELECTORS`). `driver-post.ts` follows the same shape: a local `POST_SELECTORS` const, a local `fail`/`present`/`detectWall`, importing only _types_ from `driver.ts` at module scope (never a live binding), which is what keeps the two files' mutual imports safe to resolve.
- **"Posted" means `linkedin_posts.status = 'posted'`, nothing earlier.** The composer's "Publish now" button schedules for immediate pickup (`scheduled_at = now()`); it must never claim the post went out synchronously — it didn't, and can't (previous constraint).
- **No React component tests.** This codebase's vitest runs in the `node` environment with no jsdom configured (see `vitest.config.ts`). Interactive/derived logic (Unicode rendering, selection→style toggling) lives in the pure `src/shared/linkedin-post-format.ts` module and is tested there, not through a rendered component.
- Migrations are additive-only and numbered sequentially; the last one in the tree is `082_outreach_thread_content.sql`, so this plan's migration is `083_linkedin_posts.sql`.
- DB-touching tests run via `npx tsx scripts/test-with-postgres.ts <path>`; pure-logic tests run via `npm run test:unit` (`vitest run <path>` also works for one file during iteration).
- Spec: `docs/superpowers/specs/2026-08-19-linkedin-scheduled-posts-design.md`.

---

### Task 1: Content model and the Unicode formatting renderer

The pure core everything else depends on: the `PostRun`/`PostBlock` types, `renderPostBody` (the ONE function both the live preview and the driver call, so preview and published text can never drift), and `applyStyleToSelection` — the select-text-click-a-button mechanics the composer's toolbar needs (this is the piece that answers "select text and click the button").

**Files:**

- Create: `src/shared/linkedin-post-format.ts`
- Test: `src/shared/linkedin-post-format.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `PostRun`, `PostBlock`, `PostStyle` types; `renderPostBody(blocks: PostBlock[]): string`; `applyStyleToSelection(blocks: PostBlock[], selection: { start: RunPosition; end: RunPosition }, style: 'bold' | 'italic' | 'underline'): PostBlock[]`; `RunPosition = { block: number; run: number; offset: number }`; `plainTextLength(blocks: PostBlock[]): number`.

- [ ] **Step 1: Write the failing tests**

`src/shared/linkedin-post-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  applyStyleToSelection,
  plainTextLength,
  renderPostBody,
  type PostBlock
} from './linkedin-post-format';

function block(...runs: PostBlock['runs']): PostBlock {
  return { runs };
}

describe('renderPostBody', () => {
  it('renders bold, italic and underline as the sans-serif Unicode block', () => {
    const blocks: PostBlock[] = [
      block(
        { type: 'text', text: 'Hi ' },
        { type: 'text', text: 'Bold', bold: true },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'Italic', italic: true }
      )
    ];
    expect(renderPostBody(blocks)).toBe('Hi 𝗕𝗼𝗹𝗱 and 𝘐𝘵𝗮𝗹𝗶𝗰');
  });

  it('leaves punctuation, spaces and digits-in-mixed-text unstyled inside a styled run, silently', () => {
    const blocks: PostBlock[] = [block({ type: 'text', text: 'Q3 2026!', bold: true })];
    // Q -> bold sans, 3 -> bold digit, space passes through, 2026 -> bold digits, '!' passes through.
    const rendered = renderPostBody(blocks);
    expect(rendered).toContain(' ');
    expect(rendered.endsWith('!')).toBe(true);
    expect(rendered).not.toContain('Q3'); // the Q and 3 both got replaced with styled code points
  });

  it('composes bold+italic+underline: the bold-italic glyph, then a combining underline per character', () => {
    const blocks: PostBlock[] = [
      block({ type: 'text', text: 'Hi', bold: true, italic: true, underline: true })
    ];
    const rendered = renderPostBody(blocks);
    expect([...rendered]).toHaveLength(4); // 2 styled chars + 2 combining marks
    expect(rendered.includes('̲')).toBe(true);
  });

  it('never corrupts astral bold/italic characters by indexing UTF-16 code units', () => {
    const blocks: PostBlock[] = [block({ type: 'text', text: 'ab', bold: true })];
    const rendered = renderPostBody(blocks);
    // Each bold letter is a surrogate pair (2 UTF-16 units); 2 letters -> 4 units, 2 code points.
    expect(rendered.length).toBe(4);
    expect([...rendered]).toHaveLength(2);
  });

  it('joins blocks with real newlines and renders list prefixes as plain text', () => {
    const blocks: PostBlock[] = [
      block({ type: 'text', text: 'Intro' }),
      { runs: [{ type: 'text', text: 'First' }], list: 'bullet' },
      { runs: [{ type: 'text', text: 'Second' }], list: 'bullet' }
    ];
    expect(renderPostBody(blocks)).toBe('Intro\n• First\n• Second');
  });

  it('numbers a numbered block by its position among consecutive numbered blocks', () => {
    const blocks: PostBlock[] = [
      { runs: [{ type: 'text', text: 'One' }], list: 'numbered' },
      { runs: [{ type: 'text', text: 'Two' }], list: 'numbered' },
      block({ type: 'text', text: 'Not numbered' }),
      { runs: [{ type: 'text', text: 'Restarts' }], list: 'numbered' }
    ];
    expect(renderPostBody(blocks)).toBe('1. One\n2. Two\nNot numbered\n1. Restarts');
  });

  it('renders a mention run as its display text, and a break run as a line break within a block', () => {
    const blocks: PostBlock[] = [
      block(
        { type: 'text', text: 'Thanks ' },
        { type: 'mention', displayText: 'Jane Doe', entityKind: 'person' },
        { type: 'break' },
        { type: 'text', text: 'for the intro.' }
      )
    ];
    expect(renderPostBody(blocks)).toBe('Thanks Jane Doe\nfor the intro.');
  });
});

describe('applyStyleToSelection', () => {
  it('splits a run at the selection boundaries and styles only the middle piece', () => {
    const blocks: PostBlock[] = [block({ type: 'text', text: 'Some bold word more.' })];
    // Selecting "bold word" (offsets 5..14) and toggling bold on.
    const next = applyStyleToSelection(
      blocks,
      { start: { block: 0, run: 0, offset: 5 }, end: { block: 0, run: 0, offset: 14 } },
      'bold'
    );
    expect(next[0].runs.map((r) => (r.type === 'text' ? [r.text, !!r.bold] : null))).toEqual([
      ['Some ', false],
      ['bold word', true],
      [' more.', false]
    ]);
  });

  it('toggles the style back off on a second call with the same selection', () => {
    const once = applyStyleToSelection(
      [block({ type: 'text', text: 'Some bold word more.' })],
      { start: { block: 0, run: 0, offset: 5 }, end: { block: 0, run: 0, offset: 14 } },
      'bold'
    );
    const twice = applyStyleToSelection(
      once,
      { start: { block: 0, run: 0, offset: 5 }, end: { block: 0, run: 1, offset: 9 } },
      'bold'
    );
    expect(renderPostBody(twice)).toBe(
      renderPostBody([block({ type: 'text', text: 'Some bold word more.' })])
    );
  });

  it('re-merges adjacent runs left with identical style flags after toggling off', () => {
    const blocks: PostBlock[] = [
      block(
        { type: 'text', text: 'Some ', bold: true },
        { type: 'text', text: 'bold word', bold: true },
        { type: 'text', text: ' more.', bold: true }
      )
    ];
    // Selection spans the WHOLE block (run 0 offset 0 through run 2 offset 6,
    // the full length of ' more.') -- not just the middle run. A selection
    // limited to the middle run has no correct implementation that produces a
    // single merged run: toggling only the selected text off necessarily
    // leaves it different from its still-bold neighbors, so nothing merges.
    // This selection is what actually exercises "toggle off, then re-merge":
    // every run in the selection goes to bold:falsy and mergeAdjacent collapses
    // the three identically-unstyled pieces into one.
    const next = applyStyleToSelection(
      blocks,
      { start: { block: 0, run: 0, offset: 0 }, end: { block: 0, run: 2, offset: 6 } },
      'bold'
    );
    expect(next[0].runs).toHaveLength(1);
    expect(next[0].runs[0].text).toBe('Some bold word more.');
    // `withStyle` clears a style with `on || undefined`, not literal `false` --
    // both are falsy and every consumer in this module normalizes via
    // `Boolean(...)`/`?? false`, so assert falsy rather than the exact literal.
    expect(next[0].runs[0].bold).toBeFalsy();
  });
});

describe('plainTextLength', () => {
  it('counts text and mention display text, not the Unicode-rendered length', () => {
    const blocks: PostBlock[] = [
      block(
        { type: 'text', text: 'Hi', bold: true },
        { type: 'mention', displayText: 'Jane', entityKind: 'person' }
      )
    ];
    expect(plainTextLength(blocks)).toBe(6); // 'Hi' + 'Jane', pre-styling -- same code-point count as rendered
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/linkedin-post-format.test.ts`
Expected: FAIL — `./linkedin-post-format` has no exports yet.

- [ ] **Step 3: Implement the module**

`src/shared/linkedin-post-format.ts`:

```ts
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
  const selectedText = block.runs
    .slice(startRun, endRun + 1)
    .filter((r): r is Extract<PostRun, { type: 'text' }> => r.type === 'text');
  const alreadyOn = selectedText.length > 0 && selectedText.every((r) => styleOf(r, style));
  const targetOn = !alreadyOn;

  const finalRuns: PostRun[] = [];
  block.runs.forEach((run, index) => {
    if (index < startRun || index > endRun || run.type !== 'text') {
      finalRuns.push(run);
      return;
    }
    const from = index === startRun ? startOffset : 0;
    const to = index === endRun ? endOffset : [...run.text].length;
    const chars = [...run.text];
    const before = chars.slice(0, from).join('');
    const middle = chars.slice(from, to).join('');
    const after = chars.slice(to).join('');
    if (before) finalRuns.push({ ...run, text: before });
    if (middle) finalRuns.push(withStyle({ ...run, text: middle }, style, targetOn));
    if (after) finalRuns.push({ ...run, text: after });
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/linkedin-post-format.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/shared/linkedin-post-format.ts src/shared/linkedin-post-format.test.ts
git commit -m "linkedin: post content model, Unicode renderer, select-to-style toggling"
```

---

### Task 2: The `linkedin_posts` table and its store module

**Files:**

- Create: `migrations/083_linkedin_posts.sql`
- Create: `src/server/linkedin/posts.ts`
- Test: `src/server/linkedin/posts.test.ts`

**Interfaces:**

- Consumes: `PostBlock` from `../../shared/linkedin-post-format.js` (type only); `id`, `type Db` from `../db.js`; `OWNER_SEAT_KEY` from `./seats.js`.
- Produces: `LinkedInPost` type; `LinkedInPostsApiError` class; `createPost(db, input, now)`; `listPosts(db, workspaceId, filters)`; `getPost(db, workspaceId, id)`; `updatePost(db, workspaceId, id, patch, now)`; `cancelPost(db, workspaceId, id, now)`; `claimNextDuePost(db, workspaceId, now)`; `releasePostToScheduled(db, id, now)`; `markPostPublished(db, id, patch, now)`; `markPostFailed(db, id, error, now)`; `markPostMissed(db, id, now)`.

- [ ] **Step 1: Write the failing tests**

`src/server/linkedin/posts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { upsertSeat } from './seats.js';
import {
  cancelPost,
  claimNextDuePost,
  createPost,
  getPost,
  LinkedInPostsApiError,
  listPosts,
  markPostFailed,
  markPostMissed,
  markPostPublished,
  releasePostToScheduled,
  updatePost
} from './posts.js';

let db: Db;
const WORKSPACE_ID = 'ws_linkedin_posts_test';
const NOW = new Date('2026-08-19T09:00:00.000Z');
const BLOCKS = [{ runs: [{ type: 'text' as const, text: 'Hello world' }] }];

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE_ID, 'Posts test', NOW.toISOString());
  await upsertSeat(db, WORKSPACE_ID, { label: 'Owner', timezone: 'UTC' }, NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db?.close();
});

describe('createPost', () => {
  it('files a draft with no scheduledAt', async () => {
    const post = await createPost(
      db,
      {
        id: 'lipost_1',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    );
    expect(post.status).toBe('draft');
    expect(post.scheduledAt).toBeNull();
  });

  it('refuses to schedule with no scheduledAt', async () => {
    await expect(
      createPost(
        db,
        {
          id: 'lipost_2',
          workspaceId: WORKSPACE_ID,
          blocks: BLOCKS,
          status: 'scheduled',
          createdBy: 'usr_1'
        },
        NOW
      )
    ).rejects.toBeInstanceOf(LinkedInPostsApiError);
  });

  it('files a scheduled post for a named future time', async () => {
    const post = await createPost(
      db,
      {
        id: 'lipost_3',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-20T09:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    expect(post.status).toBe('scheduled');
    expect(post.scheduledAt).toBe('2026-08-20T09:00:00.000Z');
  });
});

describe('listPosts / getPost', () => {
  it("lists only the calling workspace's posts, newest scheduled first", async () => {
    await createPost(
      db,
      {
        id: 'lipost_a',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    );
    await createPost(
      db,
      {
        id: 'lipost_b',
        workspaceId: 'ws_other',
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    ).catch(() => {});
    const posts = await listPosts(db, WORKSPACE_ID, {});
    expect(posts.map((p) => p.id)).toEqual(['lipost_a']);
    expect(await getPost(db, WORKSPACE_ID, 'lipost_a')).toMatchObject({ id: 'lipost_a' });
    expect(await getPost(db, WORKSPACE_ID, 'nope')).toBeUndefined();
  });
});

describe('updatePost / cancelPost', () => {
  it('edits a draft, but refuses once the post is posted', async () => {
    const draft = await createPost(
      db,
      {
        id: 'lipost_edit',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    );
    const edited = await updatePost(
      db,
      WORKSPACE_ID,
      draft.id,
      { blocks: [{ runs: [{ type: 'text', text: 'Edited' }] }] },
      NOW
    );
    expect(edited.blocks).toEqual([{ runs: [{ type: 'text', text: 'Edited' }] }]);

    await markPostPublished(db, draft.id, { postedUrl: null }, NOW);
    await expect(
      updatePost(db, WORKSPACE_ID, draft.id, { blocks: BLOCKS }, NOW)
    ).rejects.toBeInstanceOf(LinkedInPostsApiError);
  });

  it('cancels a scheduled post but refuses a posted one', async () => {
    const post = await createPost(
      db,
      {
        id: 'lipost_cancel',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-20T09:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const canceled = await cancelPost(db, WORKSPACE_ID, post.id, NOW);
    expect(canceled.status).toBe('canceled');
    await markPostPublished(db, post.id, { postedUrl: null }, NOW); // force-advance for the negative case below
    await expect(cancelPost(db, WORKSPACE_ID, post.id, NOW)).rejects.toBeInstanceOf(
      LinkedInPostsApiError
    );
  });
});

describe('claimNextDuePost', () => {
  it('claims a due post, moving it to publishing, oldest scheduledAt first', async () => {
    await createPost(
      db,
      {
        id: 'lipost_later',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T09:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    await createPost(
      db,
      {
        id: 'lipost_earlier',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    expect(claimed?.id).toBe('lipost_earlier');
    expect(claimed?.status).toBe('publishing');
    expect(await getPost(db, WORKSPACE_ID, 'lipost_earlier')).toMatchObject({
      status: 'publishing'
    });
  });

  it('never claims a post scheduled in the future', async () => {
    await createPost(
      db,
      {
        id: 'lipost_future',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T10:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    expect(await claimNextDuePost(db, WORKSPACE_ID, NOW)).toBeUndefined();
  });

  it('releasing a claimed post back to scheduled makes it claimable again', async () => {
    await createPost(
      db,
      {
        id: 'lipost_release',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    await releasePostToScheduled(db, claimed!.id, NOW);
    const reclaimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    expect(reclaimed?.id).toBe('lipost_release');
  });
});

describe('markPostFailed / markPostMissed', () => {
  it('records the failure kind and detail, terminal, not reclaimable', async () => {
    await createPost(
      db,
      {
        id: 'lipost_fail',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    await markPostFailed(db, claimed!.id, { kind: 'selector_drift', detail: 'gone' }, NOW);
    const post = await getPost(db, WORKSPACE_ID, claimed!.id);
    expect(post).toMatchObject({
      status: 'failed',
      error: { kind: 'selector_drift', detail: 'gone' }
    });
    expect(await claimNextDuePost(db, WORKSPACE_ID, NOW)).toBeUndefined();
  });

  it('marks a stale claimed post missed', async () => {
    await createPost(
      db,
      {
        id: 'lipost_missed',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T00:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    await markPostMissed(db, claimed!.id, NOW);
    expect(await getPost(db, WORKSPACE_ID, claimed!.id)).toMatchObject({ status: 'missed' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/linkedin/posts.test.ts`
Expected: FAIL — `./posts.js` does not exist.

- [ ] **Step 3: Write the migration**

`migrations/083_linkedin_posts.sql`:

```sql
-- Scheduled LinkedIn feed posts, independent of the outreach campaign tables:
-- a post targets no lead, so it has no place in linkedin_actions/linkedin_campaigns.
-- See docs/superpowers/specs/2026-08-19-linkedin-scheduled-posts-design.md.
--
-- The full shape (media, link_in_comment, sequence_position, mention_warnings)
-- is created now even though Milestone 1 only reads/writes a subset, so later
-- milestones (cadence queue, mentions/media) only ADD reads and writes, never
-- another ALTER TABLE on a table already carrying live rows.
CREATE TABLE linkedin_posts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seat_key TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','publishing','posted','failed','missed','canceled')),
  blocks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  link_in_comment BOOLEAN NOT NULL DEFAULT FALSE,
  scheduled_at TIMESTAMPTZ,
  sequence_position INTEGER,
  published_at TIMESTAMPTZ,
  posted_url TEXT,
  error_json JSONB,
  mention_warnings_json JSONB,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- The worker tick's whole query: due posts for one workspace, oldest first.
CREATE INDEX linkedin_posts_due_idx ON linkedin_posts (workspace_id, status, scheduled_at);
-- The composer's queue/history list: one seat's posts, newest first.
CREATE INDEX linkedin_posts_seat_idx ON linkedin_posts (workspace_id, seat_key, status, created_at DESC);
```

- [ ] **Step 4: Run the migration**

Run: `npm run migrate` (or the project's existing migrate script — confirm the exact command in `package.json`'s `scripts` block if `migrate` is not it; `test-with-postgres.ts` also runs migrations automatically against its throwaway database, so Step 2's rerun after Step 5 below exercises this migration regardless).

- [ ] **Step 5: Implement the store module**

`src/server/linkedin/posts.ts`:

```ts
import { id, type Db } from '../db.js';
import type { PostBlock } from '../../shared/linkedin-post-format.js';
import { OWNER_SEAT_KEY } from './seats.js';

export class LinkedInPostsApiError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'LinkedInPostsApiError';
  }
}

export type LinkedInPostStatus =
  'draft' | 'scheduled' | 'publishing' | 'posted' | 'failed' | 'missed' | 'canceled';

export interface LinkedInPost {
  id: string;
  workspaceId: string;
  seatKey: string;
  status: LinkedInPostStatus;
  blocks: PostBlock[];
  scheduledAt: string | null;
  publishedAt: string | null;
  postedUrl: string | null;
  error: { kind: string; detail: string } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PostRow {
  id: string;
  workspace_id: string;
  seat_key: string;
  status: LinkedInPostStatus;
  blocks_json: unknown;
  scheduled_at: string | null;
  published_at: string | null;
  posted_url: string | null;
  error_json: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// TIMESTAMPTZ columns are formatted here rather than left to the driver's raw
// text output ('2026-08-20 09:00:00+00', not JS-comparable) -- the same
// TO_CHAR(... AT TIME ZONE 'UTC', ...) idiom every other store module in this
// codebase uses for the same reason (seats.ts's SEAT_COLUMNS, runner.ts's own
// UTC_ISO constant, outreach/store.ts, etc).
const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const POST_COLUMNS = `
  id, workspace_id, seat_key, status, blocks_json,
  TO_CHAR(scheduled_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS scheduled_at,
  TO_CHAR(published_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS published_at,
  posted_url, error_json, created_by,
  TO_CHAR(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at,
  TO_CHAR(updated_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS updated_at
`;

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toPost(row: PostRow): LinkedInPost {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    status: row.status,
    blocks: (parseJson(row.blocks_json) as PostBlock[]) ?? [],
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    postedUrl: row.posted_url,
    error: (parseJson(row.error_json) as { kind: string; detail: string } | null) ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const EDITABLE_STATUSES: readonly LinkedInPostStatus[] = ['draft', 'scheduled'];

export interface PostInsert {
  id: string;
  workspaceId: string;
  seatKey?: string;
  blocks: PostBlock[];
  status?: 'draft' | 'scheduled';
  scheduledAt?: string | null;
  createdBy?: string | null;
}

export async function createPost(db: Db, input: PostInsert, now: Date): Promise<LinkedInPost> {
  const status = input.status ?? 'draft';
  if (status === 'scheduled' && !input.scheduledAt) {
    throw new LinkedInPostsApiError('scheduledAt is required to schedule a post.');
  }
  const timestamp = now.toISOString();
  const row = await db
    .prepare(
      `
    INSERT INTO linkedin_posts (
      id, workspace_id, seat_key, status, blocks_json, scheduled_at, created_by, created_at, updated_at
    ) VALUES (?,?,?,?,?::jsonb,?,?,?,?)
    RETURNING ${POST_COLUMNS}
  `
    )
    .get<PostRow>(
      input.id,
      input.workspaceId,
      input.seatKey ?? OWNER_SEAT_KEY,
      status,
      JSON.stringify(input.blocks),
      input.scheduledAt ?? null,
      input.createdBy ?? null,
      timestamp,
      timestamp
    );
  return toPost(row!);
}

export async function listPosts(
  db: Db,
  workspaceId: string,
  filters: { seatKey?: string; status?: LinkedInPostStatus; limit?: number }
): Promise<LinkedInPost[]> {
  const conditions = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (filters.seatKey) {
    conditions.push('seat_key = ?');
    params.push(filters.seatKey);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  params.push(filters.limit ?? 100);
  const rows = await db
    .prepare(
      `
    SELECT ${POST_COLUMNS} FROM linkedin_posts
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(scheduled_at, created_at) DESC
    LIMIT ?
  `
    )
    .all<PostRow>(...params);
  return rows.map(toPost);
}

export async function getPost(
  db: Db,
  workspaceId: string,
  id: string
): Promise<LinkedInPost | undefined> {
  const row = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM linkedin_posts WHERE workspace_id = ? AND id = ?`)
    .get<PostRow>(workspaceId, id);
  return row ? toPost(row) : undefined;
}

function assertEditable(post: LinkedInPost): void {
  if (!EDITABLE_STATUSES.includes(post.status)) {
    throw new LinkedInPostsApiError(
      `This post is '${post.status}' and can no longer be edited or canceled.`,
      409
    );
  }
}

export async function updatePost(
  db: Db,
  workspaceId: string,
  postId: string,
  patch: { blocks?: PostBlock[]; status?: 'draft' | 'scheduled'; scheduledAt?: string | null },
  now: Date
): Promise<LinkedInPost> {
  const existing = await getPost(db, workspaceId, postId);
  if (!existing) throw new LinkedInPostsApiError('No such post.', 404);
  assertEditable(existing);
  const nextStatus = patch.status ?? existing.status;
  const nextScheduledAt =
    patch.scheduledAt !== undefined ? patch.scheduledAt : existing.scheduledAt;
  if (nextStatus === 'scheduled' && !nextScheduledAt) {
    throw new LinkedInPostsApiError('scheduledAt is required to schedule a post.');
  }
  const row = await db
    .prepare(
      `
    UPDATE linkedin_posts
    SET blocks_json = COALESCE(?::jsonb, blocks_json),
        status = ?,
        scheduled_at = ?,
        updated_at = ?
    WHERE workspace_id = ? AND id = ?
    RETURNING ${POST_COLUMNS}
  `
    )
    .get<PostRow>(
      patch.blocks ? JSON.stringify(patch.blocks) : null,
      nextStatus,
      nextScheduledAt,
      now.toISOString(),
      workspaceId,
      postId
    );
  return toPost(row!);
}

export async function cancelPost(
  db: Db,
  workspaceId: string,
  postId: string,
  now: Date
): Promise<LinkedInPost> {
  const existing = await getPost(db, workspaceId, postId);
  if (!existing) throw new LinkedInPostsApiError('No such post.', 404);
  assertEditable(existing);
  const row = await db
    .prepare(
      `
    UPDATE linkedin_posts SET status = 'canceled', updated_at = ?
    WHERE workspace_id = ? AND id = ?
    RETURNING ${POST_COLUMNS}
  `
    )
    .get<PostRow>(now.toISOString(), workspaceId, postId);
  return toPost(row!);
}

/**
 * Atomically claim ONE due post and move it to 'publishing', so two worker
 * replicas ticking at once can never both pick the same row -- `FOR UPDATE
 * SKIP LOCKED` inside the subquery is Postgres's standard "claim one queued
 * row, race-free, no shared lease table needed" idiom.
 */
export async function claimNextDuePost(
  db: Db,
  workspaceId: string,
  now: Date
): Promise<LinkedInPost | undefined> {
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `
      UPDATE linkedin_posts
      SET status = 'publishing', updated_at = ?
      WHERE id = (
        SELECT id FROM linkedin_posts
        WHERE workspace_id = ? AND status = 'scheduled' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING ${POST_COLUMNS}
    `
      )
      .get<PostRow>(now.toISOString(), workspaceId, now.toISOString());
    return row ? toPost(row) : undefined;
  });
}

/** The companion was offline, or the wrong account was signed in -- not the post's fault. Retry next tick. */
export async function releasePostToScheduled(db: Db, postId: string, now: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE linkedin_posts SET status = 'scheduled', updated_at = ? WHERE id = ? AND status = 'publishing'`
    )
    .run(now.toISOString(), postId);
}

export async function markPostPublished(
  db: Db,
  postId: string,
  patch: { postedUrl: string | null },
  now: Date
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE linkedin_posts SET status = 'posted', published_at = ?, posted_url = ?, updated_at = ? WHERE id = ?
  `
    )
    .run(now.toISOString(), patch.postedUrl, now.toISOString(), postId);
}

export async function markPostFailed(
  db: Db,
  postId: string,
  error: { kind: string; detail: string },
  now: Date
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE linkedin_posts SET status = 'failed', error_json = ?::jsonb, updated_at = ? WHERE id = ?
  `
    )
    .run(JSON.stringify(error), now.toISOString(), postId);
}

export async function markPostMissed(db: Db, postId: string, now: Date): Promise<void> {
  await db
    .prepare(`UPDATE linkedin_posts SET status = 'missed', updated_at = ? WHERE id = ?`)
    .run(now.toISOString(), postId);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/linkedin/posts.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add migrations/083_linkedin_posts.sql src/server/linkedin/posts.ts src/server/linkedin/posts.test.ts
git commit -m "linkedin: linkedin_posts table and store module"
```

---

### Task 3: API routes

**Files:**

- Modify: `src/server/app.ts` (new imports near the existing LinkedIn campaign imports; new routes near the existing `/api/linkedin/campaigns` routes)
- Test: `src/server/linkedin/api.test.ts` (append a new `describe('LinkedIn posts', ...)` block)

**Interfaces:**

- Consumes: everything from Task 2 (`createPost`, `listPosts`, `getPost`, `updatePost`, `cancelPost`, `LinkedInPostsApiError`), `PostBlock` type from Task 1, the existing `linkedinRoute` wrapper and `linkedinSeatKeySchema`.
- Produces: `GET/POST /api/linkedin/posts`, `GET/PATCH/DELETE /api/linkedin/posts/:id`, `POST /api/linkedin/posts/:id/publish-now`.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/linkedin/api.test.ts` (reuses the file's existing `db`, `app`, `seedSession`, `as`, `seat` helpers already in scope):

```ts
describe('LinkedIn posts', () => {
  const BLOCKS = [{ runs: [{ type: 'text', text: 'Hello world' }] }];

  it('creates a draft, lists it, edits it, then cancels it', async () => {
    const token = await seedSession(WORKSPACE_A, 'A');
    await seat(WORKSPACE_A);
    const created = await as(token).post('/api/linkedin/posts').send({ blocks: BLOCKS });
    expect(created.status).toBe(200);
    expect(created.body.post.status).toBe('draft');

    const listed = await as(token).get('/api/linkedin/posts');
    expect(listed.body.posts.map((p: { id: string }) => p.id)).toContain(created.body.post.id);

    const edited = await as(token)
      .patch(`/api/linkedin/posts/${created.body.post.id}`)
      .send({ blocks: [{ runs: [{ type: 'text', text: 'Edited' }] }] });
    expect(edited.body.post.blocks[0].runs[0].text).toBe('Edited');

    const canceled = await as(token).delete(`/api/linkedin/posts/${created.body.post.id}`);
    expect(canceled.body.post.status).toBe('canceled');
  });

  it('refuses to schedule with no scheduledAt, and refuses a post over 3000 characters', async () => {
    const token = await seedSession(WORKSPACE_A, 'A');
    await seat(WORKSPACE_A);
    const noTime = await as(token)
      .post('/api/linkedin/posts')
      .send({ blocks: BLOCKS, status: 'scheduled' });
    expect(noTime.status).toBe(400);

    const tooLong = await as(token)
      .post('/api/linkedin/posts')
      .send({ blocks: [{ runs: [{ type: 'text', text: 'x'.repeat(3001) }] }] });
    expect(tooLong.status).toBe(400);
  });

  it('publish-now sets scheduledAt to now and status to scheduled -- never synchronously posted', async () => {
    const token = await seedSession(WORKSPACE_A, 'A');
    await seat(WORKSPACE_A);
    const created = await as(token).post('/api/linkedin/posts').send({ blocks: BLOCKS });
    const published = await as(token).post(
      `/api/linkedin/posts/${created.body.post.id}/publish-now`
    );
    expect(published.body.post.status).toBe('scheduled');
    expect(published.body.post.scheduledAt).toBeTruthy();
  });

  it('scopes posts to the calling workspace', async () => {
    const tokenA = await seedSession(WORKSPACE_A, 'A');
    const tokenB = await seedSession(WORKSPACE_B, 'B');
    await seat(WORKSPACE_A);
    await seat(WORKSPACE_B);
    const created = await as(tokenA).post('/api/linkedin/posts').send({ blocks: BLOCKS });
    const fromB = await as(tokenB).get(`/api/linkedin/posts/${created.body.post.id}`);
    expect(fromB.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/linkedin/api.test.ts`
Expected: FAIL — 404s, since the routes do not exist yet.

- [ ] **Step 3: Add the routes**

In `src/server/app.ts`, alongside the existing `import { LinkedInApiError, ... } from './linkedin/campaigns.js';` block, add:

```ts
import {
  cancelPost,
  createPost,
  getPost,
  LinkedInPostsApiError,
  listPosts,
  updatePost,
  type LinkedInPostStatus
} from './linkedin/posts.js';
import { plainTextLength } from '../shared/linkedin-post-format.js';
```

Near the existing zod schemas for LinkedIn (beside `linkedinCampaignListSchema`), add:

```ts
const postRunSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().min(1),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional()
  }),
  z.object({
    type: z.literal('mention'),
    displayText: z.string().min(1).max(200),
    entityKind: z.enum(['person', 'page']),
    resolvedUrn: z.string().optional()
  }),
  z.object({ type: z.literal('break') })
]);
const postBlockSchema = z.object({
  runs: z.array(postRunSchema).min(1),
  list: z.enum(['bullet', 'numbered']).optional()
});
const LINKEDIN_POST_MAX_CHARS = 3000;
const postBlocksSchema = z
  .array(postBlockSchema)
  .min(1)
  .max(200)
  .refine((blocks) => plainTextLength(blocks) <= LINKEDIN_POST_MAX_CHARS, {
    message: `A LinkedIn post is capped at ${LINKEDIN_POST_MAX_CHARS} characters.`
  });
const linkedinPostCreateSchema = z
  .object({
    seatKey: linkedinSeatKeySchema.optional(),
    blocks: postBlocksSchema,
    status: z.enum(['draft', 'scheduled']).default('draft'),
    scheduledAt: z.string().datetime({ offset: true }).optional()
  })
  .refine((v) => v.status !== 'scheduled' || Boolean(v.scheduledAt), {
    message: 'scheduledAt is required to schedule a post',
    path: ['scheduledAt']
  });
const linkedinPostUpdateSchema = z
  .object({
    blocks: postBlocksSchema.optional(),
    status: z.enum(['draft', 'scheduled']).optional(),
    scheduledAt: z.string().datetime({ offset: true }).nullable().optional()
  })
  .refine((v) => v.status !== 'scheduled' || v.scheduledAt !== undefined, {
    message: 'scheduledAt is required to schedule a post',
    path: ['scheduledAt']
  });
const linkedinPostListSchema = z.object({
  seatKey: linkedinSeatKeySchema.optional(),
  status: z
    .enum(['draft', 'scheduled', 'publishing', 'posted', 'failed', 'missed', 'canceled'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});
```

Near the existing `/api/linkedin/campaigns` routes, add:

```ts
app.get(
  '/api/linkedin/posts',
  linkedinRoute(async (req, res) => {
    const filters = linkedinPostListSchema.parse(req.query);
    res.json({ posts: await listPosts(db, req.auth!.workspaceId, filters) });
  })
);

app.post(
  '/api/linkedin/posts',
  linkedinRoute(async (req, res) => {
    const input = linkedinPostCreateSchema.parse(req.body ?? {});
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: req.auth!.workspaceId,
        ...(input.seatKey ? { seatKey: input.seatKey } : {}),
        blocks: input.blocks,
        status: input.status,
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        createdBy: req.auth!.userId
      },
      new Date()
    );
    res.json({ post });
  })
);

app.get(
  '/api/linkedin/posts/:id',
  linkedinRoute(async (req, res) => {
    const post = await getPost(db, req.auth!.workspaceId, req.params.id);
    if (!post) throw new LinkedInPostsApiError('No such post.', 404);
    res.json({ post });
  })
);

app.patch(
  '/api/linkedin/posts/:id',
  linkedinRoute(async (req, res) => {
    const input = linkedinPostUpdateSchema.parse(req.body ?? {});
    const post = await updatePost(db, req.auth!.workspaceId, req.params.id, input, new Date());
    res.json({ post });
  })
);

app.delete(
  '/api/linkedin/posts/:id',
  linkedinRoute(async (req, res) => {
    const post = await cancelPost(db, req.auth!.workspaceId, req.params.id, new Date());
    res.json({ post });
  })
);

/**
 * NOT a synchronous publish -- app.ts never opens a browser (see Global
 * Constraints). This sets scheduledAt to now, so the next worker tick (up to
 * AUTOMATION_INTERVAL_MS away, 60s by default) picks it up the same way an
 * explicitly-timed post is picked up.
 */
app.post(
  '/api/linkedin/posts/:id/publish-now',
  linkedinRoute(async (req, res) => {
    const post = await updatePost(
      db,
      req.auth!.workspaceId,
      req.params.id,
      { status: 'scheduled', scheduledAt: new Date().toISOString() },
      new Date()
    );
    res.json({ post });
  })
);
```

Also extend `linkedinRoute`'s catch clause to recognise `LinkedInPostsApiError` the same way it already recognises `LinkedInApiError`:

```ts
function linkedinRoute(handler: (req: AuthedRequest, res: Response) => Promise<unknown>) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof LinkedInApiError || error instanceof LinkedInPostsApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/linkedin/api.test.ts`
Expected: PASS, including every pre-existing case in the file (nothing above touches an existing route).

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/linkedin/api.test.ts
git commit -m "linkedin: posts API routes (create/list/edit/cancel/publish-now)"
```

---

### Task 4: Client API wrappers

**Files:**

- Modify: `src/client/api.ts`

**Interfaces:**

- Consumes: `LinkedInPost`, `LinkedInPostStatus` types from `../server/linkedin/posts` (type-only import, same convention as every other LinkedIn type in this file); `PostBlock` from `../shared/linkedin-post-format`.
- Produces: `listLinkedInPosts`, `createLinkedInPost`, `updateLinkedInPost`, `cancelLinkedInPost`, `publishLinkedInPostNow`.

- [ ] **Step 1: Add the type imports**

Near the existing `import type { LinkedInActionKind, LinkedInActionStatus } from '../server/linkedin/actions';` line in `src/client/api.ts`:

```ts
import type { LinkedInPost, LinkedInPostStatus } from '../server/linkedin/posts';
import type { PostBlock } from '../shared/linkedin-post-format';
```

- [ ] **Step 2: Add the wrapper functions**

Near the existing `getLinkedInActions`/campaign functions in `src/client/api.ts`:

```ts
export async function listLinkedInPosts(
  filters: { seatKey?: string; status?: LinkedInPostStatus; limit?: number } = {}
): Promise<LinkedInPost[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const result = await request<{ posts: LinkedInPost[] }>(
    `/api/linkedin/posts${query.size ? `?${query}` : ''}`
  );
  return result.posts;
}

export async function createLinkedInPost(input: {
  seatKey?: string;
  blocks: PostBlock[];
  status?: 'draft' | 'scheduled';
  scheduledAt?: string;
}): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>('/api/linkedin/posts', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.post;
}

export async function updateLinkedInPost(
  postId: string,
  patch: { blocks?: PostBlock[]; status?: 'draft' | 'scheduled'; scheduledAt?: string | null }
): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>(
    `/api/linkedin/posts/${encodeURIComponent(postId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch)
    }
  );
  return result.post;
}

export async function cancelLinkedInPost(postId: string): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>(
    `/api/linkedin/posts/${encodeURIComponent(postId)}`,
    {
      method: 'DELETE'
    }
  );
  return result.post;
}

export async function publishLinkedInPostNow(postId: string): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>(
    `/api/linkedin/posts/${encodeURIComponent(postId)}/publish-now`,
    {
      method: 'POST'
    }
  );
  return result.post;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — this task adds no new runtime behavior to verify by test (per Global Constraints, no React component tests; these wrappers are exercised end-to-end by Tasks 7/8's manual run-through and were already exercised server-side by Task 3).

- [ ] **Step 4: Commit**

```bash
git add src/client/api.ts
git commit -m "linkedin: client API wrappers for posts"
```

---

### Task 5: The driver — `publishPost`

**Files:**

- Create: `src/server/linkedin/driver-post.ts`
- Modify: `src/server/linkedin/driver.ts` (type-only additions: `LinkedInFailureKind` gains `'compose_unavailable'`; `LinkedInDriver` gains optional `publishPost`; `playwrightDriver` wires it in)
- Test: `src/server/linkedin/driver-post.test.ts`

**Interfaces:**

- Consumes: `LinkedInPage`, `LinkedInDriverResult`, `LinkedInFailureKind` types from `./driver.js`; `hoverClick`, `settle`, `typeLike` from `./human.js`.
- Produces: `publishPost(page: LinkedInPage, body: string): Promise<LinkedInDriverResult>`; `POST_SELECTORS` (exported for the test file, same pattern `driver-engage.ts` uses for `ENGAGE_SELECTORS`).

- [ ] **Step 1: Write the failing tests**

`src/server/linkedin/driver-post.test.ts` (modeled directly on `driver-engage.test.ts`'s fake-page-as-counter-table style — no browser, no LinkedIn request, ever):

```ts
import { describe, expect, it } from 'vitest';
import type { LinkedInDriverResult, LinkedInLocator, LinkedInPage } from './driver.js';
import { POST_SELECTORS, publishPost } from './driver-post.js';

type Counts = Record<string, number>;

interface FakeSpec {
  counts?: Counts;
  clickError?: string;
  onClick?: (selector: string, counts: Counts) => void;
  /** Whether the compose box still matches AFTER the Post click -- simulates the modal not closing. */
  composeStaysOpenAfterSend?: boolean;
}

function fakePage(spec: FakeSpec = {}) {
  const counts: Counts = { ...(spec.counts ?? {}) };
  const clicked: string[] = [];
  const typed: string[] = [];
  let sent = false;

  const locator = (selector: string): LinkedInLocator => ({
    count: async () => {
      if (selector === POST_SELECTORS.postComposeBox && sent && !spec.composeStaysOpenAfterSend)
        return 0;
      return counts[selector] ?? 0;
    },
    first: () => locator(selector),
    click: async () => {
      clicked.push(selector);
      if (spec.clickError) throw new Error(spec.clickError);
      if (selector === POST_SELECTORS.publishPostButton) sent = true;
      spec.onClick?.(selector, counts);
    },
    fill: async (text: string) => {
      typed.push(text);
    },
    textContent: async () => null
  });

  const page: LinkedInPage = {
    goto: async () => null,
    url: () => 'https://www.linkedin.com/feed/',
    locator,
    waitForTimeout: async () => {}
  };

  return { page, counts, clicked, typed };
}

function expectFailure(result: LinkedInDriverResult, kind: LinkedInDriverResult['failureKind']) {
  expect(result.ok).toBe(false);
  expect(result.failureKind).toBe(kind);
}

describe('publishPost', () => {
  it('refuses an empty body without opening the composer', async () => {
    const { page, clicked } = fakePage();
    const result = await publishPost(page, '   ');
    expectFailure(result, 'compose_unavailable');
    expect(clicked).toEqual([]);
  });

  it('reports selector_drift when Start a post is not on the feed, and clicks nothing', async () => {
    const { page, clicked } = fakePage({ counts: {} });
    const result = await publishPost(page, 'Hello world');
    expectFailure(result, 'selector_drift');
    expect(clicked).toEqual([]);
  });

  it('types the body and clicks Post when everything is present', async () => {
    const { page, clicked, typed } = fakePage({
      counts: {
        [POST_SELECTORS.startPostButton]: 1,
        [POST_SELECTORS.postComposeBox]: 1,
        [POST_SELECTORS.publishPostButton]: 1
      }
    });
    const result = await publishPost(page, 'Hello world');
    expect(result.ok).toBe(true);
    expect(clicked).toEqual([POST_SELECTORS.startPostButton, POST_SELECTORS.publishPostButton]);
    expect(typed).toEqual(['Hello world']); // this fake has no pressSequentially, so typeLike falls back to fill()
  });

  it('reports unknown, not ok, when the composer is still open after the Post click', async () => {
    const { page } = fakePage({
      counts: {
        [POST_SELECTORS.startPostButton]: 1,
        [POST_SELECTORS.postComposeBox]: 1,
        [POST_SELECTORS.publishPostButton]: 1
      },
      composeStaysOpenAfterSend: true
    });
    const result = await publishPost(page, 'Hello world');
    expectFailure(result, 'unknown');
  });

  it('reports unknown when no Post control is found after typing (never selector_drift, since the body was already typed)', async () => {
    const { page } = fakePage({
      counts: {
        [POST_SELECTORS.startPostButton]: 1,
        [POST_SELECTORS.postComposeBox]: 1,
        [POST_SELECTORS.publishPostButton]: 0
      }
    });
    const result = await publishPost(page, 'Hello world');
    expectFailure(result, 'unknown');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/linkedin/driver-post.test.ts`
Expected: FAIL — `./driver-post.js` does not exist.

- [ ] **Step 3: Implement the driver**

`src/server/linkedin/driver-post.ts`:

```ts
/**
 * Publishing to the feed. Its own selector table, its own tiny `fail`/
 * `present`/`detectWall`, deliberately not shared with `driver.ts`'s SELECTORS
 * -- the same per-surface split `driver-engage.ts` already uses, so a drift
 * repair on the post composer never touches the profile/invite table and vice
 * versa. Imports only TYPES from `driver.ts` at module scope, which is what
 * keeps this file's and driver.ts's mutual imports safe to resolve (see
 * driver.ts's own header comment on the same point).
 */

import { hoverClick, settle, typeLike } from './human.js';
import type { LinkedInDriverResult, LinkedInFailureKind, LinkedInPage } from './driver.js';

const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;
const FEED_URL = 'https://www.linkedin.com/feed/';

/**
 * UNVERIFIED-AGAINST-LIVE-DOM, unlike the rest of this codebase's selector
 * tables (each of which carries a "measured against a live seat" note). These
 * three are written from general knowledge of LinkedIn's composer, not a
 * capture: confirm and correct them against a real account during rollout,
 * the same way `driver.ts`'s own header describes drift repair as the normal
 * steady state of a table like this one.
 */
export const POST_SELECTORS = {
  startPostButton: 'button[aria-label="Start a post"], button.share-box-feed-entry__trigger',
  postComposeBox:
    'div.ql-editor[contenteditable="true"], div[aria-label="Text editor for creating content"][contenteditable="true"]',
  publishPostButton: 'button.share-actions__primary-action, button[aria-label="Post"]',
  challengeForm:
    'form.challenge, input[name="pin"], #captcha-internal, iframe[title*="challenge" i]',
  restrictionNotice: 'text=/temporarily restricted|unusual activity|account has been restricted/i',
  limitWall:
    'text=/reached the weekly invitation limit|You.ve reached the limit|try again next week|invitation limit/i'
} as const;

const CHECKPOINT_PATH = /\/(checkpoint|uas\/login)\//i;

function fail(failureKind: LinkedInFailureKind, detail: string): LinkedInDriverResult {
  return { ok: false, failureKind, detail };
}

async function present(page: LinkedInPage, selector: string): Promise<boolean> {
  return (await page.locator(selector).count()) > 0;
}

async function detectWall(page: LinkedInPage): Promise<LinkedInFailureKind | null> {
  if (CHECKPOINT_PATH.test(page.url())) return 'challenge';
  if (await present(page, POST_SELECTORS.challengeForm)) return 'challenge';
  if (await present(page, POST_SELECTORS.restrictionNotice)) return 'limit_wall';
  if (await present(page, POST_SELECTORS.limitWall)) return 'limit_wall';
  return null;
}

/**
 * Publish a rendered post body to the feed. `body` is the already-rendered
 * Unicode string (`renderPostBody` in `../../shared/linkedin-post-format.js`)
 * -- this file knows nothing about runs, styles or blocks, only text and
 * where Shift+Enter has to go, which `typeLike` already handles for `\n`.
 */
export async function publishPost(page: LinkedInPage, body: string): Promise<LinkedInDriverResult> {
  if (!body.trim()) {
    return fail(
      'compose_unavailable',
      'Refusing to open the post composer with no rendered body to put in it.'
    );
  }

  try {
    await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await settle(page, 'post#feed');
  } catch (cause) {
    return fail(
      'selector_drift',
      `Could not open the feed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  const wall = await detectWall(page);
  if (wall)
    return fail(wall, `LinkedIn showed a ${wall} on the feed before the post composer could open.`);

  const start = page.locator(POST_SELECTORS.startPostButton);
  if ((await start.count()) === 0) {
    return fail(
      'selector_drift',
      `${POST_SELECTORS.startPostButton} did not match on the feed. Nothing was clicked.`
    );
  }

  try {
    await hoverClick(page, start.first(), 'post#start', CLICK_TIMEOUT_MS);
    await settle(page, 'post#composer-open');

    const composeWall = await detectWall(page);
    if (composeWall)
      return fail(composeWall, `LinkedIn answered the "Start a post" click with a ${composeWall}.`);

    const compose = page.locator(POST_SELECTORS.postComposeBox);
    if ((await compose.count()) === 0) {
      return fail(
        'compose_unavailable',
        `${POST_SELECTORS.postComposeBox} did not match after opening the composer; a draft may be open. Check it by hand.`
      );
    }

    await typeLike(page, compose.first(), body, 'post#body', CLICK_TIMEOUT_MS);

    const publish = page.locator(POST_SELECTORS.publishPostButton);
    if ((await publish.count()) === 0) {
      return fail(
        'unknown',
        'The composer holds the approved body but no Post control matched. Post or discard it by hand.'
      );
    }
    await hoverClick(page, publish.first(), 'post#send', CLICK_TIMEOUT_MS);
    await settle(page, 'post#after-send');

    const afterSend = await detectWall(page);
    if (afterSend) return fail(afterSend, `LinkedIn answered the post with a ${afterSend}.`);

    if ((await compose.count()) > 0) {
      return fail(
        'unknown',
        'The composer is still open after the Post click; whether it was published is unknown.'
      );
    }
    return { ok: true, failureKind: null };
  } catch (cause) {
    return fail(
      'unknown',
      `The post was interrupted after the composer opened: ${cause instanceof Error ? cause.message : String(cause)}. Whether it left is unknown.`
    );
  }
}
```

- [ ] **Step 4: Wire it into `driver.ts`**

In `src/server/linkedin/driver.ts`:

1. Widen the failure union:

```ts
export type LinkedInFailureKind =
  | 'not_found'
  | 'already_connected'
  | 'limit_wall'
  | 'challenge'
  | 'selector_drift'
  | 'unknown'
  | 'compose_unavailable';
```

2. Add an optional member to `LinkedInDriver` (beside the existing optional `readThread`/`listConversations`, same "a sibling file's capability, safely absent on any driver that doesn't have it" shape):

```ts
  /** Publish a rendered post to the feed. Optional -- see `driver-post.ts`, which owns its own selector table. */
  publishPost?(page: LinkedInPage, body: string): Promise<LinkedInDriverResult>;
```

3. Import and wire it into `playwrightDriver`, next to the existing `driver-engage.js` import:

```ts
import { publishPost } from './driver-post.js';
```

```ts
export const playwrightDriver: LinkedInDriver = {
  sendInvite,
  sendDm,
  sendReply,
  readThread,
  listConversations,
  viewProfile,
  followProfile,
  likeRecentPost,
  endorseSkills,
  publishPost,
  readSeat,
  isLoggedIn,
  sessionRecoveryReason,
  loginWithCredentials
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/server/linkedin/driver-post.test.ts`
Expected: PASS, all cases.

Also run the pre-existing driver suite to confirm the `LinkedInFailureKind`/`LinkedInDriver` widening broke nothing: `npx vitest run src/server/linkedin/driver.test.ts src/server/linkedin/driver-engage.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/server/linkedin/driver-post.ts src/server/linkedin/driver.ts src/server/linkedin/driver-post.test.ts
git commit -m "linkedin: publishPost driver routine"
```

---

### Task 6: The worker tick

**Files:**

- Modify: `src/server/linkedin/jobs.ts` (add `runLinkedInPostTick`)
- Modify: `src/worker/index.ts` (call it alongside `runLinkedInCampaignTick`)
- Test: `src/server/linkedin/jobs.test.ts` (append a new `describe('runLinkedInPostTick', ...)` block)

**Interfaces:**

- Consumes: `claimNextDuePost`, `releasePostToScheduled`, `markPostPublished`, `markPostFailed`, `markPostMissed` from `./posts.js`; `renderPostBody` from `../../shared/linkedin-post-format.js`; `openLinkedInSession`, `type LinkedInLocalWorkerConfig` and `confirmSeatAccount` (already imported in `jobs.ts`); `LinkedInJobOptions` (already defined and exported in `jobs.ts` itself, at line 178 -- it already carries `workspaceId`, `seatKey?`, `now?`, `page?`, `driver?`, `log?`, `accountConfirmed?`, so this task does NOT define a new options type, it reuses this one, matching the exact calling convention `syncLinkedInInbox`/`syncLinkedInThread`/`runLinkedInWithdrawals` already use: `(db, config, options: LinkedInJobOptions)`, workspaceId INSIDE options, not a separate positional argument).
- Produces: `runLinkedInPostTick(db, config, options: LinkedInJobOptions): Promise<{ published: number; missed: number }>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/linkedin/jobs.test.ts` (reuses the file's existing `db`/`WORKSPACE_ID`/`upsertSeat` setup already in `beforeEach`):

```ts
import { createPost, getPost } from './posts.js';
import { runLinkedInPostTick } from './jobs.js';

describe('runLinkedInPostTick', () => {
  const page: LinkedInPage = {
    goto: async () => null,
    url: () => 'https://www.linkedin.com/feed/',
    locator: () => {
      throw new Error('the fake driver below never touches the page directly');
    },
    waitForTimeout: async () => {}
  };

  function driverThatReturns(
    result: LinkedInDriverResult,
    seatRead = {
      ok: true as const,
      profileUrl: 'https://www.linkedin.com/in/connected/',
      name: 'Connected',
      connectionsCount: 10,
      degraded: []
    }
  ) {
    return {
      readSeat: async () => seatRead,
      isLoggedIn: async () => true,
      publishPost: async () => result,
      sendInvite: async () => {
        throw new Error('unused');
      },
      sendDm: async () => {
        throw new Error('unused');
      },
      sendReply: async () => {
        throw new Error('unused');
      },
      viewProfile: async () => {
        throw new Error('unused');
      },
      followProfile: async () => {
        throw new Error('unused');
      },
      likeRecentPost: async () => {
        throw new Error('unused');
      },
      endorseSkills: async () => {
        throw new Error('unused');
      },
      loginWithCredentials: async () => {
        throw new Error('unused');
      }
    } as unknown as LinkedInDriver;
  }

  const CONFIG = { enabled: true } as unknown as Parameters<typeof runLinkedInPostTick>[1];

  it('publishes a due post and marks it posted with the returned URL', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );

    const result = await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({
        ok: true,
        failureKind: null,
        externalRef: 'https://www.linkedin.com/feed/update/urn:li:activity:123/'
      }),
      accountConfirmed: true
    });

    expect(result.published).toBe(1);
    expect(await getPost(db, WORKSPACE_ID, post.id)).toMatchObject({
      status: 'posted',
      postedUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:123/'
    });
  });

  it('marks a post failed, not retried, when the driver reports a failure', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );

    await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({ ok: false, failureKind: 'selector_drift', detail: 'gone' }),
      accountConfirmed: true
    });

    const after = await getPost(db, WORKSPACE_ID, post.id);
    expect(after).toMatchObject({
      status: 'failed',
      error: { kind: 'selector_drift', detail: 'gone' }
    });

    // A second tick must not touch it again -- 'failed' is terminal, not re-queued.
    const second = await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({ ok: true, failureKind: null }),
      accountConfirmed: true
    });
    expect(second.published).toBe(0);
  });

  it('marks a post missed, not published, once it is more than 6 hours late', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const staleScheduledAt = new Date(NOW.getTime() - 7 * 3_600_000).toISOString();
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi' }] }],
        status: 'scheduled',
        scheduledAt: staleScheduledAt,
        createdBy: null
      },
      NOW
    );

    const result = await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({ ok: true, failureKind: null }),
      accountConfirmed: true
    });

    expect(result.missed).toBe(1);
    expect(result.published).toBe(0);
    expect(await getPost(db, WORKSPACE_ID, post.id)).toMatchObject({ status: 'missed' });
  });

  it('holds (releases back to scheduled) rather than fails when the companion session cannot open', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );

    // { enabled: false } makes openLinkedInSession report `ok: false` before any page/driver is touched.
    const result = await runLinkedInPostTick(
      db,
      { enabled: false } as unknown as Parameters<typeof runLinkedInPostTick>[1],
      { workspaceId: WORKSPACE_ID, now: NOW }
    );

    expect(result.published).toBe(0);
    expect(await getPost(db, WORKSPACE_ID, post.id)).toMatchObject({ status: 'scheduled' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/test-with-postgres.ts src/server/linkedin/jobs.test.ts`
Expected: FAIL — `runLinkedInPostTick` is not exported.

- [ ] **Step 3: Implement the tick**

In `src/server/linkedin/jobs.ts`, add the import and the function (near `runLinkedInCampaignTick`):

```ts
import {
  claimNextDuePost,
  markPostFailed,
  markPostMissed,
  markPostPublished,
  releasePostToScheduled
} from './posts.js';
import { renderPostBody } from '../../shared/linkedin-post-format.js';
```

```ts
/** Beyond this, a due post is stale enough that firing it late is worse than not firing it at all. */
const POST_GRACE_MS = 6 * 3_600_000;
/** Small and deliberate: posting is rare and slow (a full compose-and-type pass per post), unlike the invite/DM queue. */
const POSTS_PER_WORKSPACE_TICK = 5;

export async function runLinkedInPostTick(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions
): Promise<{ published: number; missed: number }> {
  const { workspaceId } = options;
  const now = options.now ?? new Date();
  const log = options.log ?? ((message: string) => console.log(message));
  let published = 0;
  let missed = 0;

  for (let i = 0; i < POSTS_PER_WORKSPACE_TICK; i += 1) {
    const claimed = await claimNextDuePost(db, workspaceId, now);
    if (!claimed) break;

    const scheduledAt = claimed.scheduledAt ? new Date(claimed.scheduledAt) : now;
    if (now.getTime() - scheduledAt.getTime() > POST_GRACE_MS) {
      await markPostMissed(db, claimed.id, now);
      missed += 1;
      continue;
    }

    const session = await openLinkedInSession(db, config, {
      workspaceId,
      seatKey: claimed.seatKey,
      now,
      ...(options.page ? { page: options.page } : {}),
      ...(options.driver ? { driver: options.driver } : {})
    });
    if (!session.ok) {
      await releasePostToScheduled(db, claimed.id, now);
      log(
        `LinkedIn post ${claimed.id} held for ${workspaceId}/${claimed.seatKey}: ${session.blocked}`
      );
      break; // nothing else will open a session for this workspace this tick either
    }

    const wrongAccount = options.accountConfirmed
      ? null
      : await confirmSeatAccount(db, session, workspaceId, claimed.seatKey);
    if (wrongAccount) {
      await releasePostToScheduled(db, claimed.id, now);
      log(`LinkedIn post ${claimed.id} held: ${wrongAccount}`);
      break;
    }

    const body = renderPostBody(claimed.blocks);
    const result = session.driver.publishPost
      ? await session.driver.publishPost(session.page, body)
      : {
          ok: false as const,
          failureKind: 'compose_unavailable' as const,
          detail: 'This driver has no publishPost capability.'
        };

    if (result.ok) {
      await markPostPublished(db, claimed.id, { postedUrl: result.externalRef ?? null }, now);
      published += 1;
    } else {
      await markPostFailed(
        db,
        claimed.id,
        { kind: result.failureKind ?? 'unknown', detail: result.detail ?? '' },
        now
      );
      log(`LinkedIn post ${claimed.id} failed (${result.failureKind}): ${result.detail}`);
    }
  }

  return { published, missed };
}
```

- [ ] **Step 4: Wire it into the worker loop**

In `src/worker/index.ts`, add `runLinkedInPostTick` to the existing import:

```ts
import {
  runLinkedInCampaignTick,
  runLinkedInPostTick,
  runLinkedInSideTasks
} from '../server/linkedin/jobs.js';
```

And call it right after the existing campaign tick, inside the same per-workspace loop:

```ts
for (const workspaceId of workspaces) {
  if (allowSeat && !(await allowSeat({ workspaceId }))) continue;
  await runLinkedInCampaignTick(db, workspaceId);
  await runLinkedInPostTick(db, runtime.linkedinLocalWorker, { workspaceId });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/linkedin/jobs.test.ts`
Expected: PASS, all cases, including every pre-existing test in the file.

- [ ] **Step 6: Typecheck the worker wiring**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/linkedin/jobs.ts src/worker/index.ts src/server/linkedin/jobs.test.ts
git commit -m "linkedin: runLinkedInPostTick, wired into the worker cycle"
```

---

### Task 7: Composer UI — write, format, preview, schedule

**Files:**

- Create: `src/client/LinkedInPosts.tsx`
- Modify: `src/client/App.tsx` (route wiring)
- Modify: `src/client/styles.css` (new rules, reusing existing tokens/patterns)

**Interfaces:**

- Consumes: `PostBlock`, `RunPosition`, `renderPostBody`, `applyStyleToSelection`, `plainTextLength` from `../shared/linkedin-post-format`; `createLinkedInPost`, `updateLinkedInPost` from `./api`; the existing `useActiveSeatKey` from `./LinkedInAccounts`.
- Produces: `LinkedInPosts` component (default export), rendered at `/outreach/posts`.

- [ ] **Step 1: Build the composer component**

`src/client/LinkedInPosts.tsx` (composer half; the queue/list half is Task 8, appended to the same file):

```tsx
import { useMemo, useRef, useState } from 'react';
import { Bold, Italic, Underline, List, ListOrdered } from 'lucide-react';
import {
  applyStyleToSelection,
  plainTextLength,
  renderPostBody,
  type PostBlock,
  type PostStyle,
  type RunPosition
} from '../shared/linkedin-post-format';
import { createLinkedInPost, publishLinkedInPostNow, type ApiError } from './api';
import { useActiveSeatKey } from './LinkedInAccounts';

const MAX_CHARS = 3000;
const EMPTY_BLOCKS: PostBlock[] = [{ runs: [{ type: 'text', text: '' }] }];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * A block/run/offset position from the browser's own Selection, resolved
 * against `data-block`/`data-run` attributes the composer stamps onto every
 * run span it renders -- the DOM is the source of the (block, run) pair; the
 * character offset within a run comes from the Range's own offset, since a
 * run renders as one text node.
 */
function positionFromNode(node: Node, offset: number): RunPosition | null {
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest(
    '[data-run]'
  );
  if (!el) return null;
  const block = Number(el.getAttribute('data-block'));
  const run = Number(el.getAttribute('data-run'));
  if (Number.isNaN(block) || Number.isNaN(run)) return null;
  return { block, run, offset };
}

function currentSelection(container: HTMLElement): { start: RunPosition; end: RunPosition } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const start = positionFromNode(range.startContainer, range.startOffset);
  const end = positionFromNode(range.endContainer, range.endOffset);
  if (!start || !end) return null;
  return { start, end };
}

export function PostComposer({
  onCreated,
  setToast
}: {
  onCreated: () => void;
  setToast: (message: string) => void;
}) {
  const [seatKey] = useActiveSeatKey();
  const [blocks, setBlocks] = useState<PostBlock[]>(EMPTY_BLOCKS);
  const [scheduledAt, setScheduledAt] = useState('');
  const [busy, setBusy] = useState<'save' | 'schedule' | 'now' | null>(null);
  const [error, setError] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);

  const rendered = useMemo(() => renderPostBody(blocks), [blocks]);
  const length = useMemo(() => plainTextLength(blocks), [blocks]);
  const overLimit = length > MAX_CHARS;

  const toggle = (style: PostStyle) => {
    const el = editorRef.current;
    if (!el) return;
    const selection = currentSelection(el);
    if (!selection) return; // no-selection "arm for next typed text" is a Task-8-scale follow-up; M1 requires a selection
    setBlocks((current) => applyStyleToSelection(current, selection, style));
  };

  const editRunText = (blockIndex: number, runIndex: number, text: string) => {
    setBlocks((current) =>
      current.map((block, bi) =>
        bi !== blockIndex
          ? block
          : {
              ...block,
              runs: block.runs.map((run, ri) =>
                ri !== runIndex || run.type !== 'text' ? run : { ...run, text }
              )
            }
      )
    );
  };

  const toggleListAt = (blockIndex: number, kind: 'bullet' | 'numbered') => {
    setBlocks((current) =>
      current.map((block, bi) =>
        bi !== blockIndex ? block : { ...block, list: block.list === kind ? undefined : kind }
      )
    );
  };

  const reset = () => {
    setBlocks(EMPTY_BLOCKS);
    setScheduledAt('');
  };

  const save = async (mode: 'save' | 'schedule' | 'now') => {
    if (overLimit) return;
    setBusy(mode);
    setError('');
    try {
      const post = await createLinkedInPost({
        ...(seatKey ? { seatKey } : {}),
        blocks,
        ...(mode === 'schedule'
          ? { status: 'scheduled' as const, scheduledAt: new Date(scheduledAt).toISOString() }
          : mode === 'save'
            ? { status: 'draft' as const }
            : {})
      });
      if (mode === 'now') await publishLinkedInPostNow(post.id);
      setToast(
        mode === 'save'
          ? 'Draft saved.'
          : mode === 'schedule'
            ? 'Post scheduled.'
            : 'Queued to publish shortly.'
      );
      reset();
      onCreated();
    } catch (cause) {
      setError((cause as ApiError)?.message ?? errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="li-post-composer">
      <div className="li-post-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" onClick={() => toggle('bold')} aria-label="Bold">
          <Bold size={16} />
        </button>
        <button type="button" onClick={() => toggle('italic')} aria-label="Italic">
          <Italic size={16} />
        </button>
        <button type="button" onClick={() => toggle('underline')} aria-label="Underline">
          <Underline size={16} />
        </button>
        <button
          type="button"
          onClick={() => toggleListAt(blocks.length - 1, 'bullet')}
          aria-label="Bulleted list"
        >
          <List size={16} />
        </button>
        <button
          type="button"
          onClick={() => toggleListAt(blocks.length - 1, 'numbered')}
          aria-label="Numbered list"
        >
          <ListOrdered size={16} />
        </button>
      </div>

      <div
        ref={editorRef}
        className="li-post-editor"
        contentEditable
        suppressContentEditableWarning
      >
        {blocks.map((block, bi) => (
          <div
            key={bi}
            data-block={bi}
            className={block.list ? `li-post-line li-post-line--${block.list}` : 'li-post-line'}
          >
            {block.runs.map((run, ri) =>
              run.type === 'text' ? (
                <span
                  key={ri}
                  data-block={bi}
                  data-run={ri}
                  className={[
                    run.bold && 'li-post-run--bold',
                    run.italic && 'li-post-run--italic',
                    run.underline && 'li-post-run--underline'
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={(event) =>
                    editRunText(bi, ri, (event.target as HTMLElement).textContent ?? '')
                  }
                >
                  {run.text}
                </span>
              ) : run.type === 'mention' ? (
                <span
                  key={ri}
                  data-block={bi}
                  data-run={ri}
                  className="li-post-mention"
                  contentEditable={false}
                >
                  @{run.displayText}
                </span>
              ) : (
                <br key={ri} />
              )
            )}
          </div>
        ))}
      </div>

      <div className={overLimit ? 'li-post-count li-post-count--over' : 'li-post-count'}>
        {length} / {MAX_CHARS}
      </div>

      <div className="li-post-preview">
        <div className="li-post-preview-card">
          <pre>{rendered}</pre>
        </div>
      </div>

      {error && <p className="li-post-error">{error}</p>}

      <div className="li-post-actions">
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(event) => setScheduledAt(event.target.value)}
          aria-label="Schedule for"
        />
        <button type="button" disabled={busy !== null || overLimit} onClick={() => save('save')}>
          Save draft
        </button>
        <button
          type="button"
          disabled={busy !== null || overLimit || !scheduledAt}
          onClick={() => save('schedule')}
        >
          Schedule
        </button>
        <button type="button" disabled={busy !== null || overLimit} onClick={() => save('now')}>
          Publish now
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the route**

In `src/client/App.tsx`:

1. Import: `import { LinkedInPosts } from './LinkedInPosts';` (this default-exported wrapper component is written in Task 8, which also owns the queue list; Step 2 here only wires the route, Task 8 fills in what renders).
2. Add to `OUTREACH_MORE_ROUTES`: `{ sub: 'posts', label: 'Scheduled posts' },`
3. Add a render branch beside the existing `{route.sub === 'plan' && <OutreachPlan setToast={setToast} />}`: `{route.sub === 'posts' && <LinkedInPosts setToast={setToast} />}`
4. Add a title in `viewTitle`, beside the existing `if (route.sub === 'plan') return 'Plan preview';`: `if (route.sub === 'posts') return 'Scheduled posts';`

- [ ] **Step 3: Add composer styles**

In `src/client/styles.css`, add rules for `.li-post-composer`, `.li-post-toolbar`, `.li-post-editor`, `.li-post-line`, `.li-post-line--bullet`/`.li-post-line--numbered`, `.li-post-run--bold`/`--italic`/`--underline` (font-weight/style/text-decoration, matching how a reader should expect bold/italic to LOOK while editing even though the stored/published form is Unicode, not real CSS styling), `.li-post-mention`, `.li-post-count`/`--over`, `.li-post-preview`/`-card`, `.li-post-error`, `.li-post-actions` — follow the file's existing `.li-*` naming and spacing/color token conventions (e.g. the existing `.li-template-card`, `.li-companion-device` rules) rather than introducing new design tokens.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck`
Expected: PASS. (Per Global Constraints, no component test for this file; Task 8 completes the component so it can be smoke-tested end-to-end via `/run` before this plan's Final Verification.)

- [ ] **Step 5: Commit**

```bash
git add src/client/LinkedInPosts.tsx src/client/App.tsx src/client/styles.css
git commit -m "linkedin: post composer with formatting toolbar and live preview"
```

---

### Task 8: Queue list — browse, cancel, publish-now

**Files:**

- Modify: `src/client/LinkedInPosts.tsx` (add the list and the default-exported page component that Task 7's route renders)

**Interfaces:**

- Consumes: `PostComposer` from Task 7 (same file); `listLinkedInPosts`, `cancelLinkedInPost`, `publishLinkedInPostNow` from `./api`; `renderPostBody` from `../shared/linkedin-post-format`.
- Produces: `LinkedInPosts` (default export, the component `App.tsx` renders at `/outreach/posts`).

- [ ] **Step 1: Add the list and the page shell**

Append to `src/client/LinkedInPosts.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  listLinkedInPosts,
  cancelLinkedInPost,
  publishLinkedInPostNow,
  type LinkedInPost
} from './api';

const STATUS_LABELS: Record<LinkedInPost['status'], string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing…',
  posted: 'Posted',
  failed: 'Failed',
  missed: 'Missed',
  canceled: 'Canceled'
};

function PostRow({ post, onChanged }: { post: LinkedInPost; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    try {
      await cancelLinkedInPost(post.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const publishNow = async () => {
    setBusy(true);
    try {
      await publishLinkedInPostNow(post.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const preview = renderPostBody(post.blocks).slice(0, 140);
  return (
    <li className="li-post-row">
      <span className={`li-post-status li-post-status--${post.status}`}>
        {STATUS_LABELS[post.status]}
      </span>
      <span className="li-post-row-preview">{preview}</span>
      <span className="li-post-row-when">
        {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : '—'}
      </span>
      {post.status === 'failed' && post.error && (
        <span className="li-post-row-error" title={post.error.detail}>
          {post.error.kind}
        </span>
      )}
      {(post.status === 'draft' || post.status === 'scheduled') && (
        <span className="li-post-row-actions">
          <button type="button" disabled={busy} onClick={publishNow}>
            Publish now
          </button>
          <button type="button" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </span>
      )}
      {post.status === 'posted' && post.postedUrl && (
        <a className="li-post-row-link" href={post.postedUrl} target="_blank" rel="noreferrer">
          View on LinkedIn
        </a>
      )}
    </li>
  );
}

export function LinkedInPosts({ setToast }: { setToast: (message: string) => void }) {
  const [posts, setPosts] = useState<LinkedInPost[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setPosts(await listLinkedInPosts());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load posts.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="li-posts-screen">
      <PostComposer setToast={setToast} onCreated={load} />
      {error && <p className="li-post-error">{error}</p>}
      {posts === null ? (
        <p>Loading…</p>
      ) : posts.length === 0 ? (
        <p className="li-post-empty">No posts yet — write one above.</p>
      ) : (
        <ul className="li-post-list">
          {posts.map((post) => (
            <PostRow key={post.id} post={post} onChanged={load} />
          ))}
        </ul>
      )}
    </div>
  );
}
```

Note: this appended block's `import` lines belong at the TOP of the file with Task 7's other imports, not literally mid-file — when writing the file, merge them into the single import block at the top (`useCallback`, `useEffect` added to the existing `react` import; `listLinkedInPosts`, `cancelLinkedInPost`, `publishLinkedInPostNow`, `type LinkedInPost` added to the existing `./api` import).

- [ ] **Step 2: Add list styles**

In `src/client/styles.css`, add `.li-posts-screen`, `.li-post-list`, `.li-post-row`, `.li-post-status` and its per-status modifiers (reuse the existing status-badge color pattern already used elsewhere in this file, e.g. campaign/action status badges, rather than inventing a new color scheme), `.li-post-row-preview`/`-when`/`-error`/`-actions`/`-link`, `.li-post-empty`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Use the `run` skill (or `npm run dev`) to start the app, sign in, navigate to Outreach → More → Scheduled posts, and confirm: typing renders live in the preview pane; selecting text and clicking Bold/Italic/Underline changes the preview to the Unicode-styled form; Save draft and Schedule both create a row that appears in the list below with the right status; Publish now moves a post to "Scheduled" (not "Posted") with a scheduled time of roughly now, matching the Global Constraint that publish-now is never synchronous.

- [ ] **Step 5: Commit**

```bash
git add src/client/LinkedInPosts.tsx src/client/styles.css
git commit -m "linkedin: scheduled-posts queue list (browse, cancel, publish now)"
```

---

## Final verification

- [ ] Run the full pure-logic suite: `npm run test:unit`
- [ ] Run the full Postgres-backed suite: `npm test`
- [ ] Run `npm run check` (tests + typecheck + build) and confirm it's clean
- [ ] Re-read `docs/superpowers/specs/2026-08-19-linkedin-scheduled-posts-design.md` end to end and confirm every Milestone-1 item it describes (content model, Unicode rendering incl. the accessibility note, hashtags/links as plain auto-linkified text, explicit scheduling, the 6-hour missed-post grace window, the soft daily-post-cap UI warning, the worker-only execution constraint) is either implemented above or explicitly still open for Milestone 2/3
- [ ] Confirm the soft daily-post-cap warning from the spec's Safety section is NOT yet implemented — it was intentionally left out of this milestone's task list (it's a small, independent composer-side check with no dependency on anything else here); file a follow-up task for it before closing out Milestone 1, or add it as a Task 9 if the reviewer prefers it bundled
- [ ] Confirm the three `POST_SELECTORS` in `driver-post.ts` get checked against a real LinkedIn account before this ships to any real seat — they are explicitly marked UNVERIFIED-AGAINST-LIVE-DOM in Task 5
- [ ] **Three spec commitments were deliberately simplified in Task 7 and are NOT yet done — confirm the reviewer is fine with this before calling Milestone 1 complete, or add tasks for them:**
  1. **The "link goes in a comment" toggle** (spec's Hashtags & links section: strip the URL from the body, post it as the first comment after publishing). The `link_in_comment` column exists in the Task 2 migration but nothing reads or writes it yet — `driver-post.ts` has no "post a comment" step. Needs its own driver routine (the comment box is yet another distinct compose surface, not a small delta on `publishPost`).
  2. **Toolbar active-state** (spec's Editor interaction section: Bold/Italic/Underline should show pressed/off/indeterminate based on the current selection). Task 7's toolbar buttons are stateless — they call `applyStyleToSelection` but never read the selection's current style back to highlight themselves.
  3. **Click-then-type arming** (spec: clicking a style button with no selection should style subsequently typed text, not require a selection to exist first). Task 7's `toggle` function explicitly no-ops when there is no selection (`if (!selection) return;`), so today the toolbar only works when text is already selected — the "select text and click the button" flow works; the "click first, then type" flow does not yet.

  All three are additive UI-only changes on top of `applyStyleToSelection`/`renderPostBody`, which are already correct and fully tested (Task 1) — none require touching the data model, API, or driver again, so they're a cheap, low-risk fast-follow rather than a blocker to shipping Milestone 1's core loop (write, format by selecting text, schedule, auto-publish).
