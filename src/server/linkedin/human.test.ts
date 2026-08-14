import { describe, expect, it } from 'vitest';
import {
  hoverClick,
  readPage,
  setHumanSessionSalt,
  settle,
  settleMs,
  typeLike,
  type HumanLocator,
  type HumanPage
} from './human.js';

/**
 * The primitives every driver now goes through, tested directly.
 *
 * They were covered only through the drivers, which meant the thing being
 * asserted was "the invite still sends" and not "the invite looks like a person
 * sent it". Two of the five defects the 2026-08-14 review found -- a paste path
 * with no pause, a click with no pause when hover was unavailable -- were
 * invisible to those tests and would have been caught by these.
 */

function fake(options: { mouse?: boolean; keyboard?: boolean; typing?: boolean; hover?: boolean } = {}) {
  const waits: number[] = [];
  const wheels: number[] = [];
  const moves: Array<{ x: number; y: number }> = [];
  const typed: string[] = [];
  const keys: string[] = [];
  const filled: string[] = [];
  const events: string[] = [];

  const page: HumanPage = {
    waitForTimeout: async (ms: number) => {
      waits.push(ms);
    },
    ...(options.mouse
      ? {
          mouse: {
            move: async (x: number, y: number) => {
              moves.push({ x, y });
              events.push('move');
            },
            wheel: async (_dx: number, dy: number) => {
              wheels.push(dy);
              events.push('wheel');
            }
          }
        }
      : {}),
    ...(options.keyboard
      ? {
          keyboard: {
            press: async (key: string) => {
              keys.push(key);
            }
          }
        }
      : {})
  };

  const locator: HumanLocator = {
    click: async () => {
      events.push('click');
    },
    fill: async (text: string) => {
      filled.push(text);
      events.push('fill');
    },
    ...(options.hover ? { hover: async () => { events.push('hover'); } } : {}),
    ...(options.typing
      ? {
          pressSequentially: async (text: string) => {
            typed.push(text);
            events.push('type');
          }
        }
      : {})
  };

  return { page, locator, waits, wheels, moves, typed, keys, filled, events };
}

describe('settleMs', () => {
  it('is deterministic and inside the band', () => {
    expect(settleMs('a')).toBe(settleMs('a'));
    expect(settleMs('a')).not.toBe(settleMs('b'));
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      expect(settleMs(seed)).toBeGreaterThanOrEqual(900);
      expect(settleMs(seed)).toBeLessThanOrEqual(4_200);
    }
  });

  it('never draws the 1,500ms constant it replaced for every caller', () => {
    const drawn = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((seed) => settleMs(seed)));
    expect(drawn.size).toBeGreaterThan(1);
  });
});

describe('the session salt', () => {
  it('moves every pause, so two sittings never share a rhythm', async () => {
    setHumanSessionSalt('sitting-1');
    const first = fake();
    await settle(first.page, 'https://example.test#open');

    setHumanSessionSalt('sitting-2');
    const second = fake();
    await settle(second.page, 'https://example.test#open');

    expect(first.waits).toHaveLength(1);
    expect(second.waits).toHaveLength(1);
    expect(first.waits[0]).not.toBe(second.waits[0]);
  });

  it('keeps one sitting reproducible: the same step twice draws the same pause', async () => {
    setHumanSessionSalt('sitting-fixed');
    const first = fake();
    const second = fake();
    await settle(first.page, 'https://example.test#open');
    await settle(second.page, 'https://example.test#open');
    expect(first.waits).toEqual(second.waits);
  });
});

describe('hoverClick', () => {
  it('hovers, pauses, then clicks', async () => {
    const { page, locator, events, waits } = fake({ hover: true });
    await hoverClick(page, locator, 'seed', 1_000);
    expect(events).toEqual(['hover', 'click']);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(120);
    expect(waits[0]).toBeLessThanOrEqual(640);
  });

  it('still pauses when the control cannot be hovered', async () => {
    // THE DEFECT: the pause used to live inside the hover branch, so a locator
    // with no `hover` went from "found it" to `mousedown` in the same frame --
    // the teleporting click this function exists to prevent.
    const { page, locator, events, waits } = fake({ hover: false });
    await hoverClick(page, locator, 'seed', 1_000);
    expect(events).toEqual(['click']);
    expect(waits).toHaveLength(1);
  });

  it('clicks anyway when hovering throws', async () => {
    const { page, locator, events } = fake({ hover: true });
    locator.hover = async () => {
      throw new Error('covered by an overlay');
    };
    await hoverClick(page, locator, 'seed', 1_000);
    expect(events).toEqual(['click']);
  });
});

