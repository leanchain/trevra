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

  it('reports unknown, not compose_unavailable, when the compose box does not appear after a successful Start-post click', async () => {
    // The click already happened -- this is ambiguity AFTER an action, not
    // drift before one, so it must classify the same way sendDm's identical
    // branch does (compose box missing after the Message click): unknown.
    const { page, clicked } = fakePage({
      counts: { [POST_SELECTORS.startPostButton]: 1, [POST_SELECTORS.postComposeBox]: 0 }
    });
    const result = await publishPost(page, 'Hello world');
    expectFailure(result, 'unknown');
    expect(clicked).toEqual([POST_SELECTORS.startPostButton]);
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
