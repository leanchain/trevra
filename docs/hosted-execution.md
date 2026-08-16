# Hosted LinkedIn execution

*Supersedes the "hosted ⇒ off, always" half of `docs/linkedin-outreach-plan.md`
§4.3. Everything else in §4 — the limits, the warm-up ramp, working hours, the
pacing gaps, the cooldowns, the checkpoint detection, the ledger — is unchanged
and still applies, in the same order, to every action this path sends.*

## What changed, and why

Until this shipped, everything Trevra sent to LinkedIn was sent from a browser
on the **operator's own machine**: `npm run linkedin:worker`, a persistent Chrome
profile on local disk, the operator's own residential IP, a session they signed
into by hand. That is a genuinely better risk posture than every hosted
competitor's, and it is also why a hosted Trevra could plan an invite and never
send one. A container has no display, no Chromium and no profile directory
belonging to the person whose account it is, so `TREVRA_DEPLOYMENT_MODE=hosted`
turned the worker off — and planned rows sat at `status='planned' AND claimed_at
IS NULL` forever.

The owner has decided to close that gap. Hosted Trevra now drives a **remote
browser** over the DevTools protocol: a cloud browser session that Trevra
attaches to, signs in with the seat's stored credential, and acts through.

## The operating model

```
  planner / campaign runner        →  linkedin_actions rows, status='planned'
         (unchanged)

  worker loop (src/worker/index.ts)
    ├─ hostedSeatFilter            →  is this workspace authorised?      ← new
    ├─ claimSeatLease              →  one driver per account, host pin   (unchanged)
    ├─ openBrowser
    │    ├─ resolveSeatProxy       →  the seat's own residential exit    (unchanged)
    │    ├─ seatContextFingerprint →  stable per-seat UA/locale/timezone (unchanged)
    │    └─ browser/provider.ts    →  local launch, or CDP attach        ← new
    ├─ readSeatStorageState        →  restore the signed-in session      ← new
    ├─ loginLinkedInSeat           →  reuse, or sign in                  (unchanged)
    ├─ runLinkedInLocalBatch       →  the safety gate, per action        (unchanged)
    └─ persistSeatSession          →  save the session back              ← new
```

**It is the same loop.** Claiming, leasing, pacing, cooldown, the safety gate and
the ledger are the same code on a hosted deployment as on a laptop, because a
second implementation of any of them is a second place for them to be wrong.
What hosted execution adds is *where the browser is* and *who may be served*.

### Sessions, because there is no disk

`chromium.connectOverCDP` attaches to a browser somebody else launched. There is
no `user_data_dir`, so there is no persistent profile — and the Chrome profile
*is* the LinkedIn session. Without somewhere to keep it, every run would be a
brand-new device sign-in, which is the loudest challenge signal LinkedIn has.

So the seat's `storageState` (cookies + per-origin storage) round-trips through
`linkedin_seat_sessions` (migration 065), **sealed with the same custody as the
password**: AES-256-GCM, `TREVRA_SECRETS_KEY`, the same rotation window, and
`(store, workspace, seat, kind)` as GCM additional authenticated data — so one
seat's session cannot be opened as another's, or another tenant's. A LinkedIn
`li_at` cookie authenticates the account outright with no second factor in front
of it; it is treated as strictly more dangerous than the password that produced
it.

It is **restored before every run** and **saved after every run** (including runs
that failed partway — the cookies are still live and losing them costs the next
run a sign-in for nothing).

A stored session that cannot be used — sealed with a key this deployment no
longer holds, tampered with, expired, or carrying no sign-in cookie — degrades to
**"needs re-login"**, never to a silent unauthenticated run. The row is dropped
and the seat signs itself in with the stored credential exactly as a first run
does.

> **Known limit:** `secrets/custody.ts` does *not* re-seal `linkedin_seat_sessions`
> on a key rotation. A rotation that drops the previous key makes every stored
> session unopenable, and every seat signs in again on its next run. That is a
> deliberate trade — a password has no such luxury and *is* re-sealed — and it is
> marked `lc-debt` in that file.

### Fingerprint and proxy survive the remote path

