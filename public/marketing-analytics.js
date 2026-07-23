(() => {
  const nav = navigator;
  if (nav.doNotTrack === '1' || nav.globalPrivacyControl === true) return;
  const visitorKey = 'trevra.marketing.visitor';
  const attributionKey = 'trevra.marketing.attribution';
  let visitorId;
  let attribution;
  try {
    visitorId = sessionStorage.getItem(visitorKey) || crypto.randomUUID();
    sessionStorage.setItem(visitorKey, visitorId);
    const stored = sessionStorage.getItem(attributionKey);
    if (stored) attribution = JSON.parse(stored);
    else {
      const params = new URLSearchParams(location.search);
      let referrerSource;
      try {
        const hostname = document.referrer ? new URL(document.referrer).hostname : '';
        if (hostname && hostname !== location.hostname) referrerSource = hostname;
      } catch {}
      const source = params.get('utm_source') || referrerSource || 'direct';
      attribution = {
        source,
        medium: params.get('utm_medium') || (source === 'direct' ? 'none' : 'referral'),
        campaign: params.get('utm_campaign') || undefined,
        content: params.get('utm_content') || undefined,
        term: params.get('utm_term') || undefined,
        referrer: document.referrer || undefined
      };
      sessionStorage.setItem(attributionKey, JSON.stringify(attribution));
    }
  } catch {
    visitorId = crypto.randomUUID();
    attribution = { source: 'direct', medium: 'none' };
  }
  const body = JSON.stringify({ eventName: 'page_view', visitorId, path: location.pathname, ...attribution });
  if (navigator.sendBeacon && navigator.sendBeacon('/api/marketing/events', new Blob([body], { type: 'application/json' }))) return;
  fetch('/api/marketing/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
})();
