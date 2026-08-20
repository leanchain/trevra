# Company sourcing in Trevra

Trevra owns candidate-company ingestion, normalization, evidence, and the account ledger. It does **not** own the shape of the system a candidate came from.

The boundary is:

```text
file / paste / directory / provider
              |
              v
       candidate company
              |
       normalize + dedupe
              |
              v
           accounts
              |
   enrich -> score -> audit -> outreach
```

No downstream GTM code should need to know whether an account came from a CSV, a public directory, an internal intelligence service, or a future provider.

## Bring a list

`POST /api/accounts/import` and the account screen use one parser for all supported text formats:

- newline-separated domains;
- CSV with or without a header;
- JSON arrays of domain strings;
- JSON arrays of account objects;
- JSON envelopes containing `accounts` or `candidates` arrays.

The browser accepts `.csv`, `.json`, and `.txt` files up to 5 MB. A chosen or dropped file is read into the visible text area before import; Trevra does not silently turn a file into rows behind the operator's back.

The account screen also has **Choose folder**. Folder import is intentionally client-side: Trevra scans small JSON manifests locally, extracts only objects with a top-level `domain`, `website`, `url`, or `site`, deduplicates them, and places the compact account JSON in the same visible text area. Product/catalog artifacts beside those manifests are ignored and never uploaded.

This is the preferred migration path for an existing artifact tree such as `e-commerce/shops/`. In that tree, `shops/domains/<domain>/domain_summary.json` already carries a top-level `domain`, so selecting the whole `shops` folder is enough. Trevra does **not** need a Beseam candidates API and does not copy the `shops/` storage model into its core.

Examples:

```text
acme.com
https://www.example.org/pricing
```

```csv
company,website,tags
Acme,acme.com,saas
Example,https://example.org,eu
```

```json
{
  "candidates": [
    { "domain": "acme.com", "name": "Acme" },
    { "website": "https://example.org", "company": "Example" }
  ]
}
```

All formats converge on the same account identity rule: one public company domain per workspace. Re-importing the same domain is a no-op.

## Directory crawl provider

Built-in provider key: `directory`.

The request supplies public directory or listicle URLs:

```json
{
  "provider": "directory",
  "urls": ["https://example.com/companies", "https://example.org/directory"],
  "limit": 100
}
```

The provider:

- caps the number of source pages and candidates;
- validates every request and redirect through Trevra's SSRF guard;
- ignores links back to the source directory;
- ignores obvious social/platform hosts and `.gov`, `.edu`, `.mil` targets;
- structurally rejects private/raw-IP/localhost candidates;
- deduplicates by normalized domain;
- records the directory page as evidence/source provenance.

It contains no ecommerce- or shop-specific logic.

## Deployment-owned HTTP providers

An operator can register additional providers with `TREVRA_SOURCE_HTTP_PROVIDERS_JSON`. The configuration belongs to the **deployment**, not the workspace. A workspace can select a registered key but cannot choose an endpoint or an environment-variable name.

Example:

```json
[
  {
    "key": "internal-intel",
    "name": "Internal intelligence",
    "endpoint": "https://intel.example.com/candidates",
    "tokenEnv": "INTERNAL_SOURCE_TOKEN",
    "retention": "default"
  }
]
```

Set that JSON as `TREVRA_SOURCE_HTTP_PROVIDERS_JSON` and provide the named secret separately in the deployment environment.

This seam remains available for deployments that genuinely have a live external intelligence service. It is **not required for the e-commerce migration**: existing Beseam shop artifacts should move through folder upload instead of adding a candidates endpoint solely for Trevra.

### Request contract

Trevra sends `POST <endpoint>` with JSON:

```json
{
  "keywords": ["ai visibility"],
  "domains": [],
  "urls": [],
  "countries": ["Switzerland"],
  "vertical": "ecommerce",
  "limit": 100
}
```

When `tokenEnv` is configured, Trevra sends that secret as `Authorization: Bearer <token>`.

### Response contract

The adapter returns:

```json
{
  "candidates": [
    {
      "domain": "example.com",
      "name": "Example",
      "description": "Optional evidence summary",
      "sourceUrl": "https://source.example/evidence/123"
    }
  ],
  "warnings": []
}
```

`domain` or `url` may identify a candidate. Trevra normalizes, structurally validates, and deduplicates results before they leave the provider.

## Retention is enforced before persistence

Each provider declares `retention`:

- `default` — candidates may be persisted into `accounts`;
- `none` — candidates may be used in memory but Trevra must not store the result payload.

`POST /api/accounts/source` runs sourcing through `gtm.source-leads`, records the skill run, then checks retention **before** importing candidates. A memory-only provider cannot silently become persistent just because the account screen called it.

Exa remains `retention: none` under the current terms reading, so the account-source UI shows it but does not enable persistence.

## API surface

`GET /api/accounts/source-providers` lists registered providers, their availability, and retention mode without exposing credentials.

`POST /api/accounts/source` runs a provider through the skill ledger and, when retention permits, persists the returned candidates into `accounts` with `source = 'sourced'`.

The response includes the `runId`, provider key, candidate count, warnings, and the normal account-import result.

## Architectural rule

> Trevra owns prospects, evidence, and actions — not the system prospects were discovered in.

Do not add source-specific account tables or copy another product's fixture/storage hierarchy into Trevra core. Add a provider or import adapter that emits the generic candidate-company contract instead.
