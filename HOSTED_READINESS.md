# Hosted multi-tenant readiness

Written 2026-08-14, after a four-way audit (tenant isolation and authorization,
scale and concurrency, hosted execution viability, data model and lifecycle) and
the implementation pass that followed it.

The product was built as a single-operator, self-hosted tool. The intent now is a
hosted platform with many tenants, many users per tenant and many LinkedIn
accounts per tenant. Almost everything below was found by reading the code
against that intent, not by anything failing in production -- most of it could
not fail in production, because production is one operator.

---

## What was wrong, and is now fixed

### Cross-tenant reach

- **The agent child process inherited the deployment's entire secret
  environment.** It built its env by copying `process.env` and deleting nine
  names, so `BETTER_AUTH_SECRET` (forge a session for any user in any
  workspace), `TREVRA_SECRETS_KEY_PREVIOUS` (decrypt every tenant's stored
  credentials during a rotation window), the agent token pepper, Stripe, Nango,
  Google and admin keys all survived into a process whose prompt a tenant steers
  and which also ingests scraped Reddit and LinkedIn text. It is now built from
  an **allowlist**: a secret added to the deployment tomorrow is not readable by
  a tenant's child unless someone decides it should be.
- **Every tenant's Claude run shared the server's `~/.claude`** -- one
  credentials file, one session store, one history, writable by each tenant's
  child. Each run now gets its own home, seeded and removed with the run.
- **Reddit ran every tenant through one browser profile.** If tenant A's session
  was live, tenant B never signed in and posted **as A**; if A's session had
  expired, B's password was typed into the shared profile and A's next tick
  acted **as B**. Either way the account row recorded the wrong handle. Profile
  and browser are now per workspace, and a session is stamped only after the
  live handle matches the account being served. (LinkedIn had been fixed this
  way already; Reddit never got the fix.)
- **Stripe webhooks took the tenant from object metadata** -- attacker-settable
  -- and marked that workspace's invoice paid. Tenancy is now resolved from
  stored rows, and metadata that disagrees is refused and audited.
- **The sandbox gateway accepted an arbitrary workspace and an unsigned
  manifest**, rebuilt from the request body, with permissions bypassed. It now
  loads the release from the database and verifies it.
- **Any member of any workspace could wipe every tenant's projections** --
  `rebuildCommercialProjections` took no workspace and issued an unqualified
  `DELETE`.
- **A Nango connection lookup with no workspace predicate** landed one tenant's
  clients, messages and invoices in another's.
- **The registry** published self-attested `verified` releases in a global
  namespace with visibility unenforced on install. It is now explicitly public,
  with operator-granted verification and visibility enforced.

### Credential custody

- Ciphertext was **portable between tenants**: no AAD, so a `(ciphertext, iv,
  tag)` triple moved into another workspace's row decrypted cleanly and was used
  as that tenant's credential. Every row is now GCM-bound to its own identity
  (store, workspace, seat, kind) and encrypted under a per-workspace derived
  key.
- Rotation was **unverifiable**: nothing recorded which key sealed a row, so
  "is the re-encrypt finished?" had no answer and dropping the previous key
  bricked the remainder silently. Rows now carry a key id, and there is a
  custody report with a completion criterion plus a re-seal pass (scopable to
  one tenant).
- A wrong key rendered a **green setup screen** and failed only at use time.
- The hosted runbook did not generate `TREVRA_SECRETS_KEY` at all, and
  production did not require it -- a hosted box came up with custody silently
  off. Both fixed; hosted now refuses to boot without it.

### Authorization

- The API had **three** role checks in total; every other privileged act was
  open to any invited member -- deleting a seat, queueing real sends, changing
  limits, downloading exports containing every outreach target and message body,
  writing model keys, adding `allow` policies over any action pattern. Owner-only
  checks now cover those. Pause stays open to members deliberately (it is the
  kill switch; resume and start are owner-only, so a member cannot undo their
  own pause).
- Rate limiting was **per IP**, so tenants behind one NAT shared a bucket. There
  is now a per-workspace quota for authenticated traffic.
- `GET /api/clients/:id` scoped the client and then read six child tables by
  parent id alone.

### Data model

- **No composite `(workspace_id, id)` foreign key existed anywhere**, so a child
  row's workspace could legally disagree with its parent's. Migration 058 adds
  the parent keys and 14 composite FKs, validated separately.
- **Ten tenant-owned tables had no `workspace_id` column at all** and were
  reachable only through a parent id. The column, index and FK now exist, every
  writer fills it, and the reads over them are scoped. `NOT NULL` and the
  composite parent FKs are staged (see below).
- `seat_key TEXT NOT NULL DEFAULT 'owner'` on eight tables meant a forgotten
  column silently attributed a row to the owner account. Defaults dropped.
