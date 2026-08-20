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
import type {
  LinkedInDriverResult,
  LinkedInFailureKind,
  LinkedInPage,
  LinkedInPostImageUpload
} from './driver.js';

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
  addMediaButton:
    'button[aria-label*="Add media" i], button[aria-label*="Photo" i], button[aria-label*="image" i]',
  imageInput: 'input[type="file"][accept*="image" i]',
  imagePreview:
    '.share-creation-state__preview img, .share-media__preview img, img[alt*="preview" i]',
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
export async function publishPost(
  page: LinkedInPage,
  body: string,
  options: { images?: LinkedInPostImageUpload[] } = {}
): Promise<LinkedInDriverResult> {
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
        'unknown',
        `${POST_SELECTORS.postComposeBox} did not match after opening the composer; a draft may be open. Check it by hand.`
      );
    }

    await typeLike(page, compose.first(), body, 'post#body', CLICK_TIMEOUT_MS);

    const images = options.images ?? [];
    if (images.length > 0) {
      let input = page.locator(POST_SELECTORS.imageInput);
      if ((await input.count()) === 0) {
        const addMedia = page.locator(POST_SELECTORS.addMediaButton);
        if ((await addMedia.count()) === 0) {
          return fail(
            'unknown',
            'The post draft is open, but LinkedIn exposed no image control. Nothing was published; inspect or discard the open draft.'
          );
        }
        await hoverClick(page, addMedia.first(), 'post#add-media', CLICK_TIMEOUT_MS);
        await settle(page, 'post#media-picker');
        input = page.locator(POST_SELECTORS.imageInput);
      }
      const upload = input.first();
      if ((await input.count()) === 0 || !upload.setInputFiles) {
        return fail(
          'unknown',
          'The post draft is open, but LinkedIn exposed no usable image file input. Nothing was published; inspect or discard the open draft.'
        );
      }
      // Playwright accepts an array for a `multiple` file input. The structural
      // locator type stays single-file because every pre-existing DM/InMail fake
      // implements that smaller surface; this post-specific cast widens only the
      // call that actually needs LinkedIn's multi-image picker.
      await (
        upload.setInputFiles as unknown as (files: LinkedInPostImageUpload[]) => Promise<void>
      )(images);
      await settle(page, 'post#images-uploaded');
      if ((await page.locator(POST_SELECTORS.imagePreview).count()) === 0) {
        return fail(
          'unknown',
          'LinkedIn accepted the image files but no verifiable image preview appeared. Nothing was published; inspect or discard the open draft.'
        );
      }
    }

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
