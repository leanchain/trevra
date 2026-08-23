import {
  SELECTORS,
  normalisedProfileUrl,
  profileUrlFor,
  type LinkedInDriverResult,
  type LinkedInFailureKind,
  type LinkedInLocator,
  type LinkedInPage
} from './driver.js';
import { hoverClick, settle } from './human.js';

const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;
const LINKEDIN_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

export const COMMUNITY_SELECTORS = {
  companyFollow:
    'main button[aria-label^="Follow"]:not([aria-label^="Following"]), main button:has-text("Follow")',
  companyFollowing:
    'main button[aria-label^="Following"], main button[aria-label^="Unfollow"], main button:has-text("Following")',
  companyPost:
    'main div.feed-shared-update-v2, main article[data-urn*="activity"], main div[data-urn*="activity"]',
  companyLike:
    'main div.feed-shared-update-v2 >> nth=0 >> button[aria-label^="React Like"], main article[data-urn*="activity"] >> nth=0 >> button[aria-label^="React Like"]',
  companyLiked:
    'main div.feed-shared-update-v2 >> nth=0 >> button[aria-label^="Unreact Like"], main article[data-urn*="activity"] >> nth=0 >> button[aria-label^="Unreact Like"]',
  companyInviteConnections:
    'main button[aria-label*="Invite connections" i], main button:has-text("Invite connections")',
  eventInvite: 'main button[aria-label*="Invite" i], main button:has-text("Invite")',
  groupInvite: 'main button[aria-label*="Invite" i], main button:has-text("Invite")',
  dialog: 'div[role="dialog"], div.artdeco-modal[role="dialog"]',
  modalSend:
    'div[role="dialog"] button[aria-label^="Send"], div[role="dialog"] button:has-text("Send invitation"), div[role="dialog"] button:has-text("Invite")',
  inviteSuccess:
    '[role="status"]:has-text("sent"), .artdeco-toast-item:has-text("sent"), text=/invitation sent|invite sent/i',
  memberMessageComposer:
    'div[role="dialog"] div.msg-form__contenteditable[contenteditable="true"], div[role="dialog"] div[contenteditable="true"][role="textbox"]',
  memberMessageSend:
    'div[role="dialog"] button.msg-form__send-button, div[role="dialog"] button[type="submit"]:has-text("Send")',
  messageSuccess: '[role="status"]:has-text("sent"), .artdeco-toast-item:has-text("sent")'
} as const;

type DestinationKind = 'company' | 'event' | 'group';

function fail(failureKind: LinkedInFailureKind, detail: string): LinkedInDriverResult {
  return { ok: false, failureKind, detail };
}

