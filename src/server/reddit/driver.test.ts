import { describe, expect, it } from 'vitest';
import {
  MAX_READ_LIMIT,
  SELECTORS,
  commentOnThread,
  isLoggedIn,
  isOtpRequired,
  isResearchRead,
  loginWithCredentials,
  normaliseSubreddit,
  readSubreddit,
  threadUrlFor,
  type RedditDriverResult,
  type RedditLocator,
  type RedditPage,
  type RedditResearchRead
} from './driver.js';

/**
 * NO BROWSER IS LAUNCHED AND NO REDDIT REQUEST IS MADE BY THIS FILE, EVER.
 *
 * Not a convenience: the surface under test SIGNS IN AS A REAL PERSON AND
 * POSTS A COMMENT, so a suite that touched a live account would spend that
 * account's standing on CI -- and a comment cannot be un-posted any more than
 * a login burst can be un-noticed by Reddit's anti-abuse.
 *
 * What is asserted is the handful of properties the whole subsystem rests on:
 *
 *   1. THE TARGET GUARD. `threadUrlFor` and `normaliseSubreddit` decide where
 *      an AUTHENTICATED browser is pointed, so anything that is not a Reddit
 *      thread or a plain community name has to come back null rather than be
 *      dialled.
 *   2. NEITHER HALF OF THE SIGN-IN EVER APPEARS IN AN ANSWER. The password and
 *      the handle below are canaries -- strings that appear nowhere else in
 *      this codebase -- and every login path is swept for both.
 *   3. THE PRE-CLICK / POST-CLICK BOUNDARY. A routine that reports "Nothing was
 *      typed" must actually have typed nothing, and anything ambiguous after a
 *      click is `unknown` rather than a failure the caller would retry into a
 *      duplicate comment.
 *   4. A PARTIAL READ IS STILL A READ. One unreadable row is named in
 *      `degraded` and skipped; a count nobody could read is null, never zero.
 */

/** Deliberately distinctive. Any occurrence of either outside a form fill is a bug. */
const PASSWORD = 'canary-Pa55word-never-echo-me';
const USERNAME = 'canary_handle_zt7';
const CREDENTIALS = { username: USERNAME, password: PASSWORD };

/* ---------------------------------------------------------------------------
 * The fake page: a selector table, not a browser.
 * ------------------------------------------------------------------------ */

type SelectorName = keyof typeof SELECTORS;

/**
 * Selector string -> the name it has in `SELECTORS`.
 *
 * So a test says `showing: ['otpField']` instead of repeating a 200-character
 * CSS union, and so a selector renamed in `driver.ts` fails here rather than
 * silently matching nothing.
 */
const SELECTOR_NAMES = new Map<string, SelectorName>(
  (Object.entries(SELECTORS) as Array<[SelectorName, string]>).map(([name, selector]) => [selector, name])
);

/** One listing row, as old Reddit's `data-*` attributes carry it. */
interface FakePost {
  permalink?: string | null;
  fullname?: string | null;
  title?: string | null;
  author?: string | null;
  subreddit?: string | null;
  score?: string | null;
  comments?: string | null;
  timestamp?: string | null;
}

interface FakePageOptions {
  /** Which selectors match one node. Everything unnamed matches nothing. */
  showing?: SelectorName[];
  /** Selectors that only appear once something has been clicked or pressed. */
  showingAfterSubmit?: SelectorName[];
  /**
   * Is the session live? It decides where `/settings/` lands, which is exactly
   * how `isLoggedIn` answers -- by URL, so no markup has to hold still for it.
   */
  signedIn?: boolean;
  /** The listing rows `readSubreddit` walks. */
  posts?: FakePost[];
  /**
   * WHICH LISTING MARKUP THIS PAGE RENDERS.
   *
   * The driver tries new Reddit first and falls back to old, so a fake that
   * only ever renders one of them is also a test of which one it is. 'old' is
   * the default because that is what most of these tests were written against;
   * 'new' proves the primary surface is read on the FIRST navigation, with no
   * fallback load at all.
   */
  surface?: 'old' | 'new';
  /**
   * The bot check, as Reddit actually serves it: the requested path comes back
   * with `?js_challenge=1&solution=…` bolted on and a body carrying no posts.
   * It is the reason `isLoggedIn` cannot trust a URL alone.
   */
  challenged?: boolean;
  /** False models a page whose fields cannot press a key (see `RedditLocator.press`). */
  canPress?: boolean;
}

