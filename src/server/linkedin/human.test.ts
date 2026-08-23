import { describe, expect, it } from 'vitest';
import {
  hoverClick,
  setHumanSessionSalt,
  settle,
  settleMs,
  typeLike,
  type HumanLocator,
  type HumanPage
} from './human.js';

function fake(options: { hover?: boolean; typing?: boolean } = {}) {
  const waits: number[] = [];
  const typed: string[] = [];
  const filled: string[] = [];
  const events: string[] = [];

  const page: HumanPage = {
    waitForTimeout: async (ms: number) => void waits.push(ms)
  };

  const locator: HumanLocator = {
    click: async () => void events.push('click'),
    fill: async (text: string) => {
      filled.push(text);
      events.push('fill');
    },
    ...(options.hover ? { hover: async () => void events.push('hover') } : {}),
    ...(options.typing
      ? {
          pressSequentially: async (text: string) => {
            typed.push(text);
            events.push('type');
          }
        }
      : {})
  };

  return { page, locator, waits, typed, filled, events };
}

describe('LinkedIn interaction helpers', () => {
  it('uses one fixed UI-stability settle instead of behavioural jitter', async () => {
    expect(settleMs('a')).toBe(1_000);
    expect(settleMs('b')).toBe(1_000);
    setHumanSessionSalt('ignored');
    const { page, waits } = fake();
    await settle(page, 'ignored-seed');
    expect(waits).toEqual([1_000]);
  });

  it('clicks directly without synthetic hover or dwell', async () => {
    const { page, locator, events, waits } = fake({ hover: true });
    await hoverClick(page, locator, 'ignored-seed', 1_000);
    expect(events).toEqual(['click']);
    expect(events).not.toContain('hover');
    expect(waits).toEqual([]);
  });

  it('fills exactly the approved bytes without synthetic typing cadence', async () => {
    const { page, locator, filled, typed, waits, events } = fake({ typing: true });
    const body = 'First line.\nSecond line.';
    await typeLike(page, locator, body, 'ignored-seed', 1_000);
    expect(filled).toEqual([body]);
    expect(typed).toEqual([]);
    expect(events).toEqual(['fill']);
    expect(waits).toEqual([]);
  });
});
