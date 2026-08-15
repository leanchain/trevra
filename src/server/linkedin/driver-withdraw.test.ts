import { describe, expect, it } from 'vitest';
import { SELECTORS, type LinkedInDriverResult } from './driver.js';
import {
  MAX_LIST_PAGES,
  SENT_INVITES_URL,
  WITHDRAW_SELECTORS,
  isPendingInviteList,
  listPendingInvites,
  pageGapSeconds,
  parsePendingSince,
  withdrawInvite,
  type LinkedInListLocator,
  type LinkedInListPage,
  type PendingInviteList
} from './driver-withdraw.js';

/**
 * NO BROWSER IS LAUNCHED AND NO LINKEDIN REQUEST IS MADE BY THIS FILE, EVER.
 *
 * Not a convenience: the surface under test WITHDRAWS CONNECTION INVITES, so a
 * suite that touched a real account would destroy real outreach on CI, and a
 * withdrawn invite cannot be un-withdrawn any more than a sent one can be
 * un-sent.
 *
 * What is asserted is the property the whole feature rests on -- an invite
 * whose entry is not on the live list is never clicked -- plus the failure
 * vocabulary, the pre-click/post-click boundary, and the determinism of the
 * pacing draw.
 */

interface FakeCard {
  href: string | null;
  name: string | null;
  sentAt: string | null;
  withdraw?: boolean;
}

interface FakePageOptions {
  cards?: FakeCard[];
  /** Appended, one array per "show more" click. */
  morePages?: FakeCard[][];
  emptyState?: boolean;
  wall?: 'challenge' | 'limit' | null;
  /** Does a confirmation dialog open after the withdraw click? */
  dialog?: boolean;
  /** Does that dialog carry a confirm control? */
  dialogConfirm?: boolean;
  /** A wall that only appears once the withdraw button has been clicked. */
  wallAfterClick?: 'challenge' | 'limit' | null;
  navFails?: boolean;
  url?: string;
  /**
   * People on the page that this driver could not read as cards.
   *
   * The difference between "nothing to withdraw" and "we cannot read this
   * page": an empty sent list offers nobody at all, while a list this driver
   * has lost the shape of still links to the people on it.
   */
  strayProfileLinks?: boolean;
}

interface FakePage {
  page: LinkedInListPage;
  clicks: string[];
  waits: number[];
}

function emptyLocator(): LinkedInListLocator {
  return locator({ count: 0 });
}

interface LocatorSpec {
  count: number;
  text?: (index: number) => string | null;
  href?: (index: number) => string | null;
  onClick?: (index: number) => void;
  child?: (index: number, selector: string) => LinkedInListLocator;
}

function locator(spec: LocatorSpec, index = 0): LinkedInListLocator {
  return {
    count: async () => spec.count,
    first: () => locator(spec, 0),
    nth: (next: number) => locator(spec, next),
    locator: (selector: string) => (spec.child ? spec.child(index, selector) : emptyLocator()),
    click: async () => {
      spec.onClick?.(index);
    },
    fill: async () => {},
    textContent: async () => (spec.text ? spec.text(index) : null),
    getAttribute: async (name: string) => (name === 'href' && spec.href ? spec.href(index) : null)
  };
}

