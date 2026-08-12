import { describe, expect, it } from 'vitest';
import type { LinkedInLocator, LinkedInPage } from './driver.js';
import {
  DEFAULT_MAX_THREADS,
  INBOX_SELECTORS,
  MESSAGING_URL,
  READ_GAP_SECONDS,
  isThreadListing,
  isThreadTranscript,
  listConversations,
  parseInboxTimestamp,
  readGapSeconds,
  readThread,
  sendReply,
  threadUrlFor,
  threadUrnFrom
} from './driver-inbox.js';

/**
 * THE PAGE IS ALWAYS FAKE HERE. No browser is launched and no LinkedIn request
 * is made by this file, ever -- the same rule `local-worker.test.ts` states,
 * for the same reason: a suite that touched a real account would spend that
 * account's budget on CI, and the ceilings this subsystem exists to respect are
 * per human, not per test run.
 *
 * The fake below is a small DOM simulator rather than a stub of the driver's
 * own calls, because what is worth asserting is the SELECTOR ARITHMETIC: that
 * row 3's unread badge is row 3's, that a comma in a selector list does not
 * escape its row, and that a conversation id is only ever taken from a URL the
 * host check passed.
 */

interface FakeMessage {
  direction: 'in' | 'out';
  body: string;
  /** The group timestamp LinkedIn renders above a run of messages. */
  stamp?: string;
  /** Simulates drift: an item with no readable body. */
  bodyless?: boolean;
}

interface FakeThread {
  urn: string;
  name: string;
  /** What the opened thread header says, when it disagrees with the rail. */
  headerName?: string;
  snippet: string;
  stamp: string;
  unread: boolean;
  /** Where clicking the participant link lands. Null means there is no link. */
  profileUrl: string | null;
  /** Simulates a row that cannot be opened. */
  noLink?: boolean;
  messages: FakeMessage[];
}

interface World {
  threads: FakeThread[];
  rail: 'ok' | 'empty' | 'missing';
  messageList: 'ok' | 'missing';
  composer: 'ok' | 'missing' | 'no-send';
  /** A wall, and where it appears. */
  wall: 'none' | 'limit' | 'challenge' | 'gone';
  wallAt: 'always' | 'thread' | 'profile' | 'after-send';
}

function world(overrides: Partial<World> = {}): World {
  return {
    threads: [],
    rail: 'ok',
    messageList: 'ok',
    composer: 'ok',
    wall: 'none',
    wallAt: 'always',
    ...overrides
  };
}

function thread(index: number, overrides: Partial<FakeThread> = {}): FakeThread {
  const names = ['Maya Chen', 'Jonas Keller', 'Sofia Rossi', 'Alex Morgan', 'Priya Nair'];
  const name = names[index % names.length];
  const handle = name.split(' ')[0].toLowerCase();
  return {
    urn: `2-thread${index}==`,
    name,
    snippet: `snippet ${index}`,
    stamp: '10:42 AM',
    unread: false,
    profileUrl: `https://www.linkedin.com/in/${handle}/`,
    messages: [{ direction: 'in', body: `hello ${index}`, stamp: '10:42 AM' }],
    ...overrides
  };
}

class FakePage implements LinkedInPage {
  current = 'https://www.linkedin.com/feed/';
  readonly sleeps: number[] = [];
  readonly typed: string[] = [];
  sent = 0;
  private openIndex = -1;

  constructor(private readonly state: World) {}

  url(): string {
    return this.current;
  }

  async goto(url: string): Promise<unknown> {
    this.current = url;
    const urn = threadUrnFrom(url);
    this.openIndex = urn === null ? -1 : this.state.threads.findIndex((entry) => entry.urn === urn);
    return undefined;
  }

  async waitForTimeout(): Promise<void> {
    // The driver's settle. Not a paced gap -- those go through the injected sleep.
  }

  locator(selector: string): LinkedInLocator {
    return new FakeLocator(this, selector);
  }

  /** True while the conversation rail is rendered: on /messaging/ and inside a thread. */
  private onMessaging(): boolean {
    return this.current.startsWith(MESSAGING_URL);
  }

  private openThread(): FakeThread | null {
    return this.openIndex >= 0 ? this.state.threads[this.openIndex] : null;
  }

