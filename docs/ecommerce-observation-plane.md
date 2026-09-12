# Ecommerce observation plane

Trevra's ecommerce observation plane turns dated changes around a store into the same evidence-backed `account_signals` used by the rest of the GTM account spine. The acquisition method is deliberately replaceable; the evidence, dedupe, recency decay, and composite scoring rules are Trevra's.

## What is observed

Native account sweeps now cover:

- hiring/careers changes;
- pricing and homepage changes;
- generic site technology changes;
- Shopify and WooCommerce public product catalogs;
- ecommerce app installs/removals visible in storefront markup, including Klaviyo, Mailchimp, Omnisend, Brevo, Attentive, Recharge, Gorgias, Yotpo and Judge.me.

The scorer also has first-class signal kinds for externally acquired observations:

- `meta-ads-started`
- `meta-ads-rising`
- `newsletter-started`
- `newsletter-silent`
- `social-growth`
- `social-cadence-up`
- `storefront-rebuild`

Every external event must carry a public evidence URL and an observation timestamp. Unknown signal kinds do not score. A provider failure is reported as degraded acquisition; it is never converted into "nothing happened."

## Trevra-owned storefront crawler

Storefront crawling runs directly inside Trevra. It does not mount or consume another product's crawl corpus and does not depend on another crawler schedule.

The reusable acquisition boundary is `src/server/crawl/public-web.ts`: one bounded, robots-aware, SSRF-safe crawl session per domain. `src/server/storefront/crawler.ts` is one consumer of that crawler and adds commerce-specific platform/product interpretation. Hiring, pricing and site-change checks share the same session, and future Trevra observers can reuse it without depending on ecommerce code.

Today it:

- fetches the live homepage under Trevra's SSRF and request-budget guards;
- fingerprints Shopify, WooCommerce, WordPress, Magento, Wix, Shopware, BigCommerce, PrestaShop and Webflow;
- probes only the public Shopify/WooCommerce catalog APIs that can contribute product evidence, so generic sites do not pay for an unrelated WordPress REST probe;
- captures bounded, paginated Shopify and WooCommerce public catalogs for product-launch diffs;
- falls back to public product sitemaps for other storefronts: explicit product/catalog sitemap children are trusted as product inventories, while generic sitemaps accept only clear product URL paths;
- detects repeated/ignored pagination and incomplete sitemap coverage and marks the catalog capped instead of looping or pretending the sample is complete;
- returns homepage HTML to Trevra's ecommerce-app detector so app install/removal signals come from the same independent crawl;
- emits `storefront-rebuild` only when two consecutive live captures show a migration between recognized commerce platforms at >=0.8 confidence on both sides; low-confidence/generic-site changes do not qualify;
- records first-party newsletter signup surfaces and social-profile links as weak presence signals, without pretending presence means activity or growth;
- follows at most one same-origin newsletter page and records a company-published Substack publication target when present.

An imported platform tag is only a weak prior. Live endpoint evidence wins. The crawler therefore operates on any Trevra account independently of how that account was sourced.

### Production crawl contract

`PublicWebCrawler` is intentionally stricter than the older one-off `probe()` helper. Scheduled crawling has a different operational burden from a single user-triggered audit.

- Every real request counts toward the domain budget, including retries and redirect hops.
- Redirects remain HTTPS and inside the requested host or canonical `www` variant; an arbitrary public redirect is not treated as permission to crawl another site.
- A missing/gone robots resource (`404`/`410`) means no declared restriction; operational failures and denial/rate-limit statuses such as `401`, `403`, `429`, or `5xx` fail closed for scheduled crawling rather than silently assuming permission.
- `Crawl-delay` is honored. Trevra also applies a 250 ms courtesy delay when no delay is declared.
- Robots policy is cached for one hour in production, bounded to 1,024 domains per process.
- A decoded page body is capped at 8 MiB and robots.txt at 512 KiB. Oversized content is a failed read, never a truncated document passed off as complete evidence.
- Transient `429`/`5xx` responses and transport failures are retried at most twice. `Retry-After` is honored when it fits inside the crawl deadline.
- One crawl session has a 20-second wall-clock deadline so a slow domain cannot consume an automation lane indefinitely.
- One session is internally serialized, so future observers can request pages concurrently without racing the shared budget, robots state, or pacing state.

The account watcher reserves part of its page budget for hiring/pricing rather than letting a large catalog starve non-commerce observation. Catalog enumeration is separately capped by product count and request count. When Trevra cannot prove it saw the complete catalog, `productCapped=true`; downstream copy must never turn that into an exact catalog-size claim.

Each scheduled sweep emits crawl telemetry to the existing sweep logger: request budget consumption, bytes read, retries, robots state and effective crawl delay. A provider or crawler failure remains operational degradation and does not become a synthetic "nothing changed" observation.

## Built-in measured external surfaces

Presence and activity are deliberately separate. `newsletter-signup-added` and `social-profile-added` are low-strength facts from the company's own site. `newsletter-started`, `newsletter-silent`, `social-growth` and `social-cadence-up` require comparable measurements over time.

Trevra owns the history and change semantics for these raw metrics:

- `meta.active_ads`
- `social.followers`
- `social.posts_30d`
- `newsletter.posts_30d`

The first measurement is a baseline only. Missing metrics mean **not measured**, never zero. Older/equal timestamps cannot roll a baseline backwards. Current thresholds are intentionally conservative: Meta ads must rise by at least 3 and 25% (or move from zero to nonzero), followers by at least 10 and 2%, and trailing-30-day posting cadence by at least 2 and 25%. Newsletter activity emits only on zero/nonzero transitions.

### Instagram Business Discovery

