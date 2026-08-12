# BYOK and the hosted agent — design

**Status: built.** This document was written first and argued with first; the
code follows it. Where the two disagree, that is a bug in the code.

Goal: let an operator paste their own model key so Trevra can run the agent
itself, on a schedule, with the laptop closed.

---

## 1. Why this is the risky one

Everything Trevra stores today is either **public**, **hashed**, or **held by
someone else**:

| Secret | How it lives today |
|---|---|
| Provider OAuth (Gmail, Stripe, HubSpot…) | Held by **Nango**. Trevra keeps a connection reference, never the token. |
| Agent tokens | **Hashed.** Trevra can verify one, never reproduce it. |
| Session cookies | Signed, short-lived. |

A model key is the first secret Trevra must **decrypt and use**. That is a
genuinely new security surface, and it is the reason this document exists before
the code does.

---

## 2. Threat model

| Attacker gets | Outcome | Mitigation |
|---|---|---|
| A database dump | **Ciphertext only.** Useless. | Keys encrypted with `TREVRA_SECRETS_KEY`, which lives in the environment / secret manager — never in Postgres, never in a migration, never in a backup of the database. |
| The env var alone | Useless without the database. | Two-location split is the whole point. |
| **Both** | Full key compromise. | Unrecoverable by design. Trevra shows each key’s `last4` and creation date so the operator can find and revoke it at the provider fast. Assume-breach: make rotation easy, not impossible. |
| A logged-in user of the workspace | Can use the key via the agent, cannot read it. | Plaintext is never returned by any API, at any privilege. Write-only from the UI’s perspective. |
| Someone reading logs / a bug report | Nothing. | The key is never logged, never in an error message, never in `skill_runs`, never in evidence, never in a payload hash. |
| A prompt injection in scraped content | Cannot exfiltrate the key. | The key is never in the model’s context. It is a transport credential, applied at the HTTP layer, not a tool input. |

That last row matters more than it looks. Trevra reads Reddit threads, GitHub
issues, and web pages — all attacker-controlled text. The key must never be
somewhere a model can be talked into repeating.

---

## 3. Storage

```sql
CREATE TABLE workspace_secrets (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,           -- 'model_api_key'
  ciphertext    BYTEA NOT NULL,
  iv            BYTEA NOT NULL,          -- 96-bit, random per write, never reused
  auth_tag      BYTEA NOT NULL,          -- GCM tag; detects tampering
  key_version   INTEGER NOT NULL DEFAULT 1,
  last4         TEXT NOT NULL,           -- display only, so the UI never needs plaintext
  label         TEXT,                    -- 'Anthropic', 'OpenRouter'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ON workspace_secrets(workspace_id, kind);
```

- **AES-256-GCM**, fresh random IV per write. GCM because it authenticates:
  a tampered ciphertext fails to decrypt rather than yielding garbage.
- `TREVRA_SECRETS_KEY` is 32 random bytes, base64. Absent it, BYOK is simply
  **off** — the feature does not half-work, and it never falls back to storing
  anything in the clear.
- `key_version` exists so the server key can be rotated by re-encrypting rows,
  without a schema change and without downtime.
- `last4` and `label` are the only fields the UI ever sees.

### The endpoint is an attack surface too

`baseUrl` is supplied by the workspace and **dialled by the server**, which
makes it a server-side request forgery primitive: left unchecked, a member could
point it at `https://169.254.169.254/` and read cloud instance metadata out of
the agent's own transcript. Two layers, because one is not enough:

| Layer | Where | Catches |
|---|---|---|
| Structural | On save, no DNS | Raw IPs, loopback, single-label and `.local` hosts, plain HTTP |
| Resolving | On every model call, via `createSsrfFetch()` | A public hostname that resolves to a private address, and every redirect hop |

A self-hoster running Ollama or vLLM on their own network sets
`TREVRA_ALLOW_PRIVATE_MODEL_HOSTS=true` deliberately. The default is deny,
because the default deployment is the one where that would be someone else's
metadata service.

### Access rules