Both are still functions of `(workspaceId, seatKey)` and both still come from the
same two functions the local worker uses:

- `seatContextFingerprint` → passed to `newContext({ userAgent, locale,
  timezoneId, viewport })`, which Playwright applies over CDP.
- `resolveSeatProxy` → **read through the existing function**, including the
  DB-backed `linkedin_seats.proxy_url`.

A context created over a raw CDP attach **cannot** be given a proxy: the browser
was launched by the provider before we connected, so its exit IP is already
decided. The only place a proxy can be delivered is the connect URL, which is why
`TREVRA_BROWSER_CDP_URL` is a *template*.

## When hosted execution refuses — the exact conditions

| Condition | What happens |
| --- | --- |
| `TREVRA_DEPLOYMENT_MODE` is not `hosted` | Nothing here applies. The local worker runs exactly as it always did. |
| Hosted, **no remote browser configured** | The old refusal, **verbatim**: `This deployment is hosted, so it will not take custody of a LinkedIn password.` Credential saves 409; no seat is run. |
| Hosted, remote browser **asked for and misconfigured** | The server **refuses to boot** in production, naming the variable. It does *not* fall back to local: a hosted box that silently reverts to a browser it does not have is a queue that fills up forever with no error anywhere. |
| Hosted + provider, **workspace has not acknowledged** | 409 on the credential save; the seat is skipped by the runner. Reason names `POST /api/linkedin/hosted-execution`. |
| Hosted + provider + acknowledgement **withdrawn** | Same as never acknowledged. A batch already in flight finishes; no new seat is picked up from the next tick. |
| Acknowledgement predates the current statement version | Treated as absent; the owner is asked again. |
| Remote mode, **seat has no proxy** | **The seat is not run.** No fallback to the provider's datacentre IP, ever. Its work stays due. |
| Remote mode, seat has a proxy but the endpoint template has nowhere to put it (and `TREVRA_BROWSER_CONNECT=cdp`) | **The seat is not run.** A silently dropped proxy is a direct connection wearing a proxy's clothes. |
| Remote mode, driver has no `connectOverCDP` / `connect` | Refused with the install instruction. |
| Seat is pinned to a host holding its Chrome profile | The hosted runner is **refused** — that account's device trust is on that machine. Stop the local worker there first. |
| No `TREVRA_SECRETS_KEY` | Production boot fails when remote is configured: without it no session can be stored and every run is a new-device sign-in. |
| Any pre-existing gate (limits, warm-up, working hours, pacing, cooldown, checkpoint, duplicate target) | **Unchanged.** A seat refused on a laptop is refused here. |

## Configuration

| Variable | Meaning |
| --- | --- |
| `TREVRA_BROWSER_PROVIDER` | `local` (default) or `remote`. **An endpoint alone does not turn remote on** — selecting it is an explicit act, so a stale variable cannot silently move every seat onto somebody else's IP. |
| `TREVRA_BROWSER_CDP_URL` | The connect URL, as a template. Placeholders: `{apiKey}`, `{proxyUrl}`, `{proxyServer}`, `{proxyUsername}`, `{proxyPassword}`, `{workspace}`, `{seat}`. Everything substituted is URL-encoded. Must be `wss://` or `https://` in production. |
| `TREVRA_BROWSER_API_KEY` | Substituted at `{apiKey}` if the template has one; otherwise sent as an `x-api-key` header. |
| `TREVRA_BROWSER_CONNECT` | `cdp` (default, `chromium.connectOverCDP`) or `playwright` (`chromium.connect`, the Playwright server protocol — where `newContext({ proxy })` *is* honoured and no proxy placeholder is needed). |
| `TREVRA_BROWSER_HEADERS` | JSON object of extra handshake headers, e.g. `{"Authorization":"Bearer …"}`. |
| `TREVRA_BROWSER_LABEL` | What to call the provider in operator-facing sentences. Defaults to the endpoint host. |
| `TREVRA_SECRETS_KEY` | Required whenever the provider is remote. |
| `TREVRA_LINKEDIN_PROXIES` | Unchanged. Keyed `"<workspace>/<seat>"`, `"*/<seat>"`, `"<workspace>/*"`, `"*"`. **Required per seat in remote mode.** |