function fakePage(options: FakePageOptions = {}): FakePage {
  const cards: FakeCard[] = [...(options.cards ?? [])];
  const morePages = [...(options.morePages ?? [])];
  const clicks: string[] = [];
  const waits: number[] = [];
  let wall = options.wall ?? null;
  let dialogOpen = false;

  const cardChild = (index: number, selector: string): LinkedInListLocator => {
    const card = cards[index];
    if (!card) return emptyLocator();
    if (selector === WITHDRAW_SELECTORS.invitationProfileLink) {
      return locator({ count: card.href ? 1 : 0, href: () => card.href });
    }
    if (selector === WITHDRAW_SELECTORS.invitationName) {
      return locator({ count: card.name ? 1 : 0, text: () => card.name });
    }
    if (selector === WITHDRAW_SELECTORS.invitationSentAt) {
      return locator({ count: card.sentAt ? 1 : 0, text: () => card.sentAt });
    }
    if (selector === WITHDRAW_SELECTORS.withdrawButton) {
      return locator({
        count: card.withdraw === false ? 0 : 1,
        onClick: () => {
          clicks.push(`withdraw:${card.href}`);
          if (options.wallAfterClick) wall = options.wallAfterClick;
          else if (options.dialog) dialogOpen = true;
          else cards.splice(index, 1);
        }
      });
    }
    return emptyLocator();
  };

  const page: LinkedInListPage = {
    url: () => options.url ?? SENT_INVITES_URL,
    goto: async () => {
      if (options.navFails) throw new Error('net::ERR_CONNECTION_RESET');
      return undefined;
    },
    waitForTimeout: async (ms: number) => {
      waits.push(ms);
    },
    locator: (selector: string) => {
      if (selector === WITHDRAW_SELECTORS.invitationCard) {
        return locator({ count: cards.length, child: cardChild });
      }
      if (selector === WITHDRAW_SELECTORS.emptyState) {
        return locator({ count: options.emptyState && cards.length === 0 ? 1 : 0 });
      }
      if (selector === WITHDRAW_SELECTORS.invitationProfileLinkAnywhere) {
        // Cards carry profile links, so a page with cards has them by
        // definition; `strayProfileLinks` is for the page that has the people
        // but not the shape.
        return locator({ count: cards.length > 0 || options.strayProfileLinks ? 1 : 0 });
      }
      if (selector === WITHDRAW_SELECTORS.showMoreButton) {
        return locator({
          count: morePages.length > 0 ? 1 : 0,
          onClick: () => {
            clicks.push('show-more');
            cards.push(...(morePages.shift() ?? []));
          }
        });
      }
      if (selector === WITHDRAW_SELECTORS.confirmDialog) {
        return locator({ count: dialogOpen ? 1 : 0 });
      }
      if (selector === WITHDRAW_SELECTORS.confirmWithdrawButton) {
        return locator({
          count: dialogOpen && options.dialogConfirm !== false ? 1 : 0,
          onClick: () => {
            clicks.push('confirm');
            dialogOpen = false;
          }
        });
      }
      if (selector === SELECTORS.challengeForm) return locator({ count: wall === 'challenge' ? 1 : 0 });
      if (selector === SELECTORS.restrictionNotice || selector === SELECTORS.limitWall) {
        return locator({ count: wall === 'limit' ? 1 : 0 });
      }
      return emptyLocator();
    }
  };

  return { page, clicks, waits };
}

const NOW = new Date('2026-08-04T09:00:00.000Z');

function card(handle: string, sentAt: string | null = 'Sent 3 weeks ago', extra: Partial<FakeCard> = {}): FakeCard {
  return { href: `/in/${handle}/`, name: handle, sentAt, ...extra };
}

function expectList(value: PendingInviteList | LinkedInDriverResult): PendingInviteList {
  if (!isPendingInviteList(value)) throw new Error(`expected a list, got ${value.failureKind}: ${value.detail}`);
  return value;
}

function expectFailure(value: PendingInviteList | LinkedInDriverResult): LinkedInDriverResult {
  if (isPendingInviteList(value)) throw new Error('expected a failure, got a list');
  return value;
}