  private wallShowing(part: string): number {
    if (this.state.wall === 'none') return 0;
    if (this.state.wallAt === 'thread' && threadUrnFrom(this.current) === null) return 0;
    if (this.state.wallAt === 'profile' && this.onMessaging()) return 0;
    if (this.state.wallAt === 'after-send' && this.sent === 0) return 0;
    if (this.state.wall === 'challenge') return part.includes('form.challenge') ? 1 : 0;
    if (this.state.wall === 'limit') return part.includes('temporarily restricted') ? 1 : 0;
    return part.includes('This page doesn') ? 1 : 0;
  }

  resolve(selector: string): { count: number; text: string | null } {
    let count = 0;
    let text: string | null = null;
    for (const part of selector.split(',').map((piece) => piece.trim())) {
      const found = this.resolveOne(part);
      count += found.count;
      if (text === null) text = found.text;
    }
    return { count, text };
  }

  private resolveOne(part: string): { count: number; text: string | null } {
    const none = { count: 0, text: null };
    const wall = this.wallShowing(part);
    if (wall > 0) return { count: wall, text: 'LinkedIn says stop' };
    if (part.includes('form.challenge') || part.includes('temporarily restricted') || part.includes('This page doesn')) return none;
    if (part.includes('input[name="pin"]') || part.includes('reached the weekly invitation limit')) return none;

    if (part.includes('msg-form__contenteditable')) {
      return this.openThread() && this.state.composer !== 'missing' ? { count: 1, text: null } : none;
    }
    if (part.includes('msg-form__send-button')) {
      return this.openThread() && this.state.composer === 'ok' ? { count: 1, text: null } : none;
    }
    if (part.includes('button[type="submit"]')) return none;

    if (part.includes('msg-thread__link-to-profile')) {
      const open = this.openThread();
      return open && open.profileUrl !== null ? { count: 1, text: open.headerName ?? open.name } : none;
    }
    if (part.includes('msg-entity-lockup') || part.includes('msg-title-bar')) return none;

    const nth = /li:nth-child\((\d+)\)/.exec(part);
    const suffix = nth ? part.slice(part.indexOf(')') + 1).trim() : '';

    if (part.includes('msg-conversations-container__conversations-list')) {
      if (!this.onMessaging() || this.state.rail === 'missing') return none;
      if (!nth) {
        if (part.trim().endsWith('> li')) return { count: this.state.rail === 'empty' ? 0 : this.state.threads.length, text: null };
        return { count: 1, text: null };
      }
      const row = this.state.threads[Number(nth[1]) - 1];
      if (!row || this.state.rail === 'empty') return none;
      if (!suffix) return { count: 1, text: null };
      if (suffix.includes('participant-names')) return { count: 1, text: row.name };
      if (suffix.includes('message-snippet')) return { count: 1, text: row.snippet };
      if (suffix.includes('time-stamp')) return { count: 1, text: row.stamp };
      if (suffix.includes('notification-badge') || suffix.includes('unread-count')) {
        return row.unread ? { count: 1, text: '1' } : none;
      }
      if (suffix.includes('msg-conversation-listitem__link')) return row.noLink ? none : { count: 1, text: row.name };
      return none;
    }

    if (part.includes('msg-s-message-list-content')) {
      const open = this.openThread();
      if (!open || this.state.messageList === 'missing') return none;
      if (!nth) {
        if (part.trim().endsWith('> li')) return { count: open.messages.length, text: null };
        return { count: 1, text: null };
      }
      const message = open.messages[Number(nth[1]) - 1];
      if (!message) return none;
      if (!suffix) return { count: 1, text: null };
      if (suffix.includes('msg-s-event-listitem--other')) return message.direction === 'in' ? { count: 1, text: null } : none;
      if (suffix.includes('msg-s-event-listitem__body')) {
        return message.bodyless ? none : { count: 1, text: message.body };
      }
      if (suffix.includes('msg-s-message-group__timestamp')) {
        return message.stamp ? { count: 1, text: message.stamp } : none;
      }
      return none;
    }

    return none;
  }

