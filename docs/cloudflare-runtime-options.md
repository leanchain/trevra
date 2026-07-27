# Cloudflare Runtime Options Research — 2026-07-27

## Summary of Findings

Cloudflare offers several deployment options for a Node.js/Express + PostgreSQL application, each with distinct trade-offs. **Workers + Hyperdrive** is the lowest-effort path for a stateless API layer, but comes with architectural constraints (10 ms CPU per request on Free, 30 s default on Paid). **Containers** is the most permissive option for existing applications, supporting arbitrary Docker images and long-running processes, but adds significant cost. **D1** is SQLite-only and not a PostgreSQL replacement. **Durable Objects/Queues/Cron** are powerful for scheduling and async work but not designed as a job orchestrator replacement.

---

## 1. Cloudflare Workers + Express Compatibility

### Can Express run on Workers today?

**Short answer: No. A full Express rewrite is required.**

**Sources:**
- Node.js compatibility docs: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ (Last updated Jul 1, 2026)
- Workers overview: https://developers.cloudflare.com/workers/ (Last updated Apr 23, 2026)

**Details:**

The `nodejs_compat` compatibility flag (available when `compatibility_date: "2024-09-23"` or later) provides:
- **Fully supported**: `node:crypto`, `node:path`, `node:buffer`, `node:stream`, `node:events`, `node:http`, `node:https`, `node:net`, `node:url`, `node:util`, `node:zlib`, `node:timers`, and many others.
- **Partially supported**: `node:fs`, `node:dns`, `node:os`, `node:module`, `node:console`, `node:test`.
- **Stub modules (nonfunctional)**: `node:vm`, `node:cluster`, `node:domain`, `node:inspector`, `node:child_process`, `node:worker_threads`, etc.

**What breaks with Express:**

Express.js relies on several Node.js APIs that are partially or not supported:

1. **Filesystem (`node:fs`)** — Only partially supported. Express static file serving expects full filesystem access; this doesn't work in the Workers runtime sandbox.
2. **HTTP Server Creation** — While `node:http` and `node:https` are listed as "supported," Express's `app.listen()` pattern creates an actual HTTP server, which is not how Workers function. Workers execute within a request/response handler model, not a persistent server model.
3. **Global scope constraints** — Express middleware expects to run in a persistent process context. Workers isolate each request to a fresh invocation with a 1-second startup time limit for global scope.

**Verdict:** Express requires a **complete rewrite** to adapt to the Workers request/response model. 

**Alternative:** Cloudflare recommends **Hono** (https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/) or **itty-router** as lightweight frameworks designed for the Workers model. Hono is production-ready and supports TypeScript/ESM natively.

---

## 2. PostgreSQL from Cloudflare Workers

### Supported paths for database access