describe('parsePendingSince', () => {
  it('resolves the long form against the supplied instant', () => {
    expect(parsePendingSince('Sent 3 weeks ago', NOW)).toBe('2026-07-14T09:00:00.000Z');
    expect(parsePendingSince('Sent 2 days ago', NOW)).toBe('2026-08-02T09:00:00.000Z');
  });

  it('reads "3mo" as months and "3m" as minutes', () => {
    // Four orders of magnitude apart, and the number this whole feature keys on.
    expect(parsePendingSince('3mo', NOW)).toBe('2026-05-06T09:00:00.000Z');
    expect(parsePendingSince('3m', NOW)).toBe('2026-08-04T08:57:00.000Z');
  });

  it('handles today and yesterday', () => {
    expect(parsePendingSince('Sent today', NOW)).toBe(NOW.toISOString());
    expect(parsePendingSince('Yesterday', NOW)).toBe('2026-08-03T09:00:00.000Z');
  });

  it('returns null rather than guessing at a label it does not understand', () => {
    // The alternative -- defaulting to `now` -- would make every stale invite
    // look fresh and quietly disable age-based withdrawal.
    expect(parsePendingSince('Sent a while back', NOW)).toBeNull();
    expect(parsePendingSince('', NOW)).toBeNull();
    expect(parsePendingSince(null, NOW)).toBeNull();
  });
});

describe('pageGapSeconds', () => {
  it('is deterministic and inside the band', () => {
    const first = pageGapSeconds('seed:0');
    expect(pageGapSeconds('seed:0')).toBe(first);
    expect(first).toBeGreaterThanOrEqual(2);
    expect(first).toBeLessThanOrEqual(6);
  });

  it('differs between pages of the same read', () => {
    expect(pageGapSeconds('seed:0')).not.toBe(pageGapSeconds('seed:1'));
  });
});

