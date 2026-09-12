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
- detects repeated/ignored pagination and marks the catalog capped instead of looping or pretending the sample is complete;
- returns homepage HTML to Trevra's ecommerce-app detector so app install/removal signals come from the same independent crawl.

An imported platform tag is only a weak prior. Live endpoint evidence wins. The crawler therefore operates on any Trevra account independently of how that account was sourced.

### Production crawl contract

`PublicWebCrawler` is intentionally stricter than the older one-off `probe()` helper. Scheduled crawling has a different operational burden from a single user-triggered audit.

- Every real request counts toward the domain budget, including retries and redirect hops.
- Redirects remain HTTPS and inside the requested host or canonical `www` variant; an arbitrary public redirect is not treated as permission to crawl another site.
- A missing/gone robots resource (`404`/`410`) means no declared restriction; operational failures and other denial/rate-limit statuses such as `401`, `403`, `429`, or `5xx` fail closed for scheduled crawling rather than silently assuming permission.
- A normal robots `4xx` means no declared restriction; an operational robots failure, `429`, or `5xx` fails closed for scheduled crawling rather than silently assuming permission.
- `Crawl-delay` is honored. Trevra also applies a 250 ms courtesy delay when no delay is declared.
- Robots policy is cached for one hour in production, bounded to 1,024 domains per process.
- A decoded page body is capped at 8 MiB and robots.txt at 512 KiB. Oversized content is a failed read, never a truncated document passed off as complete evidence.
- Transient `429`/`5xx` responses and transport failures are retried at most twice. `Retry-After` is honored when it fits inside the crawl deadline.
- One crawl session has a 20-second wall-clock deadline so a slow domain cannot consume an automation lane indefinitely.
- One session is internally serialized, so future observers can request pages concurrently without racing the shared budget, robots state, or pacing state.

The account watcher reserves part of its page budget for hiring/pricing rather than letting a large catalog starve non-commerce observation. Catalog enumeration is separately capped by product count and request count. When Trevra cannot prove it saw the complete catalog, `productCapped=true`; downstream copy must never turn that into an exact catalog-size claim.

Each scheduled sweep emits crawl telemetry to the existing sweep logger: request budget consumption, bytes read, retries, robots state and effective crawl delay. A provider or crawler failure remains operational degradation and does not become a synthetic "nothing changed" observation.

## Deployment-owned HTTP observation providers

Use `TREVRA_OBSERVATION_HTTP_PROVIDERS_JSON` for collectors that should live outside the Trevra process: Meta Ad Library acquisition, Instagram/TikTok telemetry, newsletter monitoring, or another specialized acquisition service.

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

The provider returns already-observed changes:

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

Trevra accepts only known signal kinds with a valid HTTP(S) evidence URL and a parseable observation time. Provider timestamps more than one hour in the future are rejected so clock errors cannot manufacture recency points.

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
