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
  | 'action_executed';

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
