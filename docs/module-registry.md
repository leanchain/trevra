# Signed community module registry

Trevra’s hosted registry publishes typed modules together with privacy-safe popularity, publisher identity, release integrity, and installation state.

## Public popularity

Every successful or failed module execution updates aggregate counters:

- total runs;
- successful and failed runs;
- success rate;
- historical unique workspaces;
- active installations;
- first and latest run timestamps;
- popularity rank.

The public API never returns workspace IDs, workspace names, inputs, outputs, evidence, contacts, or customer records.

```text
GET /api/public/modules
GET /api/public/modules/:id
GET /api/public/module-popularity
```

The Cloudflare landing page reads this hosted API and merges live counters with its generated static fallback catalog. Set `CATALOG_API_URL` in GitHub Actions to the product API origin and set `PUBLIC_REGISTRY_CORS_ORIGIN` on the product runtime to the marketing origin.

## Publisher identities

Publishers register an Ed25519 public key. Trevra stores only the public key and SHA-256 fingerprint. Private signing keys remain on the publisher’s machine or hardware signing system.

Generate a key pair:

```bash
npm run module -- keygen ./publisher/trevra
```

Register the generated public key from **Modules → Publisher identity** or:

```text
POST /api/registry/publishers
```

## Signed releases

A community manifest declares:

- module ID and semantic version;
- OCI, WASI, or remote runtime;
- digest-pinned artifact;
- input and output JSON Schemas;
- side-effect class and approval requirement;
- network, secret, and filesystem permissions;
- timeout, CPU, memory, and output limits;
- source repository, commit, and license.

Trevra signs the canonical combination of the manifest and SBOM digest. Create the signature locally:

```bash
npm run module -- sign module.json sbom.json publisher.private.pem
```

Verify it before publishing:

```bash
npm run module -- verify module.json sbom.json publisher.public.pem '<base64-signature>'
```

Submit the manifest, SBOM, signature, and publisher ID in **Modules → Publish a signed release**. Trevra verifies the Ed25519 signature before creating an installable release.

## Installation and execution

A workspace installation pins one exact version. Installation does not grant external-write capability. Secret permissions must be granted explicitly in installation configuration, and external-write community modules remain blocked from the generic runner.

Community execution always goes through the sandbox boundary. Built-in and community runs write to the same skill ledger, policy system, event stream, MCP interface, and popularity counters.