describe('listPendingInvites', () => {
  it('canonicalises every profile URL and resolves the sent label', async () => {
    const { page } = fakePage({ cards: [card('maya'), card('sam', '2d')] });
    const list = expectList(await listPendingInvites(page, { now: NOW }));

    expect(list.invites).toEqual([
      { profileUrl: 'https://www.linkedin.com/in/maya/', name: 'maya', sentAt: '2026-07-14T09:00:00.000Z' },
      { profileUrl: 'https://www.linkedin.com/in/sam/', name: 'sam', sentAt: '2026-08-02T09:00:00.000Z' }
    ]);
    expect(list.truncated).toBe(false);
    expect(list.degraded).toEqual([]);
  });

  it('reports an empty sent list as an answer, not a failure', async () => {
    const { page } = fakePage({ cards: [], emptyState: true });
    const list = expectList(await listPendingInvites(page, { now: NOW }));
    expect(list.invites).toEqual([]);
    expect(list.truncated).toBe(false);
  });

  it('reports drift when the page holds people it could not read as cards', async () => {
    // "You have no pending invites" and "we could not see your pending invites"
    // lead to opposite decisions, so they must never collapse into one answer.
    const { page } = fakePage({ cards: [], emptyState: false, strayProfileLinks: true });
    expect(expectFailure(await listPendingInvites(page, { now: NOW })).failureKind).toBe('selector_drift');
  });

  /**
   * THE EMPTY STATE THIS DRIVER CANNOT READ THE WORDS OF.
   *
   * LinkedIn renders in the member's language, and the live seat's says `Keine
   * neuen Einladungen` -- so the English `emptyState` matcher missed, and an
   * empty list was reported as selector drift, the answer that means "stop".
   * A page with no cards AND nobody linked on it has nothing to withdraw in any
   * language.
   */
  it('reads an empty list as empty even when it cannot read the words', async () => {
    const { page } = fakePage({ cards: [], emptyState: false });
    const list = expectList(await listPendingInvites(page, { now: NOW }));
    expect(list.invites).toEqual([]);
    expect(list.degraded).toEqual([]);
  });

  it('reads everything the last expansion loaded', async () => {
    const { page, clicks } = fakePage({ cards: [card('a')], morePages: [[card('b')], [card('c')]] });
    const list = expectList(await listPendingInvites(page, { now: NOW, seed: 'fixed' }));

    expect(list.invites.map((invite) => invite.profileUrl)).toEqual([
      'https://www.linkedin.com/in/a/',
      'https://www.linkedin.com/in/b/',
      'https://www.linkedin.com/in/c/'
    ]);
    expect(clicks.filter((entry) => entry === 'show-more')).toHaveLength(2);
    expect(list.truncated).toBe(false);
  });

  it('pauses between expansions, deterministically', async () => {
    const first = fakePage({ cards: [card('a')], morePages: [[card('b')]] });
    await listPendingInvites(first.page, { now: NOW, seed: 'batch-1' });
    const second = fakePage({ cards: [card('a')], morePages: [[card('b')]] });
    await listPendingInvites(second.page, { now: NOW, seed: 'batch-1' });

    expect(first.waits).toEqual(second.waits);
    expect(first.waits).toContain(Math.round(pageGapSeconds('batch-1:0') * 1000));
  });

  it('says so when it stopped short of the whole backlog', async () => {
    const { page } = fakePage({ cards: [card('a'), card('b')], morePages: [[card('c')]] });
    const list = expectList(await listPendingInvites(page, { now: NOW, maxInvites: 1 }));

    expect(list.invites).toHaveLength(1);
    expect(list.truncated).toBe(true);
    expect(list.degraded.join(' ')).toContain('prefix');
  });

  it('bounds the number of expansions', async () => {
    const morePages = Array.from({ length: MAX_LIST_PAGES + 5 }, (_unused, index) => [card(`x${index}`)]);
    const { page, clicks } = fakePage({ cards: [card('a')], morePages });
    const list = expectList(await listPendingInvites(page, { now: NOW }));

    expect(clicks.filter((entry) => entry === 'show-more')).toHaveLength(MAX_LIST_PAGES);
    expect(list.truncated).toBe(true);
  });

  it('degrades on an unreadable card instead of failing the whole read', async () => {
    const { page } = fakePage({ cards: [card('maya'), { href: null, name: null, sentAt: null }] });
    const list = expectList(await listPendingInvites(page, { now: NOW }));

    expect(list.invites).toHaveLength(1);
    expect(list.degraded.join(' ')).toContain('no readable LinkedIn profile link');
  });

  it('degrades, rather than guessing, when the sent label is unreadable', async () => {
    const { page } = fakePage({ cards: [card('maya', null)] });
    const list = expectList(await listPendingInvites(page, { now: NOW }));

    expect(list.invites[0].sentAt).toBeNull();
    expect(list.degraded.join(' ')).toContain('age is unknown');
  });

  it('drops a card whose href points off LinkedIn', async () => {
    const { page } = fakePage({ cards: [{ href: 'https://evil.example/in/maya/', name: 'x', sentAt: '1d' }] });
    const list = expectList(await listPendingInvites(page, { now: NOW }));
    expect(list.invites).toEqual([]);
  });

  it('reports a challenge on the sent-invitations page and reads nothing', async () => {
    const { page } = fakePage({ cards: [card('maya')], wall: 'challenge' });
    expect(expectFailure(await listPendingInvites(page, { now: NOW })).failureKind).toBe('challenge');
  });

  it('reports a restriction notice as a limit wall', async () => {
    const { page } = fakePage({ cards: [card('maya')], wall: 'limit' });
    expect(expectFailure(await listPendingInvites(page, { now: NOW })).failureKind).toBe('limit_wall');
  });

  it('reports a failed navigation as drift, because nothing was clicked', async () => {
    const { page } = fakePage({ navFails: true });
    expect(expectFailure(await listPendingInvites(page, { now: NOW })).failureKind).toBe('selector_drift');
  });
});