async function present(page: LinkedInPage, selector: string): Promise<boolean> {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

async function detectWall(page: LinkedInPage): Promise<LinkedInFailureKind | null> {
  try {
    if (/\/(checkpoint|uas\/login)\//i.test(page.url())) return 'challenge';
    if (await present(page, SELECTORS.challengeForm)) return 'challenge';
    if (await present(page, SELECTORS.limitWall)) return 'limit_wall';
    if (await present(page, SELECTORS.restrictionNotice)) return 'limit_wall';
    return null;
  } catch {
    return null;
  }
}

function canonicalProfile(target: string): string | null {
  const profile = profileUrlFor(target);
  return profile ? normalisedProfileUrl(profile) : null;
}

export function communityDestinationUrl(kind: DestinationKind, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !LINKEDIN_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password) return null;
  const rules: Record<DestinationKind, RegExp> = {
    company: /^\/company\/[^/?#]+\/?/i,
    event: /^\/events\/[^/?#]+\/?/i,
    group: /^\/groups\/[^/?#]+\/?/i
  };
  if (!rules[kind].test(url.pathname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const base = `/${parts[0]}/${parts[1]}/`;
  url.pathname = base;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function openAt(
  page: LinkedInPage,
  url: string,
  seed: string
): Promise<LinkedInDriverResult | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await settle(page, `${seed}#open`);
  } catch (cause) {
    return fail(
      'selector_drift',
      `Could not open ${url}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  const wall = await detectWall(page);
  return wall
    ? fail(
        wall,
        `LinkedIn returned a ${wall === 'challenge' ? 'challenge' : 'limit wall'} while opening ${url}.`
      )
    : null;
}

function profileSlug(profile: string): string {
  return profile.split('/in/')[1]?.split('/')[0] ?? '';
}

function targetSelector(profile: string, suffix = ''): string {
  const slug = profileSlug(profile).replace(/[^A-Za-z0-9._~-]/g, '');
  return `a[href*="/in/${slug}"]${suffix}`;
}

function rowActionSelector(profile: string, actionText: string, scope = ''): string {
  const slug = profileSlug(profile).replace(/[^A-Za-z0-9._~-]/g, '');
  const prefix = scope ? `${scope} ` : '';
  return `${prefix}li:has(a[href*="/in/${slug}"]) button:has-text("${actionText}"), ${prefix}div:has(> a[href*="/in/${slug}"]) button:has-text("${actionText}")`;
}

async function clickAndConfirmState(
  page: LinkedInPage,
  control: LinkedInLocator,
  afterSelector: string,
  seed: string,
  detail: string
): Promise<LinkedInDriverResult> {
  try {
    await hoverClick(page, control.first(), `${seed}#click`, CLICK_TIMEOUT_MS);
    await settle(page, `${seed}#after-click`);
  } catch (cause) {
    return fail(
      'unknown',
      `${detail} was interrupted after the click: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }
  const wall = await detectWall(page);
  if (wall)
    return fail(
      wall,
      `LinkedIn returned a ${wall === 'challenge' ? 'challenge' : 'limit wall'} after ${detail}.`
    );
  if (await present(page, afterSelector))
    return { ok: true, failureKind: null, externalRef: page.url() };
  return fail('unknown', `${detail} could not be verified after the click.`);
}

export async function followCompany(
  page: LinkedInPage,
  companyUrl: string,
  options: { seed?: string } = {}
): Promise<LinkedInDriverResult> {
  const url = communityDestinationUrl('company', companyUrl);
  if (!url)
    return fail('not_found', 'The configured company destination is not a LinkedIn company URL.');
  const seed = options.seed ?? url;
  const opened = await openAt(page, url, seed);
  if (opened) return opened;
  if (await present(page, COMMUNITY_SELECTORS.companyFollowing))
    return fail('already_connected', `This seat already follows ${url}; there is nothing to do.`);
  const control = page.locator(COMMUNITY_SELECTORS.companyFollow);
  if ((await control.count()) === 0)
    return fail('not_found', `LinkedIn exposes no Follow-company control on ${url} for this seat.`);
  return clickAndConfirmState(
    page,
    control,
    COMMUNITY_SELECTORS.companyFollowing,
    seed,
    `following ${url}`
  );
}

export async function likeCompanyRecentPost(
  page: LinkedInPage,
  companyUrl: string,
  options: { seed?: string } = {}
): Promise<LinkedInDriverResult> {
  const root = communityDestinationUrl('company', companyUrl);
  if (!root)
    return fail('not_found', 'The configured company destination is not a LinkedIn company URL.');
  const url = `${root}posts/?feedView=all`;
  const seed = options.seed ?? url;
  const opened = await openAt(page, url, seed);
  if (opened) return opened;
  if (await present(page, COMMUNITY_SELECTORS.companyLiked))
    return fail(
      'already_connected',
      `The most recent visible company post on ${root} is already liked by this seat.`
    );
  if (!(await present(page, COMMUNITY_SELECTORS.companyPost)))
    return fail('not_found', `No visible company post is available to like on ${root}.`);
  const control = page.locator(COMMUNITY_SELECTORS.companyLike);
  if ((await control.count()) === 0)
    return fail(
      'selector_drift',
      `A company post is visible on ${root}, but its Like control is not readable. Nothing was clicked.`
    );
  return clickAndConfirmState(
    page,
    control,
    COMMUNITY_SELECTORS.companyLiked,
    seed,
    `liking the latest post on ${root}`
  );
}

async function inviteConnection(
  page: LinkedInPage,
  target: string,
  destinationKind: DestinationKind,
  destinationUrl: string,
  entrySelector: string,
  label: string,
  seed: string
): Promise<LinkedInDriverResult> {
  const profile = canonicalProfile(target);
  const destination = communityDestinationUrl(destinationKind, destinationUrl);
  if (!profile)
    return fail('not_found', 'The campaign member has no canonical LinkedIn profile URL.');
  if (!destination)
    return fail(
      'not_found',
      `The configured ${label} destination is not a valid LinkedIn ${destinationKind} URL.`
    );
  const opened = await openAt(page, destination, seed);
  if (opened) return opened;
  const entry = page.locator(entrySelector);
  if ((await entry.count()) === 0)
    return fail(
      'not_found',
      `This seat is not eligible to invite connections from ${destination}; LinkedIn exposes no ${label} invite control.`
    );
  try {
    await hoverClick(page, entry.first(), `${seed}#open-invite`, CLICK_TIMEOUT_MS);
    await settle(page, `${seed}#invite-dialog`);
  } catch (cause) {
    return fail(
      'selector_drift',
      `The ${label} invite surface on ${destination} could not be opened: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }
  const wall = await detectWall(page);
  if (wall)
    return fail(
      wall,
      `LinkedIn returned a ${wall === 'challenge' ? 'challenge' : 'limit wall'} while opening the ${label} invite surface.`
    );
  if (!(await present(page, COMMUNITY_SELECTORS.dialog)))
    return fail(
      'selector_drift',
      `The ${label} invite control was clicked but no invite dialog appeared; nothing was selected.`
    );

  const targetLink = targetSelector(profile);
  if (!(await present(page, `div[role="dialog"] ${targetLink}`)))
    return fail('not_found', `${profile} is not eligible in the visible ${label} invite list.`);
  const checkbox = page.locator(
    `div[role="dialog"] li:has(${targetLink}) input[type="checkbox"], div[role="dialog"] li:has(${targetLink}) label, div[role="dialog"] div:has(${targetLink}) input[type="checkbox"]`
  );
  if ((await checkbox.count()) === 0)
    return fail(
      'selector_drift',
      `The ${label} invite dialog contains ${profile}, but no selectable control for that row. Nothing was clicked.`
    );
  try {
    await hoverClick(page, checkbox.first(), `${seed}#select-target`, CLICK_TIMEOUT_MS);
    await settle(page, `${seed}#selected`);
    const send = page.locator(COMMUNITY_SELECTORS.modalSend);
    if ((await send.count()) === 0)
      return fail(
        'selector_drift',
        `The ${label} invite dialog has no send control after selecting ${profile}. No invitation was sent.`
      );
    await hoverClick(page, send.first(), `${seed}#send`, CLICK_TIMEOUT_MS);
    await settle(page, `${seed}#after-send`);
  } catch (cause) {
    return fail(
      'unknown',
      `The ${label} invitation to ${profile} was interrupted after a selection/click: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }
  const after = await detectWall(page);
  if (after)
    return fail(
      after,
      `LinkedIn returned a ${after === 'challenge' ? 'challenge' : 'limit wall'} after the ${label} invite was submitted.`
    );
  if (
    (await present(page, COMMUNITY_SELECTORS.inviteSuccess)) ||
    !(await present(page, `div[role="dialog"] ${targetLink}`))
  )
    return {
      ok: true,
      failureKind: null,
      externalRef: destination,
      metadata: { targetProfile: profile }
    };
  return fail(
    'unknown',
    `LinkedIn did not confirm whether the ${label} invitation to ${profile} was sent.`
  );
}

export function inviteConnectionToFollowCompany(
  page: LinkedInPage,
  target: string,
  companyUrl: string,
  options: { seed?: string } = {}
): Promise<LinkedInDriverResult> {
  return inviteConnection(
    page,
    target,
    'company',
    companyUrl,
    COMMUNITY_SELECTORS.companyInviteConnections,
    'company-follow',
    options.seed ?? `${target}:${companyUrl}:company-invite`
  );
}

export function inviteConnectionToEvent(
  page: LinkedInPage,
  target: string,
  eventUrl: string,
  options: { seed?: string } = {}
): Promise<LinkedInDriverResult> {
  return inviteConnection(
    page,
    target,
    'event',
    eventUrl,
    COMMUNITY_SELECTORS.eventInvite,
    'event',
    options.seed ?? `${target}:${eventUrl}:event-invite`
  );
}

export function inviteConnectionToGroup(
  page: LinkedInPage,
  target: string,
  groupUrl: string,
  options: { seed?: string } = {}
): Promise<LinkedInDriverResult> {
  return inviteConnection(
    page,
    target,
    'group',
    groupUrl,
    COMMUNITY_SELECTORS.groupInvite,
    'group',
    options.seed ?? `${target}:${groupUrl}:group-invite`
  );
}

async function messageMemberFromCommunity(
  page: LinkedInPage,
  target: string,
  destinationKind: 'event' | 'group',
  destinationUrl: string,
  body: string,
  label: string,
  seed: string
): Promise<LinkedInDriverResult> {
  const profile = canonicalProfile(target);
  const destination = communityDestinationUrl(destinationKind, destinationUrl);
  if (!profile)
    return fail('not_found', 'The campaign member has no canonical LinkedIn profile URL.');
  if (!destination)
    return fail(
      'not_found',
      `The configured ${label} destination is not a valid LinkedIn ${destinationKind} URL.`
    );
  if (!body.trim()) return fail('not_found', `The ${label} message has no approved body.`);
  const opened = await openAt(page, destination, seed);
  if (opened) return opened;
  if (!(await present(page, targetSelector(profile))))
    return fail(
      'not_found',
      `${profile} is not visible as a ${label} member/attendee on ${destination}.`
    );
  const action = page.locator(rowActionSelector(profile, 'Message'));
  if ((await action.count()) === 0)
    return fail(
      'not_found',
      `LinkedIn exposes no Message control for ${profile} on the ${label} surface; Trevra will not fall back to a profile DM.`
    );
  try {
    await hoverClick(page, action.first(), `${seed}#message`, CLICK_TIMEOUT_MS);
    await settle(page, `${seed}#composer`);
  } catch (cause) {
    return fail(
      'selector_drift',
      `The ${label} Message control could not open its composer: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }
  const composer = page.locator(COMMUNITY_SELECTORS.memberMessageComposer);
  const send = page.locator(COMMUNITY_SELECTORS.memberMessageSend);
  if ((await composer.count()) === 0 || (await send.count()) === 0)
    return fail('selector_drift', `The ${label} message composer is incomplete. Nothing was sent.`);
  try {
    await composer.first().fill(body, { timeout: CLICK_TIMEOUT_MS });
    await hoverClick(page, send.first(), `${seed}#send`, CLICK_TIMEOUT_MS);
    await settle(page, `${seed}#after-send`);
  } catch (cause) {
    return fail(
      'unknown',
      `The ${label} message to ${profile} was interrupted after the composer was used: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }
  const after = await detectWall(page);
  if (after)
    return fail(
      after,
      `LinkedIn returned a ${after === 'challenge' ? 'challenge' : 'limit wall'} after the ${label} message send.`
    );
  if (
    (await present(page, COMMUNITY_SELECTORS.messageSuccess)) ||
    !(await present(page, COMMUNITY_SELECTORS.memberMessageComposer))
  )
    return {
      ok: true,
      failureKind: null,
      externalRef: destination,
      metadata: { targetProfile: profile }
    };
  return fail(
    'unknown',
    `LinkedIn did not confirm whether the ${label} message to ${profile} was sent.`
  );
}

export function messageGroupMember(
  page: LinkedInPage,
  target: string,
  groupUrl: string,
  body: string,
  options: { seed?: string } = {}
): Promise<LinkedInDriverResult> {
  return messageMemberFromCommunity(
    page,
    target,
    'group',
    groupUrl,
    body,
    'group-member',
    options.seed ?? `${target}:${groupUrl}:group-message`
  );
}

export function messageEventAttendee(
  page: LinkedInPage,
  target: string,
  eventUrl: string,
  body: string,
  options: { seed?: string } = {}
): Promise<LinkedInDriverResult> {
  return messageMemberFromCommunity(
    page,
    target,
    'event',
    eventUrl,
    body,
    'event-attendee',
    options.seed ?? `${target}:${eventUrl}:event-message`
  );
}