  click(selector: string): void {
    for (const part of selector.split(',').map((piece) => piece.trim())) {
      if (part.includes('msg-conversation-listitem__link')) {
        const nth = /li:nth-child\((\d+)\)/.exec(part);
        if (!nth) continue;
        const index = Number(nth[1]) - 1;
        const row = this.state.threads[index];
        if (!row) continue;
        this.openIndex = index;
        this.current = threadUrlFor(row.urn) ?? MESSAGING_URL;
        return;
      }
      if (part.includes('msg-thread__link-to-profile')) {
        const open = this.openThread();
        // A profile link that leads somewhere that is not a profile is a real
        // shape: LinkedIn shows one for members who have since deactivated.
        this.current = open?.profileUrl ?? 'https://www.linkedin.com/feed/';
        return;
      }
      if (part.includes('msg-form__send-button')) {
        this.sent += 1;
        return;
      }
    }
  }

  fill(selector: string, value: string): void {
    if (selector.includes('msg-form__contenteditable')) this.typed.push(value);
  }
}

class FakeLocator implements LinkedInLocator {
  constructor(private readonly page: FakePage, private readonly selector: string) {}

  first(): LinkedInLocator {
    return this;
  }

  async count(): Promise<number> {
    return this.page.resolve(this.selector).count;
  }

  async textContent(): Promise<string | null> {
    return this.page.resolve(this.selector).text;
  }

  async click(): Promise<void> {
    this.page.click(this.selector);
  }

  async fill(text: string): Promise<void> {
    this.page.fill(this.selector, text);
  }
}

/** A recording sleep, so the paced gaps are asserted instead of waited out. */
function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

const NOW = new Date('2026-08-04T12:00:00.000Z');
const clock = () => NOW;

describe('conversation ids', () => {
  it('builds and reads back a thread URL, and refuses anything that is not one', () => {
    const url = threadUrlFor('2-abc==');
    expect(url).toBe('https://www.linkedin.com/messaging/thread/2-abc%3D%3D/');
    expect(threadUrnFrom(url as string)).toBe('2-abc==');

    expect(threadUrlFor('')).toBeNull();
    expect(threadUrlFor('../../in/someone')).toBeNull();
    expect(threadUrlFor('a b')).toBeNull();
  });

  it('never accepts a conversation id from a host that is not LinkedIn', () => {
    // This id is pasted back into a URL an AUTHENTICATED browser opens, which
    // is the whole reason the host is checked rather than trusted.
    expect(threadUrnFrom('https://evil.example/messaging/thread/2-abc/')).toBeNull();
    expect(threadUrnFrom('https://www.linkedin.com/feed/')).toBeNull();
    expect(threadUrnFrom('not a url')).toBeNull();
    expect(threadUrnFrom('https://linkedin.com/messaging/thread/2-abc/')).toBe('2-abc');
  });
});

describe('rendered timestamps', () => {
  it('resolves the shapes LinkedIn renders and NULLS everything else', () => {
    expect(parseInboxTimestamp('10:42 AM', NOW)).toBe('2026-08-04T10:42:00.000Z');
    expect(parseInboxTimestamp('10:42 PM', NOW)).toBe('2026-08-04T22:42:00.000Z');
    expect(parseInboxTimestamp('22:05', NOW)).toBe('2026-08-04T22:05:00.000Z');
    expect(parseInboxTimestamp('Yesterday', NOW)).toBe('2026-08-03T00:00:00.000Z');
    // 2026-08-04 is a Tuesday, so 'Sun' is two days back.
    expect(parseInboxTimestamp('Sun', NOW)).toBe('2026-08-02T00:00:00.000Z');
    expect(parseInboxTimestamp('Aug 3', NOW)).toBe('2026-08-03T00:00:00.000Z');
    expect(parseInboxTimestamp('Dec 3', NOW)).toBe('2025-12-03T00:00:00.000Z');
    expect(parseInboxTimestamp('Aug 3, 2024', NOW)).toBe('2024-08-03T00:00:00.000Z');

    // A guess would be worse than nothing: nothing safety-critical reads this,
    // but a screen that says "replied 4 August" about a date nobody read is a
    // lie with a timestamp on it.
    expect(parseInboxTimestamp('sometime last week', NOW)).toBeNull();
    expect(parseInboxTimestamp('25:00', NOW)).toBeNull();
    expect(parseInboxTimestamp('', NOW)).toBeNull();
    expect(parseInboxTimestamp(null, NOW)).toBeNull();
  });
});