- `webhook_events` was globally unique on `(provider, external_event_id)`: one
  tenant's processed id made another's a silent no-op.
- `users.email` was unique on the raw column while every lookup lowercased it.
- Campaign member ids were `md5(campaign:contact)` with no workspace, so two
  tenants could collide -- silently, because the insert is `ON CONFLICT DO
  NOTHING`.

### Deletion and data-subject requests

- Nothing could be deleted. No route removed a user, a workspace, a lead list, a
  campaign, threads, messages or exports, while the published privacy page
  promised export-or-delete on request. There are now lead-list delete, campaign
  delete, workspace export, an erasure preview and workspace erasure -- refusing
  while work is in flight rather than half-deleting.
- "Disconnect" did not disconnect. LinkedIn left credentials, planned work and
  manual tasks behind; Reddit left the profile's cookies, so the account **could
  still post** after the customer revoked it. Both now release their work and
  report what could not be stopped (an action already claimed by a worker cannot
  be pulled back, and the response says so).

### Scale

- **Migrations ran on every process boot, in one transaction, through a pool
  with a 30s statement timeout** -- so a data-rewriting migration at a million
  rows would be cancelled, roll back the whole chain, and crashloop the process
  with nothing applied. Now a job: one transaction per file, no statement
  timeout, a short lock timeout, and a `-- trevra:no-transaction` lane for
  `CREATE INDEX CONCURRENTLY`. Hosted verifies and refuses instead of mutating
  on boot.
- **A claim had no lease.** A worker killed between claim and settle stranded
  the row permanently, and a deliberate human-settlement hold was
  indistinguishable from a crash. There is now an owner, a deadline, a
  heartbeat, and reapers for expired leases and orphan batches.
- **The seat loop was serial and unsharded**: at 1,000 tenants it needed roughly
  500 hours of work per 60-second tick, so the queue drained at about two seats
  a minute and the last tenant was never reached. Sharded, bounded, and ordered
  so no tenant monopolises a pass.
- **The discovery query had no serving index and failed silently** -- on
  timeout it returned an empty list, stopping the deployment's entire LinkedIn
  queue with no alert. Indexed, bounded, and now loud.
- **The safety gate ran 11 sequential round trips per action** (1.4M per tick at
  5,000 seats through a 10-connection pool); it is one CTE plus two reads, with
  every check's meaning and wording unchanged.
- N+1 loops in inbox sync, withdrawal sync, the campaign runner and lead import;
  unbounded reads; a whole-workspace ledger read into a JS Set; a 32-bit
  advisory lock that collided across tenants at ~10k workspaces.
- One live Chromium per seat was retained for the process's life (a 16GB host
  died at ~25-40 seats), and a failed launch leaked both the browser and the
  profile lock that permanently blocked that seat.

---

## What is still open, and what it costs

1. **One master key still derives every tenant's key.** Per-workspace derivation
   limits row portability, not a master-key leak. The honest upgrade is KMS/HSM;
   the derivation function is the single swap point.
2. **Workers hold the whole multi-tenant database.** A worker is `openDatabase()`
   on `DATABASE_URL` with no token and no scoped credential. Acceptable only
   while every worker is inside the trust boundary.
3. **The OTP/challenge round-trip is process-affine.** The live page lives in a
   module-level map, and the operator's code arrives on a second HTTP call that
   must reach the same replica. With more than one API pod, seats can wedge in
   `otp_required`. Tests never catch it, because every test injects the page.
4. **Retention has no story.** Nothing expires: message bodies, harvested
   strangers, `original_json` holding the raw CSV row verbatim, export blobs.
   Erasure on request exists; scheduled retention does not.
5. **Agencies have no client dimension.** Lead dedupe and account uniqueness are
   per workspace, so one workspace running two clients holds each person once.

Hosted execution itself is no longer process-affine: migration 065 externalises
browser `storageState` into the row-bound secrets envelope and records a
per-workspace acknowledgement, so a remote browser runner can resume a seat on
another host. Migration 076 also moves credential-bearing per-seat proxy URLs
out of `linkedin_seats` plaintext and into the same row-bound custody model.
The release job refuses traffic while `schema_hardening_deferred` is non-empty,
so staged tenant constraints are now a deployment blocker rather than silent
technical debt.

---

## Migrations added by this pass

`053` lead-list deletion (list_id nullable, `SET NULL`) · `054` worker leases,
seat pinning, claim indexes · `055` index hygiene (adds five, drops four
redundant, `CONCURRENTLY`) · `056` secret row binding (`key_id`, AAD envelope
v2) · `057` workspace erasure log · `058` tenant isolation hardening (composite
FKs, `seat_key` defaults, webhook uniqueness, `lower(email)`, the ten
`workspace_id` columns) · `059` per-workspace skill usage.

Apply with `npm run db:migrate` -- boot no longer migrates on a hosted
deployment, it verifies and refuses.
