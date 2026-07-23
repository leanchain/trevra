# Trevra deployment and data durability

## PostgreSQL-only policy

Trevra refuses to start without `DATABASE_URL`, and the URL must begin with `postgres://` or `postgresql://`. Both the commercial graph and Better Auth use PostgreSQL. No embedded database is present in the runtime image.

The one-time `db:migrate-sqlite` utility is deliberately outside the runtime path. It snapshots legacy files, imports them transactionally, and then leaves the original and backup files untouched for recovery.

Application migrations are stored in `migrations/` and recorded in `schema_migrations`. Startup obtains a transaction-scoped PostgreSQL advisory lock before checking or applying migrations. This permits several Cloud Run instances to start concurrently without applying the same migration twice.

## Local development stack

`compose.dev.yml` deliberately uses uncommon, independently configurable host ports from `.env.dev` and two PostgreSQL databases:

- `postgres`: Trevra and Better Auth data;
- `nango-db`: Nango provider configuration, encrypted credentials, sync records, and internal state.

This keeps Nango infrastructure failures and schema changes outside Trevra's commercial ledger. Redis is also isolated to Nango.

Persistent Docker volumes:

- `trevra-postgres-data`;
- `nango-postgres-data`;
- `nango-redis-data`;
- `trevra-node-modules`.

Internal container ports remain standard, while host ports use the `TREVRA_*_PORT` and `NANGO_*_PORT` variables. This allows several Trevra-like stacks to coexist without changing service-to-service URLs.

Do not run `docker compose down -v` unless you intend to destroy all local data.

## Cloud Run and Cloud SQL

The Terraform configuration mounts Cloud SQL at `/cloudsql` and injects a PostgreSQL Unix-socket URL from Secret Manager. The runtime service account receives only Cloud SQL Client and access to Trevra's named secrets.

Cloud SQL is configured with:

- PostgreSQL 16;
- regional high availability;
- SSD storage with autoresize;
- automated backups;
- 14 retained backups;
- seven days of point-in-time recovery logs;
- Query Insights;
- deletion protection by default.

Keep Cloud Run and Cloud SQL in the same region. Size the connection pool using:

```text
maximum possible connections ≈ Cloud Run max instances × DATABASE_POOL_MAX
```

Leave headroom for Better Auth, migrations, administration, and failover. Trevra defaults to ten application connections and five Better Auth connections per instance. Reduce these values before increasing Cloud Run's maximum instance count.

## Terraform state

Generated database and application secrets are represented in Terraform state. `infra/gcp/backend.tf` therefore requires an encrypted, versioned GCS backend. Run `infra/gcp/bootstrap.sh` before `infra/gcp/deploy.sh`.

Restrict access to the state bucket. Do not copy state files into source control or developer chat systems.

## Custom domains and Google OAuth

`APP_ORIGIN` and `BETTER_AUTH_URL` must be final HTTPS origins. Configure the Cloud Run custom domain or external HTTPS load balancer before enabling production sign-in callbacks.

Create a Google OAuth Web application client with:

- Authorized JavaScript origin: the exact `APP_ORIGIN`, such as `https://app.example.com`;
- Authorized redirect URI: `${BETTER_AUTH_URL}/api/auth/callback/google`, such as `https://app.example.com/api/auth/callback/google`.

The scheme, host, port, path, and trailing slash behavior must match exactly. The GCP deploy script requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; Terraform stores both in Secret Manager and injects them into Cloud Run. Google login uses only identity scopes (`openid`, `email`, `profile`). Workspace Gmail and Calendar access remains a separate Nango authorization.

Nango needs browser-reachable HTTPS endpoints for its API/dashboard and Connect UI. `NANGO_HOST` and `NANGO_PUBLIC_SERVER_URL` should point to the public Nango API origin from Trevra's production environment.

## Self-hosted Nango

The repository includes:

- `compose.dev.yml` for local Nango;
- `compose.nango.production.yml` for a long-running production host;
- `.env.nango.production.example` for required configuration.

The production Compose stack expects:

- a Nango-specific Cloud SQL PostgreSQL instance or database;
- a Redis endpoint such as Memorystore;
- a VM service account with Cloud SQL Client permission;
- an HTTPS reverse proxy or load balancer;
- durable backups of the Nango encryption key.

Do not use Trevra's PostgreSQL database credentials for Nango. A shared Cloud SQL instance may be acceptable at very small scale, but use separate databases and users at minimum. A separate instance gives stronger resource and failure isolation.

Pin the Nango image to a tested version or immutable digest before production. Review the licensing and feature set of the selected self-hosted Nango edition.

## Backup and restore controls

Cloud SQL backups are not sufficient until restore is tested. Recommended routine:

1. Keep automated backups and PITR enabled.
2. Create an on-demand backup before risky application or provider migrations.
3. Export logical backups periodically to a bucket with retention and object versioning.
4. Restore into an isolated instance at least quarterly.
5. Run application health checks and row-count/business invariants against the restored instance.
6. Document recovery point and recovery time results.

Nango's PostgreSQL data and encryption key must be backed up together. A database restore without the matching encryption key cannot decrypt stored provider credentials.

## Deployment order

1. Create DNS names for Trevra and Nango.
2. Deploy and secure the Nango production stack.
3. Configure Nango providers, callbacks, and Trevra canonical sync/action functions.
4. Record the Nango API key and webhook signing key.
5. Bootstrap the Terraform state bucket.
6. Deploy Trevra through `infra/gcp/deploy.sh`.
7. Map the Trevra custom domain and verify Better Auth callbacks.
8. Point Nango webhooks to `https://<trevra-domain>/api/webhooks/nango`.
9. Point Stripe webhooks to `https://<trevra-domain>/api/webhooks/stripe` when enabled.
10. Perform an end-to-end test with provider sandbox accounts.

## Cloud Run Compose reference

`compose.gcp.yml` demonstrates the requested Cloud Run multi-container shape with a Cloud SQL Auth Proxy sidecar. Cloud Run Compose support is useful for previews and simple deployments, but the Terraform resources are the maintained production configuration because they express Cloud SQL HA, backups, IAM, Secret Manager, deletion protection, and remote state explicitly.