describe('listConversations', () => {
  it('reads the rail, resolves each id from the URL and each profile from the hop', async () => {
    const state = world({
      threads: [
        thread(0, { unread: true, stamp: 'Aug 3' }),
        thread(1, { snippet: 'thanks, not right now' })
      ]
    });
    const page = new FakePage(state);
    const { sleep } = recorder();

    const listing = await listConversations(page, { sleep, now: clock, seed: 'run-1' });
    if (!isThreadListing(listing)) throw new Error(`expected a listing, got ${listing.failureKind}`);

    expect(listing.threads).toEqual([
      {
        threadUrn: '2-thread0==',
        profileUrl: 'https://www.linkedin.com/in/maya/',
        name: 'Maya Chen',
        lastMessageAt: '2026-08-03T00:00:00.000Z',
        snippet: 'snippet 0',
        unread: true
      },
      {
        threadUrn: '2-thread1==',
        profileUrl: 'https://www.linkedin.com/in/jonas/',
        name: 'Jonas Keller',
        lastMessageAt: '2026-08-04T10:42:00.000Z',
        snippet: 'thanks, not right now',
        unread: false
      }
    ]);
    expect(listing.degraded).toEqual([]);
  });

  it('keeps one row\'s unread badge out of another row', async () => {
    // The selector for the badge is a LIST, so an unscoped `${row} .a, .b` would
    // match the second alternative anywhere on the page and report every
    // conversation as unread.
    const state = world({ threads: [thread(0, { unread: false }), thread(1, { unread: true })] });
    const listing = await listConversations(new FakePage(state), { sleep: recorder().sleep, now: clock });
    if (!isThreadListing(listing)) throw new Error('expected a listing');
    expect(listing.threads.map((entry) => entry.unread)).toEqual([false, true]);
  });

  it('caps the walk and says how much it did not read', async () => {
    const state = world({ threads: [thread(0), thread(1), thread(2), thread(3)] });
    const listing = await listConversations(new FakePage(state), { maxThreads: 2, sleep: recorder().sleep, now: clock });
    if (!isThreadListing(listing)) throw new Error('expected a listing');
    expect(listing.threads).toHaveLength(2);
    expect(listing.degraded[0]).toContain('walked the newest 2');
  });

  it('jitters every navigation after the first, deterministically and inside READ_GAP_SECONDS', async () => {
    const build = () => world({ threads: [thread(0), thread(1)] });
    const first = recorder();
    const second = recorder();
    const other = recorder();

    await listConversations(new FakePage(build()), { sleep: first.sleep, seed: 'batch-a', now: clock });
    await listConversations(new FakePage(build()), { sleep: second.sleep, seed: 'batch-a', now: clock });
    await listConversations(new FakePage(build()), { sleep: other.sleep, seed: 'batch-b', now: clock });

    // Two conversations: /messaging/ (unpaced, it is the first), then open+hop
    // for each, then one return to the rail before the second row.
    expect(first.slept).toHaveLength(5);
    // Reproducible, which is what a seeded draw buys and Math.random() destroys.
    expect(second.slept).toEqual(first.slept);
    expect(other.slept).not.toEqual(first.slept);
    for (const ms of first.slept) {
      expect(ms).toBeGreaterThanOrEqual(READ_GAP_SECONDS.min * 1000);
      expect(ms).toBeLessThanOrEqual(READ_GAP_SECONDS.max * 1000);
    }
    // The draw has no pattern a rate limiter could key on.
    expect(new Set(first.slept).size).toBeGreaterThan(1);
  });

  it('skips the profile hop when the caller already has the URL', async () => {
    const state = world({ threads: [thread(0), thread(1)] });
    const { slept, sleep } = recorder();
    const listing = await listConversations(new FakePage(state), {
      sleep,
      now: clock,
      needsProfileUrl: (urn) => urn !== '2-thread0=='
    });
    if (!isThreadListing(listing)) throw new Error('expected a listing');
    expect(listing.threads[0].profileUrl).toBeNull();
    expect(listing.threads[1].profileUrl).toBe('https://www.linkedin.com/in/jonas/');
    // One hop instead of two, and one fewer return to the rail.
    expect(slept).toHaveLength(3);
  });

  it('STOPS the walk at a limit wall instead of clicking through it', async () => {
    const state = world({ threads: [thread(0), thread(1)], wall: 'limit', wallAt: 'thread' });
    const result = await listConversations(new FakePage(state), { sleep: recorder().sleep, now: clock });
    if (isThreadListing(result)) throw new Error('a limit wall must not come back as a listing');
    expect(result.failureKind).toBe('limit_wall');
    expect(result.ok).toBe(false);
  });

  it('reports a challenge from the messaging page itself', async () => {
    const state = world({ threads: [thread(0)], wall: 'challenge' });
    const result = await listConversations(new FakePage(state), { sleep: recorder().sleep, now: clock });
    if (isThreadListing(result)) throw new Error('a challenge must not come back as a listing');
    expect(result.failureKind).toBe('challenge');
    expect(result.detail).toContain('A human has to clear it');
  });

  it('tells an empty inbox apart from a drifted selector', async () => {
    const empty = await listConversations(new FakePage(world({ rail: 'empty', threads: [thread(0)] })), {
      sleep: recorder().sleep,
      now: clock
    });
    if (!isThreadListing(empty)) throw new Error('an empty inbox is a successful read');
    expect(empty.threads).toEqual([]);

    const drifted = await listConversations(new FakePage(world({ rail: 'missing' })), { sleep: recorder().sleep, now: clock });
    if (isThreadListing(drifted)) throw new Error('a missing rail is drift, not an empty inbox');
    expect(drifted.failureKind).toBe('selector_drift');
    expect(drifted.detail).toContain('Nothing was read');
  });

  it('drops a conversation whose opened name disagrees with the row it clicked', async () => {
    // The rail re-orders the moment a message arrives. Filing one person's
    // reply under another person's name is worse than reading nine of ten.
    const state = world({ threads: [thread(0, { headerName: 'Someone Else' }), thread(1)] });
    const listing = await listConversations(new FakePage(state), { sleep: recorder().sleep, now: clock });
    if (!isThreadListing(listing)) throw new Error('expected a listing');
    expect(listing.threads.map((entry) => entry.threadUrn)).toEqual(['2-thread1==']);
    expect(listing.degraded[0]).toContain('re-ordered mid-walk');
  });

  it('records a profile hop that lands somewhere that is not a profile, and keeps the conversation', async () => {
    const state = world({ threads: [thread(0, { profileUrl: null })] });
    const listing = await listConversations(new FakePage(state), { sleep: recorder().sleep, now: clock });
    if (!isThreadListing(listing)) throw new Error('expected a listing');
    expect(listing.threads[0].profileUrl).toBeNull();
    expect(listing.threads[0].threadUrn).toBe('2-thread0==');
    expect(listing.degraded[0]).toContain('cannot be matched to a campaign target');
  });

  it('defaults to a bounded walk', () => {
    expect(DEFAULT_MAX_THREADS).toBeLessThanOrEqual(25);
    expect(readGapSeconds('a')).not.toBe(readGapSeconds('b'));
    expect(readGapSeconds('a')).toBe(readGapSeconds('a'));
  });
});