1. Plaintext is returned by exactly one internal function, called only at the
   moment of a model request.
2. No API route returns it. There is no “reveal” endpoint, for anyone.
3. It never enters a skill input, a skill output, evidence, a domain event, or a
   payload hash.
4. It is applied as an HTTP header at the edge of the model call and never
   crosses back into application state.

---

## 4. Provider shape

BYOK is three fields, not an enum:

```
{ baseUrl, apiKey, model }
```

One adapter, no lock-in: any endpoint speaking the OpenAI shape — OpenAI, Azure,
Groq, Together, OpenRouter, Fireworks, local vLLM or Ollama, a self-hosted
LiteLLM Proxy.

### The loop is not ours to write

The tool-calling loop is commodity; the approval boundary is not. So the loop
comes from **[Vercel AI SDK](https://ai-sdk.dev)** (`ai`, Apache-2.0, three
direct dependencies) plus `@ai-sdk/openai-compatible`, and everything that makes
Trevra *Trevra* — approvals, the hash-pinned payload, the ledger, scopes,
policy, the budget — stays ours.

What the SDK gives us that a hand-written loop would have to earn:

| Need | How |
|---|---|
| Bounded steps | `stopWhen: isStepCount(n)` |
| Per-step token usage, to charge the budget | `onStepEnd({ usage })` — per step, not just a total |
| Our JSON-Schema tools, unchanged | `dynamicTool` + `jsonSchema()` — the documented path for runtime schemas |
| The SSRF guard on a workspace-supplied endpoint | `createOpenAICompatible({ fetch })` takes our `createSsrfFetch()` |

What it does **not** impose: no persistence, no state machine, no tracing
backend, no agent-memory model. That matters more than the features — a
framework carrying its own run store would put a second source of truth next to
the ledger, and the ledger is the trust surface.

**One thing we deliberately do not use.** The SDK ships `toolApproval:
'user-approval'`, an in-loop pause. It is not our approval boundary and must not
become one: it pauses a *conversation*, while Trevra pins an exact payload hash
that a human signs and rejects the payload if it changed afterwards. Our
boundary is stronger and sits lower — no tool in the surface can execute an
external write at all. See app-spec §11.

**Honest caveat.** The transport is uniform; *agent quality* is not. A loop
depends on reliable tool-calling, and OpenAI-compatible shims vary considerably
in how faithfully they implement it. Any provider will connect; not every
provider will drive the loop well. A native Anthropic adapter (`@ai-sdk/anthropic`)
is worth adding later for fidelity, behind the same interface — the SDK is what
makes that a one-file change rather than a second client.

No default endpoint ships. The operator states where their key goes; Trevra does
not guess and does not silently route a key somewhere they did not name.

---

## 5. Spend control

A loop with a key can burn real money with nobody watching. Caps are part of the
feature, not a later hardening pass.

```sql
CREATE TABLE workspace_agent_budget (
  workspace_id      TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  monthly_cap_cents INTEGER NOT NULL DEFAULT 2000,   -- $20, deliberately low
  spent_cents       INTEGER NOT NULL DEFAULT 0,
  period_start      TIMESTAMPTZ NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE   -- opt in, not out
);
```

- **Pre-flight**: refuse the call when the cap is reached. Never mid-stream, so
  spend cannot overshoot on a long generation.
- **Recorded per call**: tokens in/out and cost, against the run that caused it,
  so “what did this cost me” has an answer per job.
- **Default off.** A stored key does not imply consent to spend it.
- **Kill switch**: `enabled = false` stops it instantly. The existing policy
  engine is the second switch — `deny action:agent.run`.
- **Bounded loop**: a hard ceiling on steps per run, so a model that loops on a
  failing tool stops on its own.

---

## 6. What the hosted agent may do

Exactly what your laptop agent may do. No more, for living closer to the data.

| | Hosted agent |
|---|---|
| Read the revenue brief, clients, runs | Yes |
| Run `sideEffect: 'none'` and `'network-read'` skills | Yes |
| Start playbooks | Yes |
| **Prepare** actions | Yes |
| **Approve** anything | **No** |
| **Execute** an external write | **No** |
| Read the model key | No — it is applied at the transport layer |
| Manage connections, tokens, or policies | No |

