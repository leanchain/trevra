import { extractLinks, socialProfile } from '../skills/html.js';

export interface NewsletterSignupSurface {
  /** Page on the company's own site where the signup surface was observed. */
  sourceUrl: string;
  /** Provider only when the page publishes a recognizable integration marker. */
  provider: string | null;
  /** Stable diff key. Never includes volatile markup. */
  key: string;
}

export interface PublishedSocialProfile {
  platform: string;
  handle: string;
  url: string;
}

export interface NewsletterPublicationTarget {
  platform: 'substack';
  url: string;
  feedUrl: string;
}

export interface SiteSurfaces {
  newsletterSignups: NewsletterSignupSurface[];
  newsletterPublications: NewsletterPublicationTarget[];
  socialProfiles: PublishedSocialProfile[];
}

const NEWSLETTER_WORDS =
  /\b(newsletter|subscribe|subscription|email updates?|join (?:our )?(?:list|community)|mailing list|stay (?:in )?touch|updates? by email)\b/i;
const EMAIL_INPUT =
  /<input\b[^>]*(?:type\s*=\s*["']?email\b|name\s*=\s*["'][^"']*email[^"']*["']|autocomplete\s*=\s*["']email["'])[^>]*>/i;
const FORM_RE = /<form\b[^>]*>[\s\S]*?<\/form>/gi;

const PROVIDER_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/klaviyo|kmail-lists\.com/i, 'klaviyo'],
  [/list-manage\.com|mailchimp/i, 'mailchimp'],
  [/omnisend/i, 'omnisend'],
  [/sibforms\.com|sendinblue|brevo/i, 'brevo'],
  [/attn\.tv|attentive/i, 'attentive'],
  [/beehiiv/i, 'beehiiv'],
  [/substack/i, 'substack'],
  [/convertkit|kit\.com/i, 'kit']
];

const SOCIAL_PLATFORMS = new Set([
  'instagram',
  'tiktok',
  'youtube',
  'facebook',
  'x',
  'twitter',
  'threads',
  'linkedin',
  'bluesky'
]);

function providerFor(markup: string): string | null {
  return PROVIDER_MARKERS.find(([pattern]) => pattern.test(markup))?.[1] ?? null;
}

function normalizeOwnPageUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  return url.toString();
}

/**
 * Read first-party newsletter signup surfaces and published social profiles
 * from one already-fetched page. This function never follows links and never
 * infers activity from presence: a form is a form, a profile link is a link.
 */
export function discoverSiteSurfaces(html: string, pageUrl: string): SiteSurfaces {
  const sourceUrl = normalizeOwnPageUrl(pageUrl);
  const newsletterSignups: NewsletterSignupSurface[] = [];
  const seenNewsletter = new Set<string>();

  for (const match of html.matchAll(FORM_RE)) {
    const form = match[0] ?? '';
    if (!EMAIL_INPUT.test(form) || !NEWSLETTER_WORDS.test(form.replace(/<[^>]+>/g, ' '))) continue;
    const provider = providerFor(form) ?? providerFor(html);
    const key = `${provider ?? 'first-party'}@${sourceUrl}`;
    if (seenNewsletter.has(key)) continue;
    seenNewsletter.add(key);
    newsletterSignups.push({ sourceUrl, provider, key });
  }

  // Some providers render the real <form> client-side. A page that explicitly
  // says newsletter/subscribe and publishes a recognized embed marker is still
  // checkable evidence of a signup surface, but provider script presence alone
  // is deliberately insufficient.
  if (newsletterSignups.length === 0 && NEWSLETTER_WORDS.test(html.replace(/<[^>]+>/g, ' '))) {
    const provider = providerFor(html);
    if (provider) newsletterSignups.push({ sourceUrl, provider, key: `${provider}@${sourceUrl}` });
  }

  const profiles = new Map<string, PublishedSocialProfile>();
  const publications = new Map<string, NewsletterPublicationTarget>();
  for (const link of extractLinks(html)) {
    try {
      const linked = new URL(link.href, sourceUrl);
      const host = linked.hostname.toLowerCase();
      if (host.endsWith('.substack.com') && host !== 'substack.com') {
        const origin = linked.origin;
        publications.set(origin, {
          platform: 'substack',
          url: origin,
          feedUrl: `${origin}/feed`
        });
      }
    } catch {
      // The shared link parser already tolerates malformed hrefs. A malformed
      // newsletter target is simply not a target.
    }
    const profile = socialProfile(link.href, sourceUrl);
    if (!profile || !SOCIAL_PLATFORMS.has(profile.platform)) continue;
    const key = `${profile.platform}:${profile.handle.toLowerCase()}`;
    if (!profiles.has(key)) profiles.set(key, profile);
  }

  return {
    newsletterSignups: newsletterSignups.sort((a, b) => a.key.localeCompare(b.key)),
    newsletterPublications: [...publications.values()].sort((a, b) => a.url.localeCompare(b.url)),
    socialProfiles: [...profiles.values()].sort((a, b) =>
      `${a.platform}:${a.handle.toLowerCase()}`.localeCompare(
        `${b.platform}:${b.handle.toLowerCase()}`
      )
    )
  };
}

export const NEWSLETTER_LINK_RE = /\b(newsletter|subscribe|email updates?|mailing list)\b/i;