When the company publishes an Instagram profile on its own site and the deployment configures Meta's Instagram Business Discovery API, Trevra measures the public Professional account's follower count and, when the bounded media result is complete enough to prove it, public posts in the trailing 30 days.

Configure both:

- `TREVRA_META_GRAPH_ACCESS_TOKEN`
- `TREVRA_INSTAGRAM_BUSINESS_ACCOUNT_ID`

Optional: `TREVRA_META_GRAPH_VERSION` (defaults to `v26.0`; malformed values are rejected). A personal/non-Professional target or an incomplete 30-day media page produces a warning and no fabricated measurement.

### Meta Ad Library

Meta commercial-ad observation is built in, but identity is never guessed. Add a verified Facebook Page id to an account as `meta-page-id:<numeric-page-id>`, then configure both `TREVRA_META_AD_LIBRARY_ACCESS_TOKEN` and `TREVRA_META_AD_LIBRARY_COUNTRIES_JSON` (for example `["DE","FR","GB"]`). The reached-country list is restricted to EU member states and GB because Meta's `ad_type=ALL` commercial-ad API coverage is that surface; Trevra does not present the resulting number as a global active-ad count.

For each verified Page id Trevra queries `ads_archive` with `ad_type=ALL`, `ad_active_status=ACTIVE`, exact `search_page_ids`, and the configured reached countries. Pagination is reconstructed from cursors rather than following Meta's returned `paging.next` URL, so bearer credentials never become a provider-controlled navigation target. Duplicate snapshots are deduped, Page-id mismatches fail closed, and counts above the bounded 1,000-ad window are left unmeasured rather than rounded or truncated. The first exact count is only a baseline; later zero-to-nonzero/rising changes become `meta-ads-started`/`meta-ads-rising` through the shared measurement interpreter.

A brand name, Facebook vanity URL, or site-domain similarity is not enough identity to run this collector. Until a Page id is verified, Meta ads remain unmeasured for that account.

### Substack public feed

A company-published `*.substack.com` publication is measured through its public `/feed`. This needs no credential. Trevra emits `newsletter.posts_30d` only when an item older than 30 days proves the returned feed covers the whole measurement window. An all-recent feed may be truncated and is therefore left unmeasured.

### YouTube Data API

When the company publishes a canonical YouTube `/channel/UC…` link and `TREVRA_YOUTUBE_API_KEY` is configured, Trevra resolves the channel's official uploads playlist through `channels.list`, measures public subscriber count when YouTube exposes it, and counts public uploads in the trailing 30 days through `playlistItems.list`. The collector paginates at most three 50-item pages; if more than 150 uploads still fit inside the 30-day window, cadence remains unmeasured rather than becoming a false exact count. Trevra does not guess a channel ID from an `@handle` URL.

The earlier no-credential Atom-feed approach is intentionally not used: live qualification showed YouTube's current robots policy blocks that feed path for Trevra's crawler. The Data API is the supported acquisition path.

## Deployment-owned HTTP observation providers

Use `TREVRA_OBSERVATION_HTTP_PROVIDERS_JSON` for collectors that should live outside the Trevra process: additional ad-intelligence vendors, TikTok telemetry, newsletter monitoring, or another specialized acquisition service.

Example:

```json
[
  {
    "key": "commerce-observer",
    "name": "Commerce observations",
    "endpoint": "https://observer.example.com/observe",
    "tokenEnv": "COMMERCE_OBSERVER_TOKEN",
    "surfaces": ["meta_ads", "newsletter", "social"]
  }
]
```

A token-bearing endpoint must use HTTPS. The endpoint and token environment-variable name belong to the deployment; a workspace cannot supply either one.

### Request

Trevra sends:

```json
{
  "domain": "shop.example",
  "surfaces": ["meta_ads", "newsletter", "social"]
}
```

### Response

The provider may return either already-interpreted changes (kept for backward compatibility) or raw measurements. Raw measurements are preferred because Trevra owns the historical baseline and thresholds centrally.

Interpreted response example:

```json
{
  "observations": [
    {
      "kind": "meta-ads-rising",
      "detail": "Active Meta ads rose from 7 to 12.",
      "previous": 7,
      "current": 12,
      "evidenceUrl": "https://www.facebook.com/ads/library/...",
      "observedAt": "2026-09-12T07:45:00Z"
    }
  ],
  "warnings": []
}
```

Raw measurement example:

```json
{
  "measurements": [
    {
      "metric": "social.followers",
      "scope": "instagram:shop",
      "value": 4200,
      "evidenceUrl": "https://www.instagram.com/shop/",
      "observedAt": "2026-09-12T07:45:00Z"
    }
  ]
}
```

Trevra accepts only known signal/metric kinds with a valid HTTP(S) evidence URL and a parseable observation time. Provider timestamps more than one hour in the future are rejected so clock errors cannot manufacture recency points.

The generic seam remains useful for Meta coverage outside the built-in strict Page-id/EU+UK contract or for a sanctioned third-party data source. Whatever the source, raw `meta.active_ads` measurements still use Trevra's central baseline and scoring semantics.

## Composite scoring

A single trigger is still never enough for a hot account. Ecommerce observations use the existing scorer rules: exponential recency decay, repeat tapering, a one-kind score cap, and positive bonuses only when distinct kinds corroborate each other.

Named ecommerce combinations include:

- rising Meta ads + product launch;
- Meta ads starting + product launch;
- product launch + ecommerce app install;
- rising Meta ads + social growth;
- ecommerce app install + newsletter activation;
- product launch + social growth;
- storefront rebuild + ecommerce app install.

This keeps the product thesis intact: a product appearing is a fact; a product launch, paid acquisition ramp and new retention stack in the same window is intent.