It runs with agent-token scopes: `skills:read`, `skills:run`, `runs:read`,
`playbooks:read`, `playbooks:run`, `workflows:read`, `workspace:read`,
`actions:prepare` — every scope a laptop agent token is issued with, which is
the point of the sentence above. `runs:read` was missing from an earlier draft
of this list by oversight, not by design: an agent that cannot read the ledger
cannot check whether the thing it just ran actually worked.

Every model call and every tool call lands in the ledger. An autonomous agent
you cannot audit afterwards is not a feature.

---

## 7. Self-host vs hosted

| | Self-hosted | Trevra Cloud |
|---|---|---|
| `TREVRA_SECRETS_KEY` | Operator generates and holds it | Trevra holds it, per-environment |
| Blast radius of Trevra being breached | Your box only | Every workspace with a stored key |
| Honest recommendation | Fine | **Say this plainly on the key-entry screen.** A hosted service holding customer model keys is a real, concentrated liability, and users deserve to weigh it before pasting. |

If that trade is not acceptable, the BYO-agent path stays available and stores
no key at all. **That is the default, and it should stay the default.**

---

## 8. Explicitly out of scope

- Trevra supplying a model. This is bring-your-own only — no reselling inference.
- Storing any other kind of secret in this table. It is `model_api_key` today;
  widening it is a new decision with a new threat model.
- Any path where an agent approves its own work. See app-spec §11.

---

## 9. Build order — done

1. **Secret storage** — done. AES-256-GCM, `workspace_secrets`, with round-trip,
   tamper, wrong-key and rotation tests.
2. **Key entry** — done. Paste, `last4`, replace, delete, and the §7 warning
   above the field rather than below it.
3. **Budget** — done. Cap, pre-flight, per-call cost, kill switch, and an
   autopilot schedule that defaults off.
4. **The loop** — done. Vercel AI SDK over the shared tool surface, bounded
   steps, stopping at the approval boundary.

---

## 10. What the adversarial review changed

The build was reviewed by an agent whose only job was to break it, using running
probes rather than opinions. It is worth recording what it found, because the
pattern is instructive: **the perimeter around the key held; the thing that
failed was the cap.**

| Found | Why it mattered |
|---|---|
| A provider that omits `usage` was charged **nothing** | The cap never bound. With autopilot at the 15-minute floor that is 96 runs a day, unmetered, while the UI reported `$0.00 of $20.00 used`. §4 predicts these shims by name. |
| ...and after the first fix, `usage: {prompt_tokens: 0}` still was | The same hole, one JSON field away. A completed call cannot use zero prompt tokens — the system prompt alone is ~150 — so a zero prompt count is now treated as no report at all. |
| The SDK swallows step-callback errors | One transient database error lost a step's ledger row **and** its charge, silently, while the loop kept spending and still reported `completed`. |
| Marking a run `stopped` stopped nothing | The loop appended another step and charged 75 cents *after* the operator was told it had stopped. A row is not a process. |
| One crashed run wedged a workspace's autopilot **permanently** | And an ordinary rolling deploy was enough to cause it. |
| The self-host escape hatch was dead on the first call | `TREVRA_ALLOW_PRIVATE_MODEL_HOSTS=true` let an operator save an Ollama endpoint that was then refused every time. |
| The redirect loop re-attached `Authorization` cross-origin | Platform `fetch` strips it deliberately; ours restored it, so hop 2 to an attacker host carried the key. |

Two lessons worth keeping:

1. **A safety control that is never exercised is decorative.** The cap, the kill
   switch and the self-host flag all had tests, and all three were broken. The
   tests asserted the shape of the code rather than the behaviour of the system.
2. **Name-based assertions are not invariant checks.** The test that "no tool can
   approve or execute" matched tool *names* against a regex. A skill called
   `gtm.share-update` doing an external write passed it. The real guard did
   refuse — but the test would never have caught its removal.
