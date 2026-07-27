# Trevra integration contracts

Trevra uses Nango for OAuth or API-key authorization, encrypted credentials, refresh, incremental sync storage, retries, rate-limit handling, observability, and action execution. Provider integrations must emit Trevra's canonical commercial models. Trevra owns the normalization boundary, provenance, evidence graph, recommendation policies, approvals, and outcomes.

## Connection identity

Every Nango Connect Session is tagged with:

```json
{
  "end_user_id": "<trevra user id>",
  "end_user_email": "person@example.com",
  "organization_id": "<trevra workspace id>",
  "end_user_display_name": "person@example.com"
}
```

The Nango auth webhook must preserve those tags. Trevra uses `organization_id` for tenant isolation and stores only the Nango connection ID, provider configuration key, status, and sync metadata—not raw OAuth credentials.

## Canonical models

Every synced record must include a stable provider-side `id` and one of the following `kind` values.

### Message

```json
{
  "kind": "message",
  "id": "provider-message-id",
  "clientName": "Acme Labs",
  "contactName": "Maya Chen",
  "clientEmail": "maya@acme.com",
  "projectName": "Website launch",
  "direction": "inbound",
  "subject": "A few additions",
  "body": "Could you also create two additional pages?",
  "occurredAt": "2026-07-23T09:00:00.000Z",
  "externalUrl": "https://provider.example/item/123"
}
```

### Opportunity

```json
{
  "kind": "opportunity",
  "id": "provider-opportunity-id",
  "clientName": "Orbit Health",
  "contactName": "Jonas Keller",
  "clientEmail": "jonas@orbit.com",
  "title": "Brand strategy engagement",
  "value": 8000,
  "currency": "EUR",
  "status": "proposal_sent",
  "proposalSentAt": "2026-07-14T09:00:00.000Z",
  "expectedResponseAt": "2026-07-18T09:00:00.000Z",
  "externalUrl": "https://provider.example/opportunities/123"
}
```

### Contract and scope

```json
{
  "kind": "contract",
  "id": "provider-contract-id",
  "clientName": "Acme Labs",
  "projectName": "Website launch",
  "title": "Statement of work",
  "status": "signed",
  "signedAt": "2026-07-01T09:00:00.000Z",
  "clauses": [
    {
      "type": "change_order",
      "title": "Additional deliverables",
      "content": "Additional pages require written approval and are priced separately.",
      "value": 750,
      "unit": "per landing page"
    }
  ]
}
```

```json
{
  "kind": "scope_item",
  "id": "provider-scope-id",
  "clientName": "Acme Labs",
  "projectName": "Website launch",
  "description": "Additional landing pages priced separately",
  "included": false,
  "unitPrice": 750,
  "currency": "EUR"
}
```

### Milestone

```json
{
  "kind": "milestone",
  "id": "provider-milestone-id",
  "clientName": "Luma Works",
  "projectName": "Positioning sprint",
  "name": "Final strategy delivery",
  "amount": 2400,
  "currency": "EUR",
  "status": "delivered",
  "deliveredAt": "2026-07-21T15:00:00.000Z"
}
```

### Invoice and payment

```json
{
  "kind": "invoice",
  "id": "provider-invoice-id",
  "clientName": "Acme Labs",
  "projectName": "Website launch",
  "externalRef": "INV-104",
  "amount": 1850,
  "currency": "EUR",
  "status": "sent",
  "issuedAt": "2026-06-28T09:00:00.000Z",
  "dueAt": "2026-07-16T09:00:00.000Z"
}
```

```json
{
  "kind": "payment",
  "id": "provider-payment-id",
  "invoiceExternalRef": "INV-104",
  "amount": 1850,
  "currency": "EUR",
  "paidAt": "2026-07-23T09:00:00.000Z"
}
```

## Nango write-back actions

### `trevra-create-invoice`

Input:

```json
{
  "recommendationId": "rec_123",
  "recommendationType": "unbilled_milestone",
  "clientId": "cl_123",
  "clientName": "Luma Works",
  "recipient": "sofia@luma.com",
  "amount": 2400,
  "currency": "EUR",
  "description": "Final strategy delivery",
  "dueDays": 14,
  "message": "The completed milestone invoice is attached.",
  "idempotencyKey": "sha256-approved-payload"
}
```

Output must contain one of:

```json
{ "invoiceId": "INV-105" }
```

```json
{ "id": "provider-invoice-id" }
```

```json
{ "externalRef": "INV-105" }
```

The provider integration must use `idempotencyKey` or an equivalent provider idempotency mechanism and must return an existing invoice when the same key is retried.

### `trevra-create-change-order`

Input is the same commercial payload plus `subject` and `message`. Output must contain `changeOrderId`, `id`, or `externalRef`. This action must create a draft or approval request; Trevra never delegates automatic execution of scope changes.

## Sync behavior

- Return incremental records with stable IDs.
- Preserve provider timestamps and URLs.
- Never place provider instructions in canonical content fields.
- Map deletions to Nango's deleted-record mechanism; Trevra retains provenance and marks records inactive rather than erasing audit history.
- Emit financial values as decimal major units, never cents.
- Normalize currencies to ISO 4217 uppercase codes.
- Keep raw provider payloads in Nango; Trevra stores the canonical payload and a SHA-256 content hash.

## Direct webhooks

Stripe may send signed events directly to `/api/webhooks/stripe`. Nango sends signed auth and sync events to `/api/webhooks/nango`. Both endpoints store provider event IDs before processing, so retries are idempotent.

## Proprietary systems

Trevra supports proprietary systems through three implemented boundaries:

1. **Read/analysis modules** run as signed OCI, WASI, or restricted remote community modules through the sandbox gateway.
2. **Canonical ingestion** accepts signed or trusted normalized records through `/api/events`, Nango syncs, CSV imports, or document imports. Supported canonical kinds are message, opportunity, contract, scope item, milestone, invoice, and payment.
3. **Approved remote action adapters** perform proprietary write-back only after a playbook approval step has pinned the exact payload hash.

Configure remote write adapters with `TREVRA_REMOTE_ACTION_ADAPTERS_JSON`:

```json
[
  {
    "actionType": "acme.crm.update",
    "endpoint": "https://actions.internal.example/trevra",
    "tokenEnv": "TREVRA_REMOTE_ACTION_ADAPTER_TOKEN",
    "provider": "acme-crm",
    "timeoutSeconds": 30,
    "payloadSchema": {
      "type": "object",
      "properties": {
        "contactId": { "type": "string" },
        "lifecycle": { "enum": ["qualified", "customer"] }
      },
      "required": ["contactId", "lifecycle"],
      "additionalProperties": false
    }
  }
]
```

The receiving adapter gets:

- `Authorization: Bearer <token>`;
- `X-Trevra-Action` with the configured action type;
- `X-Trevra-Idempotency-Key` containing the exact approved payload hash;
- `X-Trevra-Signature: sha256=<HMAC-SHA256>` over the canonical JSON body.

The JSON body contains `actionType`, `workspaceId`, `idempotencyKey`, and `payload`. The adapter must return `externalRef` or `id`, and should return its provider name. Production endpoints must use HTTPS. A custom playbook may reference the configured action type, but generic external-write modules remain blocked.