describe('readThread', () => {
  it('returns the transcript in order, with direction read off the item', async () => {
    const state = world({
      threads: [
        thread(0, {
          messages: [
            { direction: 'out', body: 'Hi Maya, saw your talk.', stamp: 'Aug 3' },
            { direction: 'in', body: 'Thanks! What do you build?' },
            { direction: 'out', body: 'Trevra.', stamp: '10:42 AM' }
          ]
        })
      ]
    });

    const transcript = await readThread(new FakePage(state), '2-thread0==', { sleep: recorder().sleep, now: clock });
    if (!isThreadTranscript(transcript)) throw new Error(`expected a transcript, got ${transcript.failureKind}`);
    expect(transcript.messages).toEqual([
      { at: '2026-08-03T00:00:00.000Z', direction: 'out', body: 'Hi Maya, saw your talk.' },
      // Inherits the group timestamp above it: LinkedIn renders one per group.
      { at: '2026-08-03T00:00:00.000Z', direction: 'in', body: 'Thanks! What do you build?' },
      { at: '2026-08-04T10:42:00.000Z', direction: 'out', body: 'Trevra.' }
    ]);
  });

  it('reads the NEWEST maxMessages, not the first', async () => {
    const messages: FakeMessage[] = Array.from({ length: 6 }, (_unused, index) => ({
      direction: index % 2 === 0 ? 'out' : 'in',
      body: `message ${index}`
    }));
    const state = world({ threads: [thread(0, { messages })] });

    const transcript = await readThread(new FakePage(state), '2-thread0==', { maxMessages: 2, sleep: recorder().sleep, now: clock });
    if (!isThreadTranscript(transcript)) throw new Error('expected a transcript');
    expect(transcript.messages.map((entry) => entry.body)).toEqual(['message 4', 'message 5']);
    expect(transcript.degraded[0]).toContain('newest 2');
  });

  it('skips an item with no readable body rather than filing a blank bubble', async () => {
    const state = world({
      threads: [thread(0, { messages: [{ direction: 'in', body: '', bodyless: true }, { direction: 'in', body: 'real' }] })]
    });
    const transcript = await readThread(new FakePage(state), '2-thread0==', { sleep: recorder().sleep, now: clock });
    if (!isThreadTranscript(transcript)) throw new Error('expected a transcript');
    expect(transcript.messages.map((entry) => entry.body)).toEqual(['real']);
  });

  it('refuses an id that is not a conversation id, without navigating', async () => {
    const page = new FakePage(world({ threads: [thread(0)] }));
    const before = page.url();
    const result = await readThread(page, 'https://evil.example/', { sleep: recorder().sleep, now: clock });
    if (isThreadTranscript(result)) throw new Error('expected a refusal');
    expect(result.failureKind).toBe('not_found');
    expect(page.url()).toBe(before);
  });

  it('reports drift when the message list is gone', async () => {
    const state = world({ threads: [thread(0)], messageList: 'missing' });
    const result = await readThread(new FakePage(state), '2-thread0==', { sleep: recorder().sleep, now: clock });
    if (isThreadTranscript(result)) throw new Error('expected a refusal');
    expect(result.failureKind).toBe('selector_drift');
  });
});

