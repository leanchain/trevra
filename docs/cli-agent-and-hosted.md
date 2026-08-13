# The subscription CLI backend, per workspace, on the hosted product

**Status: built.** This is the short write-up the doc comment on
`resolveWorkspaceCliBackend` (`src/server/agent/cli.ts`) points at. It is
deliberately not folded into
[docs/byok-and-hosted-agent.md](./byok-and-hosted-agent.md), which is about the
model-key secret specifically -- see that document's section 8 for the
one-sentence cross-reference and why this stays a separate write-up.

---

## 1. What this is

A third way to run the hosted agent, alongside BYOK (a pasted model API key)
and the operator's global `TREVRA_AGENT_CLI*` env vars: a **workspace** stores
its own Claude or Codex subscription OAuth token, and the hosted agent runs
through that subscription's CLI (`claude -p` / `codex exec`) instead of an API
key, for that workspace's own runs only.

It exists because the founder running Trevra as a hosted product
(app.usetrevra.com) wants to offer this on the hosted product itself, not only
to self-hosters -- explicitly "at your own risk", with a clear disclaimer and
an explicit opt-in, not blocked outright.

## 2. Why this is a different decision from the existing hosted refusal

`cli.ts`'s global-env path (`resolveCliBackend`) refuses outright on
`TREVRA_DEPLOYMENT_MODE=hosted`, unconditionally, and that refusal is
**unchanged by this feature**. Its own doc comment calls it "a licence
boundary, not a preference": one operator's personal subscription, configured
once in the server's environment, would silently back **every tenant's** work.
That is a real ToS/multi-tenancy problem -- a subscription CLI is authenticated
as one human under consumer terms that cover that human's own use, and a
multi-tenant service billing strangers' work to it breaches those terms and
gets the account terminated.

A row in `workspace_cli_agent_config` / `workspace_secrets(kind='cli_oauth_token')`
is a **different shape entirely**: one workspace's own token, backing only that
workspace's own runs. That is architecturally identical to what BYOK already
is -- bring your own credential -- not the one-subscription-for-every-tenant
shape the hosted refusal exists to stop. Per-workspace scoping is what changes
the analysis: a compromise of the token, or an honest misuse of it, gets an
attacker or a confused workspace member the ability to run the hosted agent as
*that one workspace's* subscription, bounded by the same budget, ledger,
scopes and kill switch every other backend answers to. That is exactly the
blast radius a leaked BYOK model key already has. It is not the global-env
path's blast radius, where one credential can silently bill an entire fleet.

So: two functions, two trust boundaries, in the same file.

| | `resolveCliBackend` (global env) | `resolveWorkspaceCliBackend` (per workspace) |
|---|---|---|
| Credential source | Server env vars, set once by the operator | A row in `workspace_secrets`, set by the workspace |
| Backs whose runs | Every tenant on the deployment | Only the workspace that stored it |
| Hosted mode | Refuses outright, unconditionally | Allowed, gated on explicit consent |
| The risk that remains | The multi-tenancy problem itself | The token's own consumer-terms exposure (see section 4) |

## 3. Storage and the gate

`migrations/042_cli_agent_config.sql` adds `workspace_cli_agent_config`:

```sql
CREATE TABLE workspace_cli_agent_config (
  workspace_id      TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  cli               TEXT NOT NULL CHECK (cli IN ('claude','codex')),
  model             TEXT NOT NULL,
  risk_accepted_at  TIMESTAMPTZ,   -- THE GATE. Null until explicitly accepted.
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

The token itself is not a column here -- it goes into `workspace_secrets` under
`kind: 'cli_oauth_token'`, sealed through the same AES-256-GCM crypto path
(`secrets/crypto.ts`) and the same access rules
(byok-and-hosted-agent.md section 3) as the model-key secret: plaintext leaves
exactly one internal function (`readWorkspaceSecretPlaintext`), at the moment
it is handed to the child process, and no route ever returns it.

**`risk_accepted_at` is the gate, and it is unconditional.**
`resolveWorkspaceCliBackend` refuses to resolve a backend at all until it is
set, on *every* deployment mode -- self-host included. That is a deliberate
simplification, not an oversight: the invariant "the DB-sourced backend always
requires explicit consent" is one sentence with no exceptions, and a self-hoster
who does not want the extra click already has a frictionless path -- the
unchanged global env vars.

Revoking is symmetric: `accepted: false` clears `risk_accepted_at` back to
`NULL`, not to a boolean sitting next to a stale timestamp, so re-accepting
later always means seeing the disclaimer again.

## 4. What the disclaimer says, and why scoping does not make it disappear

Per-workspace scoping fixes the multi-tenancy problem. It does **not** fix a
separate, smaller risk that has nothing to do with multi-tenancy: pasting a
personal subscription's OAuth session into *any* automated, server-side
context -- Trevra's hosted product or anywhere else -- can itself brush against
that subscription's own consumer terms, independent of who else's work does or
does not run on it. Trevra cannot mitigate that; it is the workspace's own
subscription and the workspace's own terms to weigh.

That is why the consent checkbox (`PUT /api/agent-setup/cli-risk-accept`) is
its own explicit, revocable, timestamped act rather than an implied consequence
of pasting a token, and why its copy says plainly, before the token field is
even usable: this uses the workspace's own subscription rather than a metered
plan; automated use like this may violate that subscription's own terms
independent of anything Trevra does; and the account could be suspended for it.
Mirrors byok-and-hosted-agent.md section 7's rule for the hosted-key screen:
say the real risk plainly, before pasting, not after.

## 5. API surface

Mirrors `/api/agent-setup/*` in every discipline that already applies there --
zod-validated input, `Cache-Control: no-store` on anything secret-adjacent,
`authLimiter` on the credential route, no reveal endpoint for either the model
key or this token:

| Route | What it does |
|---|---|
| `GET /api/agent-setup` | `cli: { config: {cli, model} \| null, tokenStored, riskAccepted }` |
| `PUT /api/agent-setup/cli-config` | Save the chosen CLI and model. Never touches `risk_accepted_at`. |
| `PUT /api/agent-setup/cli-token` | Save the token. Gated on `secretsConfigured()`, rate-limited. |
| `DELETE /api/agent-setup/cli-token` | Delete the stored token. |
| `PUT /api/agent-setup/cli-risk-accept` | `{ accepted: boolean }`. Its own isolated write -- see section 3. |

## 6. Dispatch order (`loop.ts`)

1. Budget pre-flight (applies to every backend, including this one -- a
   subscription costs no marginal dollars, but Trevra still charges it a
   notional amount and still checks the cap).
2. The global env CLI backend, if the operator configured one. Unchanged.
3. **This workspace's own CLI backend**, if configured, risk-accepted and
   token-stored -- checked before BYOK, because like the global path it is an
   alternative to having a model key at all.
4. BYOK.

## 7. Explicitly out of scope here too

- No reveal, for either the model API key or this token. Two deliberate
  absences, same as byok-and-hosted-agent.md's client doc comment describes.
- Storing a *fourth* kind of secret in `workspace_secrets` is, again, a new
  decision with a new threat model -- not a precedent this document sets for
  the next one.
- The Cloudflare Pages pipeline, the Oracle infra, and Google OAuth are
  unrelated to this feature and untouched by it.
