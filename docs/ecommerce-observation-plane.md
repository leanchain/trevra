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

## Beseam shop-corpus adapter

Set `TREVRA_BESEAM_SHOP_CORPUS_DIR` to Beseam's `pipelines/shop-corpus/domains` directory when both repositories are mounted in the same deployment.

The adapter reads only existing crawl artifacts. It never starts the Beseam crawler itself. For each Trevra account it keeps a namespaced dated baseline in `research_snapshots` and compares later Beseam crawls against it.

Today it contributes:

- new products from `public_data/shopify_products.json` or `public_data/wc_store_products.json`;
- ecommerce-app changes recovered from the saved homepage HTML;
- a `storefront-rebuild` only when Beseam's previous and current platform classifications are both at least 0.8 confidence and disagree.

The first Beseam read is a baseline, not a signal. This prevents every product already present in the corpus from being mislabeled as a new launch.

## Deployment-owned HTTP observation providers

Use `TREVRA_OBSERVATION_HTTP_PROVIDERS_JSON` for collectors that should live outside the Trevra process: Meta Ad Library acquisition, Instagram/TikTok telemetry, newsletter monitoring, or a hosted Beseam observation service.

Example:

```json
[
  {
    "key": "beseam-live",
    "name": "Beseam live observations",
    "endpoint": "https://observer.example.com/observe",
    "tokenEnv": "BESEAM_OBSERVER_TOKEN",
    "surfaces": ["meta_ads", "newsletter", "social", "beseam"]
  }
]
```

A token-bearing endpoint must use HTTPS. The endpoint and token environment-variable name belong to the deployment; a workspace cannot supply either one.

### Request

Trevra sends:

```json
{
  "domain": "shop.example",
  "surfaces": ["meta_ads", "newsletter", "social", "beseam"]
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