interface FakePage {
  page: RedditPage;
  /** Every fill, in order, so "nothing was typed" can be asserted rather than trusted. */
  typed: Array<{ into: string; value: string }>;
  clicked: string[];
  pressed: Array<{ into: string; key: string }>;
  /** Every URL the driver asked for, in order. */
  visited: string[];
}

function fakePage(options: FakePageOptions = {}): FakePage {
  const showing = new Set<SelectorName>(options.showing ?? []);
  const posts = options.posts ?? [];
  const typed: Array<{ into: string; value: string }> = [];
  const clicked: string[] = [];
  const pressed: Array<{ into: string; key: string }> = [];
  const visited: string[] = [];
  let current = 'https://www.reddit.com/';

  /** What the page turns into once a control has been operated. */
  const submitted = (): void => {
    for (const name of options.showingAfterSubmit ?? []) showing.add(name);
  };

  const makeLocator = (spec: {
    label: string;
    count: number;
    text?: string | null;
    attributes?: Record<string, string | null>;
  }): RedditLocator => {
    const locator: RedditLocator = {
      count: async () => spec.count,
      first: () => makeLocator(spec),
      click: async () => {
        clicked.push(spec.label);
        submitted();
      },
      fill: async (value: string) => {
        typed.push({ into: spec.label, value });
      },
      textContent: async () => spec.text ?? null,
      getAttribute: async (name: string) => spec.attributes?.[name] ?? null
    };
    // ABSENT, not stubbed, when the page cannot type a key: the driver reads
    // `typeof locator.press !== 'function'` to decide whether the Enter-key
    // fallback is available at all.
    if (options.canPress !== false) {
      locator.press = async (key: string) => {
        pressed.push({ into: spec.label, key });
        submitted();
      };
    }
    return locator;
  };

  const page: RedditPage = {
    goto: async (url: string) => {
      visited.push(url);
      // THE CHALLENGE KEEPS THE PATH IT INTERRUPTED. That is the whole trap:
      // a challenged `/settings/` still contains `/settings/`, so anything
      // reading the URL alone concludes the session is live.
      if (options.challenged) {
        current = `${url}${url.includes('?') ? '&' : '?'}js_challenge=1&solution=deadbeef`;
        return undefined;
      }
      // Signed out, Reddit bounces `/settings/` to `/login`. That redirect IS
      // the session probe, so the fake performs it rather than faking a marker.
      current = url.includes('/settings') && !options.signedIn ? 'https://www.reddit.com/login/?dest=settings' : url;
      return undefined;
    },
    url: () => current,
    waitForTimeout: async () => {},
    locator: (selector: string) => {
      // Only the surface this page renders answers with rows; the other one is
      // an empty listing, which is exactly what a real fallback looks like.
      const listing = (options.surface ?? 'old') === 'new' ? SELECTORS.shredditPost : SELECTORS.listingPost;
      const attributesOf = (item: FakePost | undefined): Record<string, string | null> =>
        (options.surface ?? 'old') === 'new'
          ? {
            permalink: item?.permalink ?? null,
            id: item?.fullname ?? null,
            'post-title': item?.title ?? null,
            author: item?.author ?? null,
            'subreddit-prefixed-name': item?.subreddit ?? null,
            score: item?.score ?? null,
            'comment-count': item?.comments ?? null,
            'created-timestamp': item?.timestamp ?? null
          }
          : {
            'data-permalink': item?.permalink ?? null,
            'data-fullname': item?.fullname ?? null,
            'data-author': item?.author ?? null,
            'data-subreddit': item?.subreddit ?? null,
            'data-score': item?.score ?? null,
            'data-comments-count': item?.comments ?? null,
            'data-timestamp': item?.timestamp ?? null
          };

      // The listing count is the number of rows, not a boolean.
      if (selector === listing) return makeLocator({ label: 'listingPost', count: posts.length });

      const named = SELECTOR_NAMES.get(selector);
      if (named) return makeLocator({ label: named, count: showing.has(named) ? 1 : 0 });

      // The two chained forms `readSubreddit` builds: one row, and that row's title.
      const title = /^(.*) >> nth=(\d+) >> a\.title$/.exec(selector);
      if (title && title[1] === listing) {
        const item = posts[Number(title[2])];
        return makeLocator({ label: `post:${title[2]}:title`, count: item?.title ? 1 : 0, text: item?.title ?? null });
      }
      const row = /^(.*) >> nth=(\d+)$/.exec(selector);
      if (row && row[1] === listing) {
        const item = posts[Number(row[2])];
        return makeLocator({ label: `post:${row[2]}`, count: item ? 1 : 0, attributes: attributesOf(item) });
      }
      return makeLocator({ label: selector, count: 0 });
    }
  };

  return { page, typed, clicked, pressed, visited };
}

