# Lead capture integration

Trevra lead capture is a workspace-scoped GTM ingress contract for landing pages, websites and signup backends. It creates/matches a **Person**, preserves an immutable **Inbound Submission**, and optionally links an explicitly supplied company domain to an Account. It does not execute outreach.

## 1. Create a Capture Source

In Trevra open **Setup → Lead capture**, create a source, and copy the one-time signing secret.

You receive:

- a source ID such as `cap_...`;
- a secret beginning `trv_capture_...`.

The secret is shown only on create/rotate. Trevra stores only encrypted ciphertext. Do not put the secret in landing-page JavaScript; keep it in the website backend, Cloudflare Worker, Vercel/Next server route or equivalent trusted runtime.

## 2. Endpoint

```text
POST /api/intake/v1/submissions
```

Required headers:

```text
Content-Type: application/json
X-Trevra-Source: cap_...
X-Trevra-Timestamp: <unix seconds>
X-Trevra-Idempotency-Key: <stable logical submission key>
X-Trevra-Signature: sha256=<hex HMAC>
```

The request body never contains a workspace ID. Trevra derives the workspace from the authenticated Capture Source.

## 3. Canonical body

```json
{
  "kind": "demo_request",
  "occurredAt": "2026-08-20T21:00:00.000Z",
  "person": {
    "name": "Ada Founder",
    "email": "ada@example.com",
    "phone": "+41441234567",
    "role": "Founder",
    "externalId": "form-user-42"
  },
  "company": {
    "domain": "example.com",
    "name": "Example"
  },
  "page": {
    "url": "https://example.com/demo",
    "referrer": "https://www.google.com/"
  },
  "attribution": {
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "brand"
  },
  "consent": {
    "privacyAccepted": true,
    "marketingEmail": false,
    "capturedAt": "2026-08-20T21:00:00.000Z"
  },
  "message": "Please show me the product.",
  "properties": {
    "team_size": "11-50"
  }
}
```

`person` needs at least one deterministic identity: email, an already-normalized E.164 phone, or `externalId` scoped to the Capture Source. A name alone never creates a Person. `company` is optional; Trevra never derives an Account from an email domain.

`properties` is deliberately shallow and bounded. Trevra accepts GTM submission kinds, not arbitrary product telemetry.

## 4. Signature

Sign the exact raw JSON bytes using HMAC-SHA256.

Canonical signing input:

```text
<timestamp>.<idempotency-key>.<exact raw body bytes>
```

Example in Node:

```ts
import { createHmac } from 'node:crypto';

const raw = JSON.stringify(payload);
const timestamp = Math.floor(Date.now() / 1000).toString();
const idempotencyKey = formSubmissionId; // generate once; reuse for every retry
const signature = createHmac('sha256', process.env.TREVRA_CAPTURE_SECRET!)
  .update(timestamp + '.' + idempotencyKey + '.' + raw)
  .digest('hex');

await fetch(`${process.env.TREVRA_API_BASE_URL}/api/intake/v1/submissions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-trevra-source': process.env.TREVRA_CAPTURE_SOURCE_ID!,
    'x-trevra-timestamp': timestamp,
    'x-trevra-idempotency-key': idempotencyKey,
    'x-trevra-signature': `sha256=${signature}`
  },
  body: raw
});
```

The Setup screen contains Cloudflare Worker, Next.js/Vercel and raw HTTP recipes generated for the selected source.

## 5. Idempotency and retries

The idempotency key identifies one logical submission within one Capture Source.

- First accepted delivery: `202`.
- Exact retry with the same key and exact body: `200`, same submission ID, no duplicate.
- Same key with different body: `409`.

On transport failure or `429`/`5xx`, retry with the **same idempotency key and exact body bytes**. Do not generate a fresh key for each network retry.

## 6. Status codes

| Status | Meaning                                     |
| ------ | ------------------------------------------- |
| `200`  | identical retry already accepted            |
| `202`  | new submission accepted                     |
| `400`  | invalid GTM payload/idempotency input       |
| `401`  | invalid/stale signature or disabled source  |
| `404`  | Capture Source not found                    |
| `409`  | idempotency key reused with different bytes |
| `413`  | request body too large                      |
| `429`  | source rate limit reached                   |
| `5xx`  | temporary Trevra failure; retry safely      |

## 7. Secret rotation and revocation

**Rotate secret** generates a new one-time secret. The previous secret remains valid for a short overlap window so a deployment can roll safely. After the overlap expires, the previous secret is rejected.

**Disable source** stops new captures immediately. Re-enable it only when that source should resume writing GTM data.

Capture Source ciphertext participates in Trevra's normal secret-custody report and deployment master-key reseal process.

## 8. Data ownership

Trevra stores:

- canonical People;
- optional explicit Account associations;
- immutable inbound submissions;
- source, attribution and consent evidence;
- append-only GTM events about the capture.

The landing/runtime continues to own edge concerns such as origin checks, honeypots, bot/rate protection and UI validation. Capture does not make Trevra a website backend or generic event platform.