**Source:** Hyperdrive overview (https://developers.cloudflare.com/hyperdrive/) — Last updated Jun 22, 2026; TCP sockets (https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) — Last updated Jun 19, 2026.

Three paths exist:

#### A. Hyperdrive (Recommended)

**What it does:**
- Global connection pooling and query caching layer for existing PostgreSQL or MySQL databases
- Accelerates queries by caching common queries and pooling connections across Cloudflare's edge
- Works with any external Postgres (AWS RDS, Google Cloud SQL, Neon, PlanetScale, CockroachDB, Timescale)

**Does `pg` package work unmodified?**
- **Yes**, with `nodejs_compat` enabled. Code example from official docs:
  ```typescript
  import { Client } from "pg";
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
  });
  await client.connect();
  const result = await client.query("SELECT * FROM pg_tables");
  ```
- The `pg` driver is instantiated per-request (new isolation per Worker invocation), but Hyperdrive maintains the underlying connection pool.

**Postgres providers supported:**
- AWS RDS PostgreSQL
- Google Cloud SQL PostgreSQL
- Neon
- PlanetScale (Postgres and MySQL variants)
- CockroachDB (Postgres-compatible)
- Timescale (Postgres-compatible)
- Any self-hosted Postgres accessible over TCP

**Does Cloudflare sell managed PostgreSQL?**
- **No.** Cloudflare does not offer managed Postgres. The database must live elsewhere (Neon, Supabase, self-hosted, etc.). Hyperdrive is a reverse-proxy caching layer in front of your existing database.

**Pricing:**
- Hyperdrive is free with the Workers Free plan (100,000 queries/day limit). Unlimited on Workers Paid plan ($5/month base). No additional charges for connection pooling or caching.

#### B. TCP sockets via `cloudflare:sockets`

**What it does:**
- Direct TCP socket API for outbound connections from Workers
- Allows raw PostgreSQL wire protocol communication

**Source:** https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ — Last updated Jun 19, 2026.

**Code pattern:**
```typescript
import { connect } from 'cloudflare:sockets';
const socket = connect({ hostname: "pg.example.com", port: 5432 });
// Manually speak PostgreSQL wire protocol
```

**Does `pg` work?**
- **Partially.** The `pg` npm package is designed to create a TCP socket internally and speak the Postgres wire protocol. In theory, it should work, but:
  - Each Worker invocation is short-lived (no persistent connections)
  - The `pg` package expects connection pooling at the driver level
  - Practical limitation: the connection is re-established per request, incurring handshake overhead
  - **Recommendation:** Use Hyperdrive instead, which abstracts this away

**Constraints:**
- Cannot connect to Cloudflare IP ranges (blocked by runtime)
- Cannot connect to `localhost` or private IPs
- Each open TCP socket counts toward the 6 concurrent open connections limit (per request)

#### C. No native PostgreSQL in D1

**D1 is SQLite-only.** See Section 5 for details.

### Summary table: PostgreSQL access methods

| Method          | Setup Effort | Performance | Connection pooling | Caching | Cost          | Best for                     |
| --------------- | ------------ | ----------- | ------------------ | ------- | ------------- | ---------------------------- |
| Hyperdrive      | Low          | Good        | Built-in (edge)    | Yes     | Free/included | Production, existing Postgres |
| TCP socket      | High         | Poor        | Manual/none        | No      | Free          | Custom protocols             |
| Cloud SQL proxy | High         | Variable    | Depends on proxy   | No      | External cost | Google Cloud deployments     |

---

## 3. Cloudflare Containers

### Current Status

**GA (Generally Available).** Not beta, not waitlist.

**Source:** Containers overview (https://developers.cloudflare.com/containers/) — Last updated Jun 8, 2026.

### Can it run an arbitrary Docker image?

**Yes.** Cloudflare Containers runs Docker images with:
- Build from `Dockerfile`
- Push to Cloudflare's managed registry or external registries (Docker Hub, ECR, Google Artifact Registry)
- Instances spawned on-demand and controlled by Worker code

### CPU, Memory, Runtime Limits

**Source:** Containers limits (https://developers.cloudflare.com/containers/platform-details/limits/) — Last updated Jul 3, 2026.

**Instance types (predefined):**
| Instance Type | vCPU  | Memory  | Disk   |
| ------------- | ----- | ------- | ------ |
| lite          | 1/16  | 256 MiB | 2 GB   |
| basic         | 1/4   | 1 GiB   | 4 GB   |
| standard-1    | 1/2   | 4 GiB   | 8 GB   |
| standard-2    | 1     | 6 GiB   | 12 GB  |
| standard-3    | 2     | 8 GiB   | 16 GB  |
| standard-4    | 4     | 12 GiB  | 20 GB  |

**Account-level limits:**
- Concurrent memory: 6 TiB
- Concurrent vCPU: 1,500
- Concurrent disk: 30 TB
- Image size: up to instance disk space
- Total image storage per account: 50 GB

**Runtime duration:**
- **No hard limit.** Containers can run indefinitely; you pay per 10 ms of active time.
- Ideal for long-running processes (database migrations, background workers, etc.)

**Long-running processes?**
- **Yes.** Unlike Workers (request-scoped), Containers are persistent (per instance). A container can serve multiple requests or run continuously. Scales to zero when idle (after configurable `sleepAfter` timeout, e.g., `"10m"`).

### Pricing

**Source:** Containers pricing (https://developers.cloudflare.com/containers/pricing/) — Last updated Apr 21, 2026.

**Billed on:**
1. **vCPU time:** $0.000020 per additional vCPU-second (375 vCPU-minutes/month included on Paid plan)
2. **Memory:** $0.0000025 per additional GiB-second (25 GiB-hours/month included on Paid plan)
3. **Disk:** $0.00000007 per additional GB-second (200 GB-hours/month included on Paid plan)
4. **Egress:** $0.025–$0.04 per GB (depending on region; 500 GB–1 TB/month included)
5. **Workers + Durable Objects overhead:** Each container has a backing Durable Object; Workers request overhead applies.

**Effort to bring up:**
- Build Docker image locally: standard Docker process
- Push to registry: `wrangler containers push`
- Deploy: add to `wrangler.toml` config + `wrangler deploy`

---

## 4. Workers Runtime Limits

### CPU Time

**Source:** Limits (https://developers.cloudflare.com/workers/platform/limits/) — Last updated Jul 5, 2026.

| Metric                  | Workers Free | Workers Paid (default) | Workers Paid (max) |
| ----------------------- | ------------ | ---------------------- | ------------------ |
| CPU per HTTP request    | 10 ms        | 30 seconds             | 5 minutes          |
| CPU per Cron Trigger    | 10 ms        | 30 seconds (< 1h)      | 15 min (>= 1h)     |
| CPU per Queue Consumer  | (same as HTTP) | (same as HTTP)         | (same as HTTP)     |

**Impact on this app:**
- Express middleware chains and request parsing on Free plan: **not viable** (10 ms is ~5–10 middleware functions max).
- Paid plan default (30 s): sufficient for most API requests and database queries.
- Can increase to 5 minutes per request via configuration.

### Wall-Clock Duration (wall time)

| Invocation Type      | Limit       |
| -------------------- | ----------- |
| HTTP request         | Unlimited   |
| Cron Trigger         | 15 minutes  |
| Queue Consumer       | 15 minutes  |
| Durable Object Alarm | 15 minutes  |

**Impact:**
- HTTP requests can stream indefinitely (client must stay connected).
- Long-running batch jobs (via Cron, Queues, or alarms) have a hard 15-minute cap.

### Subrequests

**Source:** Limits (https://developers.cloudflare.com/workers/platform/limits/).

| Tier         | Per Invocation |
| ------------ | -------------- |
| Workers Free | 50             |
| Workers Paid | 10,000 default (up to 10 million with custom config) |

**Impact on this app:**
- Outbound HTTPS fetches to third-party APIs with SSRF revalidation: each redirect hop counts as one subrequest.
- With `redirect: 'manual'`, you manually follow each hop, so a 5-hop redirect chain = 5 subrequests.
- Free plan: 50 total subrequests per Worker invocation is tight for a chatty microservice.
- Paid plan: 10,000 default is ample.

### Simultaneous Open Connections

**Source:** Limits.

| Limit                   | Value |
| ----------------------- | ----- |
| Connections waiting for response headers | 6 per invocation |

**Impact:**
- A Worker can have many connections open once headers arrive.
- While waiting for headers (initial connection establishment), only 6 at a time.
- TCP socket connections to Postgres via Hyperdrive count here.
- For a typical single-request flow (one to DB, maybe one to external API), not a constraint.

### Memory

| Limit            | Value |
| ---------------- | ----- |
| Per isolate      | 128 MB |

**Impact:**
- Loading a large npm bundle (e.g., ORM) + in-flight request state in memory is tight.
- Streaming responses and using `TransformStream` is necessary to avoid buffering entire payloads.

### Long-running background work viability

**Verdict: Not ideal on Workers alone.**

- **Cron Triggers:** 15-minute wall-clock limit per invocation. Insufficient for long multi-step jobs (e.g., Temporal orchestration).
- **Queues:** 15-minute limit per consumer invocation. Same constraint.
- **Durable Objects:** Can stay alive indefinitely if actively receiving requests, but are billed for duration. Good for real-time coordination, not batch orchestration.
- **Workflows (newer):** See Section 6.

---

## 5. D1: SQLite, Not PostgreSQL

### Can D1 replace PostgreSQL?

**No. D1 is SQLite-only; no Postgres compatibility.**

**Source:** D1 overview (https://developers.cloudflare.com/d1/) — Last updated Apr 30, 2026.

**What D1 is:**
- Serverless SQL database with SQLite's SQL semantics
- Managed disaster recovery and point-in-time recovery ("Time Travel") to any minute in the last 30 days
- Read replication for scaling reads globally
- Pricing based on rows read/written, not queries

**Migration effort:**
- **Full rewrite.** PostgreSQL schemas use features not in SQLite:
  - No native JSON/JSONB types (SQLite 3.38+ has JSON1 extension, but D1 does not expose all functions)
  - No native UUID type (must use TEXT)
  - No native enum type
  - No window functions (depending on SQLite version D1 uses)
  - No generated/computed columns (in standard SQLite)
  - No check constraints (limited support)
  - No partial indexes, exclusion constraints, or range types

- **Driver incompatibility:** `pg` package speaks PostgreSQL wire protocol. D1 requires the D1 Client API via a Worker binding.
  ```typescript
  const db = env.DB; // D1 binding
  const { results } = await db.prepare("SELECT * FROM users").all();
  ```

**Verdict:** Porting an existing Postgres app to D1 is a **rewrite**, not a port. Not recommended unless starting from scratch.

**Pricing:**
- Free: 5 million rows read/day, 100,000 rows written/day, 5 GB storage total
- Paid: First 25 billion rows read/month included ($1K+ value), then $0.001/million rows

---

## 6. Durable Objects, Queues, Cron for Job Orchestration

### Can these replace a Postgres-backed job orchestrator (e.g., pg-boss, node-pg-boss, Temporal)?

**Partial. Use carefully.**

**Source:** 
- Durable Objects (https://developers.cloudflare.com/durable-objects/) — Last updated Jul 15, 2026
- Queues (https://developers.cloudflare.com/queues/) — Last updated Apr 21, 2026
- Cron Triggers (https://developers.cloudflare.com/workers/configuration/cron-triggers/) — Last updated Jun 20, 2026
- Workflows (https://developers.cloudflare.com/workflows/) — Last updated Jun 2, 2026

| Feature                          | Durable Objects | Queues | Cron Triggers | Workflows   |
| -------------------------------- | --------------- | ------ | ------------- | ----------- |
| **Persistent state**             | Yes (SQLite)    | No     | No            | Yes         |
| **Job durability**               | Via SQLite      | Yes    | Yes           | Yes         |
| **Automatic retries**            | No              | Yes    | No            | Yes         |
| **Multi-step workflows**         | Manual          | Manual | Manual        | **Native**  |
| **Long-running support**         | If active       | 15 min | 15 min        | Minutes+    |
| **Scheduled execution**          | Alarms (15 min) | No     | Yes           | Via step.scheduleTime() |
| **Pause/wait for external event** | No              | No     | No            | **Yes**     |
| **Cost model**                   | Per duration    | Per op | Free (5 limit) | Per step + storage |

**Workflows (Recommended for orchestration):**

**Introduced recently (GA as of 2026). Durable, multi-step applications.**

**Features:**
- Pause for external events or approvals (e.g., `step.waitForEvent('approve', { timeout: '24 hours' })`)
- Automatic retries and error handling
- Built-in observability
- No Worker CPU time or request limits (durable multi-step execution)
- Long-running (minutes to weeks, if needed)

**Pricing:**
- Requests: 10 million/month included on Paid plan, +$0.30/million
- CPU time: 30 million ms/month included, +$0.02/million ms
- Storage: 1 GB-month included, +$0.20/GB-month
- Steps: 500,000/month included, +$0.80 per 100,000

**Verdict:** If building a new orchestrator, **Workflows** is the right choice. For porting existing Temporal or pg-boss workflows, you'd need to rewrite step definitions, but the mental model is similar.

### Durable Object Alarms (for scheduled work)

- Max 15-minute duration per alarm
- Can be chained by re-scheduling
- Storage API for state (SQLite-backed, GA as of 2026)
- Use case: coordinate recurring tasks, real-time updates

### Queues (for async work)

- Guaranteed delivery
- Built-in batching and retries
- Dead Letter Queues
- Pull-based consumers (can call from outside Workers)
- 15-minute consumer invocation limit
- Use case: offload work from request path, fan-out jobs

---

## 7. Bottom-Line Recommendation Table

| Option | Effort | What must be rewritten | Estimated first-month cost | Long-running jobs | Notes |
| --- | --- | --- | --- | --- | --- |
| **Workers + Hyperdrive** | Low | Express → Hono/itty-router | $5–15/month | ❌ No (15 min Cron/Queue limit) | Best for stateless APIs. No job orchestrator. |
| **Workers + Workflows** | Low–Medium | Express → Hono, job definitions into step.do() | $5–50/month (depends on step count) | ✅ Yes (multi-step, pause/resume) | Growing recommendation. Native orchestration. |
| **Containers + Hyperdrive** | Medium | None (run Express as-is in container) | $50–300/month (container time) + $5/month Workers | ✅ Yes (persistent, no time limit) | Most permissive. Highest cost. Full Node.js runtime. |
| **Workers + Queues** | Medium | Express → Hono, rewrite job queue calls | $5–30/month | ⚠️ Partial (15 min per consumer) | Good for fan-out, fan-in patterns. Not Temporal-like orchestration. |
| **Pages + external app** | High | Nothing (keep GCP deployment) | $0–50/month | ✅ Yes (external) | Use Cloudflare only for marketing site + static assets. |

---

## 8. Could Not Verify (Honest gaps)

1. **Express-specific compatibility testing.** Cloudflare docs don't explicitly state "Express does not work." I inferred this from the HTTP server model mismatch and the recommendation to use Hono/itty-router. A community user may have found workarounds.

2. **Postgres driver full wire protocol support.** While the `pg` package is imported and instantiated in Hyperdrive examples, I did not find explicit testing results showing all features (e.g., arrays, custom types, LISTEN/NOTIFY, streaming) work end-to-end.

3. **Containers startup time and cold-start latency.** Docs mention on-demand spawning but do not publish typical cold-start times (seconds? milliseconds?). Important for request-latency-sensitive apps.

4. **Workflow step execution order guarantees under heavy concurrent load.** Docs describe the model but don't publish conflict/ordering behavior under high concurrency.

5. **Better Auth PostgreSQL adapter compatibility with Hyperdrive.** Better Auth is a newer library. I did not find a specific integration guide. Likely works (same `pg` driver underneath), but not explicitly documented.

6. **SSRF revalidation with redirect: 'manual' and subrequest counting.** The docs say each redirect counts as one subrequest, but I did not find an explicit example confirming that manual redirect following via `response.headers.get('location')` and re-fetch increments the counter per hop.

---

## Recommendation Summary

**For this specific app (Express + Postgres + Background orchestration + SSRF-safe outbound):**

1. **Short term (lift-and-shift):** Deploy to **Cloudflare Containers** (no rewrite, run Docker image as-is). Cost is $50–300/month depending on traffic. Hyperdrive for Postgres acceleration is optional but recommended.

2. **Long term (Cloudflare-native):** Rewrite Express to **Hono** on **Workers + Workflows**. Use Workflows for orchestration (replaces Temporal). Cost is $5–50/month. Hyperdrive for Postgres.

3. **Do NOT use D1** unless you're also rewriting schemas to SQLite.

4. **Do NOT rely on Cron Triggers + Queues alone** for a Temporal-like orchestrator (15-minute limit is a blocker for multi-step workflows). Use Workflows instead.

---

## Document Metadata

- **Research date:** 2026-07-27
- **Cloudflare docs versions checked:**
  - Workers overview: Apr 23, 2026
  - Node.js compatibility: Jul 1, 2026
  - Hyperdrive: Jun 22, 2026
  - TCP sockets: Jun 19, 2026
  - Limits: Jul 5, 2026
  - D1: Apr 30, 2026
  - Durable Objects: Jul 15, 2026
  - Queues: Apr 21, 2026
  - Cron Triggers: Jun 20, 2026
  - Workflows: Jun 2, 2026
  - Containers: Jun 8, 2026
  - Container Limits: Jul 3, 2026
  - Container Pricing: Apr 21, 2026
  - Workers Pricing: Jul 7, 2026
  - Hyperdrive Pricing: Jun 18, 2026
  - Hono framework guide: Apr 23, 2026

