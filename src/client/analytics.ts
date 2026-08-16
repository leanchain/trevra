/* =====================================================================
 * Rates, before anything is tracked.
 *
 * A LEAF MODULE ON PURPOSE: this file imports nothing, so the rule below can
 * be read, tested and reused without dragging a screen -- and every outreach
 * tile that prints a percentage reuses it. When the rule lived inside the
 * funnel screen, `LinkedInManagerRead` had its own copy that took a
 * pre-divided rate, so the same empty ledger read "—" on one screen and "0%"
 * on another.
 * ================================================================== */

/**
 * How many observations a percentage needs before it is a measurement.
 *
 * 3 accepted of 4 is not 75% acceptance, it is four invites. Printing the
 * percentage anyway is how a screen turns a coin toss into a trend somebody
 * re-targets a campaign over -- and the empty case is worse, because 0 of 0
 * renders as "0%", which reads as total failure rather than as silence.
 */
export const RATE_MIN_SAMPLE = 10;

/** Said in words wherever a denominator is too small to divide by. */
export const NOT_ENOUGH_DATA = 'not enough data';

/**
 * A percentage, or the reason there is not one.
 *
 * TAKES THE TWO COUNTS, NEVER A PRE-DIVIDED RATE, because the denominator is
 * the whole question: a rate arrives as `0.5` whether it was 1-of-2 or
 * 500-of-1000, and by then the caller cannot tell which.
 */
export function ratePercent(numerator: number, denominator: number, minSample: number = RATE_MIN_SAMPLE): string {
  if (!Number.isFinite(denominator) || denominator < Math.max(1, minSample)) return NOT_ENOUGH_DATA;
  return `${Math.round((numerator / denominator) * 100)}%`;
}

export type ClientMarketingEvent =
  | 'page_view'
  | 'signup_started'
  | 'email_signup_submitted'
  | 'google_auth_started'
  | 'signup_completed'
  | 'demo_started'
  | 'integration_connect_started'
  | 'document_imported'
  | 'marketplace_imported'
  | 'action_prepared'
  | 'action_approved'
  | 'action_executed'
  | 'marketing_primary_cta'
  | 'marketing_source_cta'
  | 'marketing_catalog_json'
  | 'marketing_self_host_cta'
  | 'marketing_founder_cta';

type EventProperties = Record<string, string | number | boolean | null | undefined>;

const VISITOR_KEY = 'trevra.marketing.visitor';
const ATTRIBUTION_KEY = 'trevra.marketing.attribution';

interface Attribution {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  referrer?: string;
}

export function trackPageView(): void {
  trackEvent('page_view');
}

export function trackEvent(eventName: ClientMarketingEvent, metadata: EventProperties = {}): void {
  if (privacySignalEnabled() || typeof window === 'undefined') return;
  const attribution = getAttribution();
  const payload = {
    eventName,
    visitorId: getVisitorId(),
    path: window.location.pathname,
    ...attribution,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined))
  };
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    const sent = navigator.sendBeacon('/api/marketing/events', new Blob([body], { type: 'application/json' }));
    if (sent) return;
  }
  void fetch('/api/marketing/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    credentials: 'omit',
    keepalive: true
  }).catch(() => undefined);
}

function privacySignalEnabled(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return navigator.doNotTrack === '1' || nav.globalPrivacyControl === true;
}

function getVisitorId(): string {
  try {
    const existing = sessionStorage.getItem(VISITOR_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(VISITOR_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function getAttribution(): Attribution {
  try {
    const stored = sessionStorage.getItem(ATTRIBUTION_KEY);
    if (stored) return JSON.parse(stored) as Attribution;
    const params = new URLSearchParams(window.location.search);
    const referrer = document.referrer || undefined;
    const source = params.get('utm_source') || referralSource(referrer) || 'direct';
    const attribution: Attribution = {
      source,
      medium: params.get('utm_medium') || (source === 'direct' ? 'none' : 'referral'),
      campaign: params.get('utm_campaign') || undefined,
      content: params.get('utm_content') || undefined,
      term: params.get('utm_term') || undefined,
      referrer
    };
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(attribution));
    return attribution;
  } catch {
    return { source: 'direct', medium: 'none' };
  }
}

function referralSource(referrer?: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const hostname = new URL(referrer).hostname;
    return hostname === window.location.hostname ? undefined : hostname;
  } catch {
    return undefined;
  }
}