Nothing here names a vendor. A provider is an endpoint, a key and a protocol,
which is the whole of what these services differ by:

```bash
# A managed cloud browser that takes its key and proxy as query parameters
TREVRA_BROWSER_PROVIDER=remote
TREVRA_BROWSER_CDP_URL='wss://connect.example.com/?apiKey={apiKey}&proxyUrl={proxyUrl}'
TREVRA_BROWSER_API_KEY=…

# A browserless/Chrome container on the operator's own network
TREVRA_BROWSER_PROVIDER=remote
TREVRA_BROWSER_CDP_URL='wss://chrome.internal:3000/?token={apiKey}&--proxy-server={proxyServer}'
TREVRA_BROWSER_API_KEY=…

# A Playwright server (chromium.connect): the remote launches per connection,
# so the proxy goes through newContext and needs no placeholder
TREVRA_BROWSER_PROVIDER=remote
TREVRA_BROWSER_CONNECT=playwright
TREVRA_BROWSER_CDP_URL='wss://chrome.internal:3000/playwright'
```

**The exact query-parameter names each provider expects are the operator's to
supply from that provider's documentation; Trevra does not encode any of them.**
Nothing in this repository has been run against a real cloud-browser account —
the attach, the per-session proxy hand-off and the client-hint alignment against
a provider-launched Chromium are all verified against fakes, not against a live
provider.

## The authorisation

Hosted execution means Trevra's servers signing into a human's LinkedIn account
and acting as them. Every other gate is a technical precondition; this one is a
consent record, and it is **per workspace**, because the person who has to agree
is the person whose account it is — not whoever configured the server.

```
GET    /api/linkedin/hosted-execution   → deployment mode, the statement, the
                                          recorded acknowledgement, and whether
                                          this workspace is allowed right now
POST   /api/linkedin/hosted-execution   → {acknowledge: true, statementVersion}
                                          owner-only
DELETE /api/linkedin/hosted-execution   → withdraw, owner-only
```

The record (`linkedin_hosted_execution_ack`, migration 065) carries **who**,
**when** and **which wording** (`statement_version`). Changing the statement means
changing the number, which makes every existing acknowledgement stale and asks
every workspace again — the intended cost of changing what people agreed to.
Withdrawing sets `revoked_at` rather than deleting the row: "never agreed" and
"agreed and changed their mind" are different facts, and only the first is
silence.

## Two runners, one account: how they do not collide

The mechanism is the existing seat lease (`linkedin_seat_leases`, migration 054)
and its host pin. `profile_dir` on that row records **where the session lives**,
and it now takes one of two shapes:

- an absolute directory — a Chrome profile on one host's local disk;
- `remote:<provider>` — the session is in `linkedin_seat_sessions`, readable by
  every pod.

| Current holder | Claimer | Outcome |
| --- | --- | --- |
| local worker on host A | hosted pod | **Refused**, permanently, until that worker stops. The device trust is on host A. |
| hosted pod A | hosted pod B, lease live | **Refused** — ordinary mutual exclusion. |
| hosted pod A | hosted pod B, lease expired | **Allowed.** The session travels; pinning it to a pod that keeps nothing would strand the seat forever. |
| hosted pod A | local worker, empty profile dir | **Refused.** That worker would sign in from scratch — a new device. |
| hosted pod A | local worker with a real profile | **Allowed.** That machine is a home for the account, and always was. |

## Files

| Path | What it owns |
| --- | --- |
| `src/server/browser/provider.ts` | The provider interface, both providers, endpoint templating, and every refusal that is about *where the browser is*. |
| `src/server/linkedin/session-state.ts` | The sealed `storageState` store, and the "needs re-login" degradation. |
| `src/server/linkedin/hosted-execution.ts` | The authorisation record and the one gate every caller asks. |
| `src/server/linkedin/local-worker.ts` | Unchanged loop; `openBrowser` now routes through the provider, and `claimSeatLease` understands a portable session. |
| `migrations/065_linkedin_hosted_execution.sql` | Both tables. |
