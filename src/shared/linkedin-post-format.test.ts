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
    const expected = String.fromCodePoint(
      0x48,
      0x69,
      0x20,
      0x1d5d5,
      0x1d5fc,
      0x1d5f9,
      0x1d5f1,
      0x20,
      0x61,
      0x6e,
      0x64,
      0x20,
      0x1d610,
      0x1d635,
      0x1d622,
      0x1d62d,
      0x1d62a,
      0x1d624
    );
    expect(renderPostBody(blocks)).toBe(expected);
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
    expect(next[0].runs[0]).toMatchObject({ text: 'Some bold word more.' });
    expect(Boolean(next[0].runs[0].type === 'text' && next[0].runs[0].bold)).toBe(false);
  });

  it('regression: does not corrupt unselected text when toggling', () => {
    // Bug: a single run "Hello World" (bold), selecting only "World" (offset 6-11),
    // and toggling bold off should NOT affect "Hello " -- only "World" loses bold.
    const blocks: PostBlock[] = [block({ type: 'text', text: 'Hello World', bold: true })];
    const next = applyStyleToSelection(
      blocks,
      { start: { block: 0, run: 0, offset: 6 }, end: { block: 0, run: 0, offset: 11 } },
      'bold'
    );
    expect(next[0].runs).toHaveLength(2);
    expect(next[0].runs[0]).toMatchObject({ text: 'Hello ', bold: true });
    expect(next[0].runs[1]).toMatchObject({ text: 'World' });
    expect(Boolean(next[0].runs[1].type === 'text' && next[0].runs[1].bold)).toBe(false);
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

  /**
   * THE INVARIANT, not a hand-counted number: what the cap is measured against
   * has to be what actually reaches LinkedIn. List prefixes ('• ', '1. ') and
   * in-block breaks were both uncounted, so a heavily bulleted post could pass
   * the composer's counter and the server's zod check and still be rejected by
   * LinkedIn for length -- the one place the user never sees a reason.
   */
  it('matches renderPostBody measured in code points, list prefixes and breaks included', () => {
    const blocks: PostBlock[] = [
      block({ type: 'text', text: 'Three things I learned:' }),
      { runs: [{ type: 'text', text: 'Ship small', bold: true }], list: 'bullet' },
      { runs: [{ type: 'text', text: 'Ship often' }], list: 'bullet' },
      { runs: [{ type: 'text', text: 'First' }], list: 'numbered' },
      {
        runs: [
          { type: 'text', text: 'Second' },
          { type: 'break' },
          { type: 'text', text: 'still second' }
        ],
        list: 'numbered'
      },
      block(
        { type: 'text', text: 'Thanks ' },
        { type: 'mention', displayText: 'Jane', entityKind: 'person' }
      )
    ];
    expect(plainTextLength(blocks)).toBe([...renderPostBody(blocks)].length);
  });

  it('counts a two-digit numbered marker as its own four characters', () => {
    const blocks: PostBlock[] = Array.from({ length: 10 }, (_, index) => ({
      runs: [{ type: 'text' as const, text: `item ${index}` }],
      list: 'numbered' as const
    }));
    expect(plainTextLength(blocks)).toBe([...renderPostBody(blocks)].length);
  });
});