describe('typeLike', () => {
  it('types the caller\'s bytes exactly, in bursts', async () => {
    const { page, locator, typed, filled } = fake({ typing: true });
    const note = 'Hi Dana, saw your talk on pacing engines and had one question about it.';
    await typeLike(page, locator, note, 'seed', 1_000);
    expect(typed.join('')).toBe(note);
    expect(typed.length).toBeGreaterThan(1);
    expect(filled).toEqual([]);
  });

  it('breaks lines with Shift+Enter, never Enter, which would send half a message', async () => {
    const { page, locator, typed, keys } = fake({ typing: true, keyboard: true });
    await typeLike(page, locator, 'First line.\nSecond line.', 'seed', 1_000);
    expect(typed.join('')).toBe('First line.Second line.');
    expect(keys).toEqual(['Shift+Enter']);
    expect(keys).not.toContain('Enter');
  });

  it('pastes instead of typing when a newline could not be typed safely', async () => {
    // No keyboard to press Shift+Enter with: typing the newline would risk an
    // Enter that sends. `fill` puts the exact bytes in one event instead.
    const { page, locator, filled, typed } = fake({ typing: true });
    await typeLike(page, locator, 'First line.\nSecond line.', 'seed', 1_000);
    expect(filled).toEqual(['First line.\nSecond line.']);
    expect(typed).toEqual([]);
  });

  it('pastes carriage returns rather than changing the bytes', async () => {
    const { page, locator, filled } = fake({ typing: true, keyboard: true });
    await typeLike(page, locator, 'a\r\nb', 'seed', 1_000);
    expect(filled).toEqual(['a\r\nb']);
  });

  it('pauses on the paste path too, before the caller clicks Send', async () => {
    // THE DEFECT: this branch is the one every page object without
    // `pressSequentially` takes, and it used to return instantly -- so the
    // loudest composer signal survived for exactly the callers that could not
    // type their way out of it.
    const { page, locator, waits } = fake();
    await typeLike(page, locator, 'a note', 'seed', 1_000);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(900);
  });

  it('recovers to the approved bytes when typing fails half way', async () => {
    const { page, locator, filled } = fake({ typing: true });
    let calls = 0;
    locator.pressSequentially = async () => {
      calls += 1;
      if (calls > 1) throw new Error('the composer went away');
    };
    await typeLike(page, locator, 'a much longer note than one burst can carry', 'seed', 1_000);
    expect(filled).toEqual(['a much longer note than one burst can carry']);
  });
});

describe('readPage', () => {
  it('does nothing at all when the page cannot point', async () => {
    const { page, waits } = fake({ mouse: false });
    await readPage(page, 'seed');
    expect(waits).toEqual([]);
  });

  it('moves the pointer and scrolls', async () => {
    const { page, wheels, moves } = fake({ mouse: true });
    await readPage(page, 'seed');
    expect(moves.length).toBeGreaterThan(0);
    expect(wheels.length).toBeGreaterThan(0);
    expect(wheels.some((delta) => delta > 0)).toBe(true);
  });

  it('does not read every page the same way', async () => {
    // THE DEFECT: one pointer move then three to six identical wheel ticks, on
    // every page it ever saw. Varied enough to beat a constant, uniform enough
    // to be its own signature.
    setHumanSessionSalt('shapes');
    const shapes = new Set<number>();
    for (let index = 0; index < 12; index += 1) {
      const { page, wheels } = fake({ mouse: true });
      await readPage(page, `page-${index}`);
      shapes.add(wheels.length);
    }
    expect(shapes.size).toBeGreaterThan(2);
  });

  it('never throws when the mouse does', async () => {
    const { page } = fake({ mouse: true });
    page.mouse!.wheel = async () => {
      throw new Error('detached');
    };
    await expect(readPage(page, 'seed')).resolves.toBeUndefined();
  });
});