describe('sendReply', () => {
  it('sends the approved bytes verbatim and reports the thread it landed in', async () => {
    const page = new FakePage(world({ threads: [thread(0)] }));
    const result = await sendReply(page, '2-thread0==', 'Happy to send it over.');
    expect(result).toEqual({
      ok: true,
      externalRef: 'https://www.linkedin.com/messaging/thread/2-thread0%3D%3D/',
      failureKind: null
    });
    expect(page.typed).toEqual(['Happy to send it over.']);
    expect(page.sent).toBe(1);
  });

  it('refuses to open a composer with nothing approved to put in it', async () => {
    const page = new FakePage(world({ threads: [thread(0)] }));
    const result = await sendReply(page, '2-thread0==', '   ');
    expect(result.failureKind).toBe('selector_drift');
    expect(page.typed).toEqual([]);
    expect(page.sent).toBe(0);
  });

  it('types nothing when the send control is missing', async () => {
    // Both controls are read before either is used, so this is "nothing was
    // typed" rather than a draft abandoned in somebody's inbox.
    const page = new FakePage(world({ threads: [thread(0)], composer: 'no-send' }));
    const result = await sendReply(page, '2-thread0==', 'hello');
    expect(result.failureKind).toBe('selector_drift');
    expect(page.typed).toEqual([]);
  });

  it('reports a limit wall raised in answer to the send', async () => {
    const page = new FakePage(world({ threads: [thread(0)], wall: 'limit', wallAt: 'after-send' }));
    const result = await sendReply(page, '2-thread0==', 'hello');
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('limit_wall');
  });

  it('refuses a conversation id it cannot trust', async () => {
    const page = new FakePage(world({ threads: [thread(0)] }));
    const result = await sendReply(page, 'https://evil.example/thread/1', 'hello');
    expect(result.failureKind).toBe('not_found');
    expect(page.sent).toBe(0);
  });
});

describe('the selector table', () => {
  it('scopes every row read to its own row', () => {
    // Not a style point: `${row} .a, .b` is a selector LIST, and the second
    // alternative would match the whole page.
    expect(INBOX_SELECTORS.rowUnreadBadge).toContain(',');
    expect(INBOX_SELECTORS.conversationRow.startsWith(INBOX_SELECTORS.conversationList)).toBe(true);
  });
});