describe('withdrawInvite', () => {
  it('withdraws the matching invite and confirms the dialog', async () => {
    const { page, clicks } = fakePage({
      cards: [card('maya'), card('sam')],
      dialog: true,
      dialogConfirm: true
    });
    const result = await withdrawInvite(page, 'https://www.linkedin.com/in/sam/');

    expect(result).toEqual({ ok: true, externalRef: 'https://www.linkedin.com/in/sam/', failureKind: null });
    expect(clicks).toEqual(['withdraw:/in/sam/', 'confirm']);
  });

  it('accepts a bare handle and canonicalises it', async () => {
    const { page, clicks } = fakePage({ cards: [card('maya')] });
    const result = await withdrawInvite(page, 'maya');

    expect(result.ok).toBe(true);
    expect(result.externalRef).toBe('https://www.linkedin.com/in/maya/');
    expect(clicks).toEqual(['withdraw:/in/maya/']);
  });

  it('CLICKS NOTHING when the invite is no longer on the list', async () => {
    // THE RULE THIS FEATURE LIVES OR DIES BY. An accepted invite has no entry,
    // and an accepted connection must never be torn down by a stale queue row.
    const { page, clicks } = fakePage({ cards: [card('maya')] });
    const result = await withdrawInvite(page, 'https://www.linkedin.com/in/accepted-already/');

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('already_connected');
    expect(result.detail).toContain('no entry in the sent-invitations list');
    expect(clicks).toEqual([]);
  });

  it('clicks nothing when the whole list is empty', async () => {
    const { page, clicks } = fakePage({ cards: [], emptyState: true });
    const result = await withdrawInvite(page, 'maya');

    expect(result.failureKind).toBe('already_connected');
    expect(clicks).toEqual([]);
  });

  it('expands the list to find an invite further down it', async () => {
    const { page, clicks } = fakePage({ cards: [card('a')], morePages: [[card('b')], [card('target')]] });
    const result = await withdrawInvite(page, 'target');

    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['show-more', 'show-more', 'withdraw:/in/target/']);
  });

  it('refuses a target that is not a LinkedIn profile, without opening anything', async () => {
    const { page, clicks } = fakePage({ cards: [card('maya')] });
    const result = await withdrawInvite(page, 'https://evil.example/steal');

    expect(result.failureKind).toBe('not_found');
    expect(clicks).toEqual([]);
  });

  it('reports drift, not failure, when the card carries no withdraw control', async () => {
    const { page, clicks } = fakePage({ cards: [card('maya', '3w', { withdraw: false })] });
    const result = await withdrawInvite(page, 'maya');

    expect(result.failureKind).toBe('selector_drift');
    expect(result.detail).toContain('Nothing was clicked');
    expect(clicks).toEqual([]);
  });

  it('reports drift when the page holds people it could not read as cards', async () => {
    const { page, clicks } = fakePage({ cards: [], emptyState: false, strayProfileLinks: true });
    const result = await withdrawInvite(page, 'maya');

    expect(result.failureKind).toBe('selector_drift');
    expect(clicks).toEqual([]);
  });

  it('reports a limit wall raised by the withdraw click', async () => {
    const { page } = fakePage({ cards: [card('maya')], wallAfterClick: 'limit' });
    const result = await withdrawInvite(page, 'maya');

    expect(result.failureKind).toBe('limit_wall');
    expect(result.detail).toContain('refused, not performed');
  });

  it('reports a challenge raised by the withdraw click', async () => {
    const { page } = fakePage({ cards: [card('maya')], wallAfterClick: 'challenge' });
    expect((await withdrawInvite(page, 'maya')).failureKind).toBe('challenge');
  });

  it('is UNKNOWN, not drift, when a dialog it opened has no confirm control', async () => {
    // Post-click. We put a modal on screen and cannot prove which way it goes,
    // so the caller must hold rather than decide.
    const { page } = fakePage({ cards: [card('maya')], dialog: true, dialogConfirm: false });
    const result = await withdrawInvite(page, 'maya');

    expect(result.failureKind).toBe('unknown');
    expect(result.detail).toContain('Settle it by hand');
  });

  it('reports a challenge URL as a challenge before reading any selector', async () => {
    const { page, clicks } = fakePage({
      cards: [card('maya')],
      url: 'https://www.linkedin.com/checkpoint/challenge/'
    });
    const result = await withdrawInvite(page, 'maya');

    expect(result.failureKind).toBe('challenge');
    expect(clicks).toEqual([]);
  });
});
