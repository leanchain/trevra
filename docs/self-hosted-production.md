# Single-operator production

This deployment is for one operator on one machine. It uses the production build, a dedicated PostgreSQL volume, a one-shot migration job, a long-lived API container, and a separate worker container.

## Security boundary

The app is published on `127.0.0.1` only. The browser uses `http://localhost:<port>`, which is the only production case where Trevra permits non-TLS cookies and an HTTP public URL. If any app/auth/public URL is a LAN or public address, production validation refuses to boot without HTTPS and secure cookies.

The containers run read-only, with a tmpfs for `/tmp`, all Linux capabilities dropped, and `no-new-privileges`. PostgreSQL is not published to the host. Browser automation is off inside the production containers by default; turn it on only when you deliberately configure your own local worker/session.

## Deploy

```bash
./scripts/selfhost-deploy.sh
```

On the first run `scripts/selfhost-init.sh` creates `.env.selfhost` with random database, auth, token-pepper, ingestion, and AES-256-GCM secret material. The file is gitignored and mode `0600`. Later deploys keep it unchanged so encrypted credentials remain decryptable.

The deployment order is PostgreSQL -> migration job -> API + worker. Both long-lived services have health checks and `restart: unless-stopped`.

Check it with:

```bash
docker compose --env-file .env.selfhost -f compose.selfhost.yml ps
curl -fsS http://localhost:43900/api/health
```

## Backups

Create a PostgreSQL custom-format dump with:

```bash
./scripts/selfhost-backup.sh
```

Backups default to `./backups/` and mode `0600`. Copy them to a separate disk or encrypted backup destination; a backup stored only beside the live database is not a disaster-recovery copy. Keep `.env.selfhost` (especially `TREVRA_SECRETS_KEY`) backed up separately as well, because encrypted workspace secrets cannot be recovered without it.

## Integrations

Nango is optional in this single-operator mode. With both `NANGO_API_KEY` and `NANGO_WEBHOOK_SIGNING_KEY` empty, the core product runs and `/api/health` reports integrations disabled. If either value is configured, production validation requires both. Hosted/multi-tenant production continues to require Nango.

## Remote access

Do not change the port binding from `127.0.0.1` to `0.0.0.0` and continue using HTTP. For access from another machine, place a trusted HTTPS reverse proxy or VPN in front, change `APP_ORIGIN`, `BETTER_AUTH_URL`, and `PUBLIC_SITE_URL` to that HTTPS origin, and set `COOKIE_SECURE=true`.