/** The sign-in form, as it is on a page that has not drifted. */
const LOGIN_FORM: SelectorName[] = ['loginUsernameField', 'loginPasswordField', 'loginSubmitButton'];

/** Every string an answer could hide a credential in, swept in one place. */
function expectNoCredentials(value: unknown): void {
  const serialised = JSON.stringify(value) ?? '';
  expect(serialised).not.toContain(PASSWORD);
  expect(serialised).not.toContain(USERNAME);
  // Not even a fragment: a truncated password is still a password.
  expect(serialised).not.toContain(PASSWORD.slice(0, 8));
}

function expectRead(value: RedditResearchRead | RedditDriverResult): RedditResearchRead {
  if (!isResearchRead(value)) throw new Error(`expected a read, got ${value.failureKind}: ${value.detail}`);
  return value;
}

function expectReadFailure(value: RedditResearchRead | RedditDriverResult): RedditDriverResult {
  if (isResearchRead(value)) throw new Error('expected a failure, got a read');
  return value;
}

/** A listing row with every attribute readable, so a test can null out exactly one. */
function post(id: string, extra: Partial<FakePost> = {}): FakePost {
  return {
    permalink: `/r/SaaS/comments/${id}/a_title/`,
    fullname: `t3_${id}`,
    title: `Title ${id}`,
    author: 'someone',
    subreddit: 'SaaS',
    score: '42',
    comments: '7',
    timestamp: '1767225600000',
    ...extra
  };
}

const THREAD_URL = 'https://www.reddit.com/r/SaaS/comments/abc123/a_title/';
const CANONICAL_THREAD_URL = 'https://www.reddit.com/r/SaaS/comments/abc123/a_title/';

/* ---------------------------------------------------------------------------
 * Where the browser may be pointed.
 * ------------------------------------------------------------------------ */

describe('threadUrlFor', () => {
  it('accepts every Reddit host a permalink actually arrives on, and the bare path', () => {
    for (const host of ['www.reddit.com', 'old.reddit.com', 'np.reddit.com', 'reddit.com']) {
      expect(threadUrlFor(`https://${host}/r/SaaS/comments/abc123/a_title/`)).toBe(CANONICAL_THREAD_URL);
    }
    // A bare permalink is exactly what `readSubreddit` hands back, so the two
    // routines compose without the caller reassembling anything.
    expect(threadUrlFor('/r/SaaS/comments/abc123/')).toBe('https://www.reddit.com/r/SaaS/comments/abc123/');
    expect(threadUrlFor('  /r/SaaS/comments/abc123/a_title/  ')).toBe(CANONICAL_THREAD_URL);
  });

  it('drops the query and the hash, which change what a human sees and not which thread it is', () => {
    expect(threadUrlFor('https://www.reddit.com/r/SaaS/comments/abc123/a_title?context=3#t1_xyz')).toBe(CANONICAL_THREAD_URL);
  });

  it('REFUSES anything that is not a Reddit thread', () => {
    // THE GUARD THIS WHOLE FUNCTION EXISTS FOR. `target` is an opaque string a
    // human typed and the driver opens it in a SESSION-BEARING browser, so a
    // host that is not Reddit's is a signed-in tab on somebody else's site.
    expect(threadUrlFor('https://evil.example/r/SaaS/comments/abc123/')).toBeNull();
    expect(threadUrlFor('https://reddit.com.evil.example/r/SaaS/comments/abc123/')).toBeNull();
    expect(threadUrlFor('https://evil.example/?x=https://www.reddit.com/r/SaaS/comments/abc123/')).toBeNull();
    // A protocol-relative reference is a host swap wearing a path's clothes.
    expect(threadUrlFor('//evil.example/r/SaaS/comments/abc123/')).toBeNull();

    // A Reddit host is not enough on its own: it has to be a thread.
    expect(threadUrlFor('https://www.reddit.com/settings/')).toBeNull();
    expect(threadUrlFor('https://www.reddit.com/r/SaaS/new/')).toBeNull();
    expect(threadUrlFor('/r/SaaS/new/')).toBeNull();
    expect(threadUrlFor('/etc/passwd')).toBeNull();

    // Not a scheme a browser may be pointed at at all.
    expect(threadUrlFor('javascript:alert(document.cookie)')).toBeNull();
    expect(threadUrlFor('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(threadUrlFor('file:///etc/passwd')).toBeNull();

    expect(threadUrlFor('')).toBeNull();
    expect(threadUrlFor('   ')).toBeNull();
    expect(threadUrlFor('not a url at all')).toBeNull();
  });
});

describe('normaliseSubreddit', () => {
  it('strips the prefix, and the whole URL around it', () => {
    expect(normaliseSubreddit('SaaS')).toBe('SaaS');
    expect(normaliseSubreddit(' r/SaaS ')).toBe('SaaS');
    expect(normaliseSubreddit('/r/SaaS')).toBe('SaaS');
    expect(normaliseSubreddit('https://www.reddit.com/r/SaaS/new/')).toBe('SaaS');
    expect(normaliseSubreddit('https://old.reddit.com/r/SaaS/')).toBe('SaaS');
  });

  it('refuses everything that is not a plain community name', () => {
    // A multireddit is two communities, and this driver reads one page at a time.
    expect(normaliseSubreddit('SaaS+startups')).toBeNull();
    // Reddit's own ceiling is 21 characters.
    expect(normaliseSubreddit('a'.repeat(22))).toBeNull();
    expect(normaliseSubreddit('../../etc/passwd')).toBeNull();
    expect(normaliseSubreddit('/etc/passwd')).toBeNull();
    expect(normaliseSubreddit('SaaS?limit=100')).toBeNull();
    expect(normaliseSubreddit('r/')).toBeNull();
    expect(normaliseSubreddit('')).toBeNull();
  });

  /**
   * A BARE NAME WITH A SLASH IN IT IS NOT A NAME, and it is refused rather than
   * truncated: reading `SaaS` for somebody who typed `SaaS/evil` answers a
   * question they did not ask.
   */
  it('refuses a bare name carrying a path rather than truncating it', () => {
    expect(normaliseSubreddit('SaaS/evil')).toBeNull();
    expect(normaliseSubreddit('SaaS/../../evil')).toBeNull();
    expect(normaliseSubreddit('SaaS/')).toBeNull();
  });

  /**
   * A string that ANNOUNCES itself as a path -- `r/...` or a reddit URL -- keeps
   * only its name segment, which is what makes `.../r/SaaS/new/` resolve at
   * all. The property that protects the navigation is asserted directly:
   * nothing with a slash in it ever reaches the URL the name is interpolated
   * into.
   */
  it('keeps only the name segment of a path, and it is always URL-safe', () => {
    for (const raw of ['r/SaaS/comments/abc123/', 'https://old.reddit.com/r/SaaS/top/', 'r/SaaS/../../evil']) {
      const name = normaliseSubreddit(raw);
      expect(name).toBe('SaaS');
      expect(name).not.toContain('/');
      expect(name).toMatch(/^[A-Za-z0-9_]{2,21}$/);
    }
  });

  /** A host that merely CONTAINS `reddit.com` is somebody else's server. */
  it('refuses a lookalike host', () => {
    expect(normaliseSubreddit('https://reddit.com.evil.example/r/SaaS')).toBeNull();
    expect(normaliseSubreddit('https://evil.example/r/SaaS')).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Signing in.
 * ------------------------------------------------------------------------ */

describe('loginWithCredentials', () => {
  it('types both halves into the form and answers with nothing but ok', async () => {
    const { page, typed, clicked } = fakePage({ showing: LOGIN_FORM, signedIn: true });

    const result = await loginWithCredentials(page, CREDENTIALS);

    expect(result).toEqual({ ok: true });
    // The password goes into the password field and nowhere else.
    expect(typed).toEqual([
      { into: 'loginUsernameField', value: USERNAME },
      { into: 'loginPasswordField', value: PASSWORD }
    ]);
    expect(clicked).toEqual(['loginSubmitButton']);
    expectNoCredentials(result);
  });

  it('treats a two-factor prompt as a STEP rather than a failure', async () => {
    const { page } = fakePage({ showing: LOGIN_FORM, showingAfterSubmit: ['otpField'] });

    const result = await loginWithCredentials(page, CREDENTIALS);

    expect(result).toEqual({ ok: false, needsOtp: true });
    expect(isOtpRequired(result)).toBe(true);
    // No `failureKind`, because nothing went wrong: the operator has the code.
    expect('failureKind' in result).toBe(false);
    expectNoCredentials(result);
  });

  it('reports a rejected pair as not_found, without repeating either half back', async () => {
    const { page } = fakePage({ showing: LOGIN_FORM, showingAfterSubmit: ['loginError'] });

    const result = await loginWithCredentials(page, CREDENTIALS) as RedditDriverResult;

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('not_found');
    expect(result.detail).toContain('did not accept that username and password');
    expectNoCredentials(result);
  });

  it('reports a captcha as a challenge, which only a person can finish', async () => {
    const { page } = fakePage({ showing: LOGIN_FORM, showingAfterSubmit: ['challengeForm'] });

    const result = await loginWithCredentials(page, CREDENTIALS) as RedditDriverResult;

    expect(result.failureKind).toBe('challenge');
    expect(result.detail).toContain('only a person at a browser window can finish');
    expectNoCredentials(result);
  });

  it('reports drift, and types NOTHING, when the form is not on the sign-in page', async () => {
    // Still on `/login` with no username field is the drift case; the same miss
    // on a page that redirected AWAY from `/login` is a live session, not drift.
    const { page, typed, clicked, pressed } = fakePage({ showing: [] });

    const result = await loginWithCredentials(page, CREDENTIALS) as RedditDriverResult;

    expect(result.failureKind).toBe('selector_drift');
    expect(result.detail).toContain('Nothing was typed');
    expect(typed).toEqual([]);
    expect(clicked).toEqual([]);
    expect(pressed).toEqual([]);
    expectNoCredentials(result);
  });

  it('types NOTHING when the password field is missing, because both controls are read first', async () => {
    const { page, typed } = fakePage({ showing: ['loginUsernameField', 'loginSubmitButton'] });

    const result = await loginWithCredentials(page, CREDENTIALS) as RedditDriverResult;

    expect(result.failureKind).toBe('selector_drift');
    expect(result.detail).toContain('Nothing was typed');
    // A username sitting in a form nobody submitted would be the worse outcome.
    expect(typed).toEqual([]);
  });

  it('submits with Enter when Reddit reskins the button away', async () => {
    // THE DOCUMENTED FALLBACK. The submit control is a shadow-DOM button with
    // hashed classes, so refusing the sign-in over a button we cannot name
    // would strand every account the next time Reddit reskins that page.
    const { page, typed, clicked, pressed } = fakePage({
      showing: ['loginUsernameField', 'loginPasswordField'],
      signedIn: true
    });

    const result = await loginWithCredentials(page, CREDENTIALS);

    expect(result).toEqual({ ok: true });
    expect(clicked).toEqual([]);
    expect(pressed).toEqual([{ into: 'loginPasswordField', key: 'Enter' }]);
    expect(typed.map((entry) => entry.into)).toEqual(['loginUsernameField', 'loginPasswordField']);
  });

  it('types nothing when there is neither a button nor a key to press', async () => {
    const { page, typed } = fakePage({
      showing: ['loginUsernameField', 'loginPasswordField'],
      canPress: false
    });

    const result = await loginWithCredentials(page, CREDENTIALS) as RedditDriverResult;

    expect(result.failureKind).toBe('selector_drift');
    expect(result.detail).toContain('Nothing was typed');
    expect(typed).toEqual([]);
  });

  it('NEVER puts either half of the pair into an answer, on ANY path', async () => {
    // THE CANARY SWEEP, over every branch rather than the three somebody
    // remembered to check. `detail` is built from constants, selector names and
    // the page's own URL -- an interpolated argument anywhere fails here.
    const branches: Array<[string, FakePageOptions]> = [
      ['signed in', { showing: LOGIN_FORM, signedIn: true }],
      ['two-factor', { showing: LOGIN_FORM, showingAfterSubmit: ['otpField'] }],
      ['wrong pair', { showing: LOGIN_FORM, showingAfterSubmit: ['loginError'] }],
      ['captcha', { showing: LOGIN_FORM, showingAfterSubmit: ['challengeForm'] }],
      ['rate limit', { showing: LOGIN_FORM, showingAfterSubmit: ['rateLimitNotice'] }],
      ['not found', { showing: LOGIN_FORM, showingAfterSubmit: ['notFoundNotice'] }],
      ['drift', { showing: [] }],
      ['no password field', { showing: ['loginUsernameField', 'loginSubmitButton'] }],
      ['nothing to press', { showing: ['loginUsernameField', 'loginPasswordField'], canPress: false }],
      ['submitted into silence', { showing: LOGIN_FORM }]
    ];

    for (const [name, options] of branches) {
      const { page } = fakePage(options);
      const result = await loginWithCredentials(page, CREDENTIALS);
      expect(JSON.stringify({ name, result })).not.toContain(PASSWORD);
      expectNoCredentials(result);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Is there a session at all?
 * ------------------------------------------------------------------------ */

describe('isLoggedIn', () => {
  it('answers by URL: /settings/ stays put on a live session', async () => {
    const { page } = fakePage({ signedIn: true });
    expect(await isLoggedIn(page)).toBe(true);
  });

  it('answers false when Reddit bounces /settings/ to the login form', async () => {
    const { page } = fakePage({ signedIn: false });
    expect(await isLoggedIn(page)).toBe(false);
  });

  /**
   * THE REGRESSION THIS EXISTS FOR, and it shipped once. Reddit's bot check
   * reloads the path it interrupted, so a challenged `/settings/` request lands
   * on a URL that STILL CONTAINS `/settings/`. Reading that as a live session
   * stamps `session_valid_at` on a page that proved nothing, and a status
   * screen then reports a connection that has never existed.
   */
  it('answers false on a bot check that kept the /settings/ path', async () => {
    const { page } = fakePage({ signedIn: true, challenged: true });
    expect(await isLoggedIn(page)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Reading a subreddit.
 * ------------------------------------------------------------------------ */

describe('readSubreddit', () => {
  it('reads the listing off new Reddit, on the first navigation and with no fallback load', async () => {
    const { page, visited } = fakePage({ surface: 'new', posts: [post('abc123'), post('def456', { score: '1,204' })] });

    const read = expectRead(await readSubreddit(page, 'r/SaaS', { sort: 'new', limit: 2 }));

    expect(visited).toEqual(['https://www.reddit.com/r/SaaS/new/?limit=2']);
    expect(read.subreddit).toBe('SaaS');
    expect(read.sort).toBe('new');
    expect(read.threads).toEqual([
      {
        id: 't3_abc123',
        url: 'https://www.reddit.com/r/SaaS/comments/abc123/a_title/',
        title: 'Title abc123',
        author: 'someone',
        subreddit: 'SaaS',
        score: 42,
        comments: 7,
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 't3_def456',
        url: 'https://www.reddit.com/r/SaaS/comments/def456/a_title/',
        title: 'Title def456',
        author: 'someone',
        subreddit: 'SaaS',
        // Old Reddit prints four figures with a comma, and a comma is not a digit.
        score: 1204,
        comments: 7,
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]);
    expect(read.degraded).toEqual([]);
  });

  it('SKIPS a row with no permalink and names it, rather than failing the read', async () => {
    // The fields fail independently, so a listing with one unreadable row is a
    // partial answer -- and reporting it as a failure would throw away the rest.
    const { page } = fakePage({ surface: 'new', posts: [post('abc123'), post('ghost', { permalink: null }), post('def456')] });

    const read = expectRead(await readSubreddit(page, 'SaaS'));

    expect(read.threads.map((thread) => thread.id)).toEqual(['t3_abc123', 't3_def456']);
    expect(read.degraded).toEqual(['Post 2 carried no usable permalink, so it was skipped.']);
  });

  /**
   * OLD REDDIT IS THE FALLBACK, NOT THE PRIMARY, and this is the test that says
   * so. It was the primary until `old.reddit.com` started serving the same app
   * shell as `www` and this driver reported "no posts" on a subreddit with
   * thousands -- so the order is load-bearing, and an empty new listing must
   * cost exactly one extra page load and then work.
   */
  it('falls back to old Reddit when the new listing renders nothing', async () => {
    const { page, visited } = fakePage({ surface: 'old', posts: [post('abc123')] });

    const read = expectRead(await readSubreddit(page, 'SaaS', { limit: 1 }));

    expect(visited).toEqual([
      'https://www.reddit.com/r/SaaS/hot/?limit=1',
      'https://old.reddit.com/r/SaaS/hot/?limit=1'
    ]);
    expect(read.threads.map((thread) => thread.id)).toEqual(['t3_abc123']);
    // The empty first surface is REPORTED rather than hidden: a read that
    // silently took the slow path looks identical to one that did not.
    expect(read.degraded.some((line) => line.includes('new Reddit rendered no posts'))).toBe(true);
  });

  /**
   * BEING BLOCKED IS NOT SELECTOR DRIFT. Reddit answers a container's IP with a
   * bot check and a body carrying no posts; calling that drift sends an
   * operator to edit a CSS table over a network problem they cannot fix there.
   */
  it('reports a network block as a challenge naming the machine, not as drift', async () => {
    const { page } = fakePage({ challenged: true, posts: [post('abc123')] });

    const failure = expectReadFailure(await readSubreddit(page, 'SaaS'));

    expect(failure.failureKind).toBe('challenge');
    expect(failure.detail).toContain("blocked this machine's network");
    expect(failure.detail).toContain('npm run reddit:worker');
  });

  it('will not build a thread URL out of a permalink pointing off Reddit', async () => {
    const { page } = fakePage({ posts: [post('evil', { permalink: 'https://evil.example/r/SaaS/comments/abc123/' })] });

    const failure = expectReadFailure(await readSubreddit(page, 'SaaS'));
    expect(failure.failureKind).toBe('selector_drift');
    expect(failure.detail).toContain('Nothing was read');
  });

  it('reports a count nobody could read as NULL, never as zero', async () => {
    // Zero is a real score and a real comment count. Ranking research on a
    // number nobody measured is the bug this null exists to prevent.
    const { page } = fakePage({ posts: [post('abc123', { score: null, comments: null, timestamp: null })] });

    const read = expectRead(await readSubreddit(page, 'SaaS'));

    expect(read.threads[0].score).toBeNull();
    expect(read.threads[0].comments).toBeNull();
    expect(read.threads[0].createdAt).toBeNull();
    expect(read.threads[0].score).not.toBe(0);
    expect(read.threads[0].comments).not.toBe(0);
  });

  it('reports a private community as forbidden, which is not a rate limit', async () => {
    // Definite: no amount of waiting opens a community this account cannot see,
    // and treating it as a rate limit would idle a healthy account for hours.
    const { page } = fakePage({ showing: ['subredditForbidden'], posts: [post('abc123')] });

    const failure = expectReadFailure(await readSubreddit(page, 'SaaS'));

    expect(failure.failureKind).toBe('forbidden');
    expect(failure.detail).toContain('r/SaaS is private, quarantined, or this account cannot see it.');
  });

  it('refuses a name that is not a community, before opening anything', async () => {
    const { page, visited } = fakePage({ posts: [post('abc123')] });

    const failure = expectReadFailure(await readSubreddit(page, 'SaaS+startups'));

    expect(failure.failureKind).toBe('not_found');
    expect(visited).toEqual([]);
  });

  it('clamps the limit to Reddit\'s own per-page maximum', async () => {
    // Asking for more just paginates, which is a second request and a second
    // chance to be rate-limited, for research nobody reads that far into.
    const { page, visited } = fakePage({ surface: 'new', posts: [post('abc123')] });
    await readSubreddit(page, 'SaaS', { limit: 500 });
    expect(visited).toEqual([`https://www.reddit.com/r/SaaS/hot/?limit=${MAX_READ_LIMIT}`]);

    // And the clamp bounds what is READ, not only what is asked for.
    const bounded = fakePage({ surface: 'new', posts: [post('abc123'), post('def456'), post('ghi789')] });
    const read = expectRead(await readSubreddit(bounded.page, 'SaaS', { limit: 1 }));
    expect(read.threads).toHaveLength(1);
    expect(bounded.visited).toEqual(['https://www.reddit.com/r/SaaS/hot/?limit=1']);
  });
});

/* ---------------------------------------------------------------------------
 * Replying: the one routine that writes.
 * ------------------------------------------------------------------------ */

describe('commentOnThread', () => {
  it('posts the reply, and only calls it posted once the comment tree carries one', async () => {
    const { page, typed, clicked, visited } = fakePage({
      showing: ['commentBox', 'commentSubmit'],
      showingAfterSubmit: ['commentPosted']
    });

    const result = await commentOnThread(page, THREAD_URL, '  Some words the operator wrote.  ');

    expect(result).toEqual({
      ok: true,
      failureKind: null,
      externalRef: CANONICAL_THREAD_URL,
      detail: `Replied in ${CANONICAL_THREAD_URL}.`
    });
    expect(visited).toEqual([CANONICAL_THREAD_URL]);
    expect(typed).toEqual([{ into: 'commentBox', value: 'Some words the operator wrote.' }]);
    expect(clicked).toEqual(['commentSubmit']);
  });

  it('refuses a target that is not a Reddit thread, without opening anything', async () => {
    const { page, visited, typed, clicked } = fakePage({ showing: ['commentBox', 'commentSubmit'] });

    const result = await commentOnThread(page, 'https://evil.example/steal', 'Some words.');

    expect(result.failureKind).toBe('not_found');
    expect(result.detail).toContain('Nothing was opened');
    expect(visited).toEqual([]);
    expect(typed).toEqual([]);
    expect(clicked).toEqual([]);
  });

  it('reports an archived or locked thread as forbidden, and TYPES NOTHING', async () => {
    // Definite, and not a rate limit: no amount of waiting opens an archived
    // thread. The reply box may even be on the page; it is never used.
    const { page, typed, clicked } = fakePage({ showing: ['repliesClosed', 'commentBox', 'commentSubmit'] });

    const result = await commentOnThread(page, THREAD_URL, 'Some words.');

    expect(result.failureKind).toBe('forbidden');
    expect(result.detail).toContain('Nothing was typed');
    expect(typed).toEqual([]);
    expect(clicked).toEqual([]);
  });

  it('reports drift, and types nothing, when the reply box has no submit control', async () => {
    const { page, typed, clicked } = fakePage({ showing: ['commentBox'] });

    const result = await commentOnThread(page, THREAD_URL, 'Some words.');

    expect(result.failureKind).toBe('selector_drift');
    expect(result.detail).toContain('Nothing was typed');
    expect(typed).toEqual([]);
    expect(clicked).toEqual([]);
  });

  it('reports the rate-limit notice Reddit answers the SUBMIT with', async () => {
    // The common one: Reddit accepts the form and then says "you are doing that
    // too much". Nothing posted, and a retry buys a longer ban.
    const { page, typed, clicked } = fakePage({
      showing: ['commentBox', 'commentSubmit'],
      showingAfterSubmit: ['rateLimitNotice']
    });

    const result = await commentOnThread(page, THREAD_URL, 'Some words.');

    expect(result.failureKind).toBe('rate_limited');
    expect(result.detail).toContain('Wait it out rather than retrying');
    // It really did submit -- which is what makes this different from the walls
    // that are detected before anything is typed.
    expect(typed).toHaveLength(1);
    expect(clicked).toEqual(['commentSubmit']);
  });

  it('is UNKNOWN when the click produced neither a comment nor an error', async () => {
    // A caller that retries an `unknown` posts twice, and a duplicate comment
    // cannot be un-posted -- so this must never be reported as a clean failure.
    const { page, clicked } = fakePage({ showing: ['commentBox', 'commentSubmit'] });

    const result = await commentOnThread(page, THREAD_URL, 'Some words.');

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('unknown');
    expect(result.detail).toContain('Check the thread before replying again.');
    expect(clicked).toEqual(['commentSubmit']);
  });

  it('opens nothing for an empty comment', async () => {
    const { page, visited } = fakePage({ showing: ['commentBox', 'commentSubmit'] });

    const result = await commentOnThread(page, THREAD_URL, '   ');

    expect(result.failureKind).toBe('not_found');
    expect(visited).toEqual([]);
  });
});
