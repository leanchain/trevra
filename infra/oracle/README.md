# Trevra on Oracle Cloud Always Free

One ARM VM runs the whole stack — API, automation worker, Postgres — behind a
Cloudflare tunnel. The marketing site stays on Cloudflare Pages.

## Why this shape

Always Free gives 2 OCPU + 12 GB RAM, 200 GB block storage, and 10 TB/month
egress in the tenancy home region, permanently. That is enough to run the
existing `Dockerfile` unmodified — real Postgres, no dialect rewrite, and the
60-second automation poller costs nothing because the database is local rather
than metered per awake-hour.

Ingress is closed. `cloudflared` dials outbound and Cloudflare routes
`app.usetrevra.com` to it, so no HTTP port is ever exposed and the security
list opens only SSH.

## Known constraints

- **A1 capacity is frequently exhausted.** `Out of host capacity` on apply is
  normal; bump `availability_domain_index` and retry, or retry later.
- **Idle reclamation.** Oracle may reclaim Always Free instances averaging
  under 20% CPU, network, _and_ memory across 7 days. The Trevra worker plus
  Postgres normally keeps memory above that, but it is not guaranteed.
- **Nango has no arm64 image.** `nangohq/nango-server` publishes amd64 only,
  on every tag. Use Nango Cloud (free tier: 10 connections, 100k proxy
  requests) or accept qemu emulation via `compose.oracle.nango.yml`.
- **Home region only.** Resources created outside it are billed normally.
- **One box, no HA.** Backups and patching are yours; nothing here is managed.

## Images

`.github/workflows/image.yml` builds a multi-arch manifest (amd64 + arm64) on
native runners and publishes it to `ghcr.io/leanchain/trevra`. Nothing is built
on the instance — an E2.1.Micro has 1 GB of RAM and cannot run `tsc` + `vite`,
and the same tag works whether the box turns out to be A1 (arm64) or E2 (amd64).

`deploy.sh <ip> [tag]` defaults to the `main` tag. Pass a commit SHA to pin or
roll back.

## First deploy

```sh
cd infra/oracle/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in OCIDs, region, SSH key
terraform init
terraform apply
```

Then create the environment file **on the instance** — secrets never leave it:

```sh
IP=$(terraform output -raw public_ip)
scp ../.env.oracle.example ubuntu@$IP:/opt/trevra/.env.oracle
ssh ubuntu@$IP 'chmod 600 /opt/trevra/.env.oracle'

# generate the random values and append them, then edit the rest by hand
ssh ubuntu@$IP 'cd /opt/trevra && bash -s' < ../gen-secrets.sh >> /dev/null
```

Create the tunnel and put its token in `.env.oracle` as
`CLOUDFLARE_TUNNEL_TOKEN`, routing `app.usetrevra.com` to `http://trevra:8080`:

```sh
cloudflared tunnel create trevra
cloudflared tunnel route dns trevra app.usetrevra.com
```

Deploy:

```sh
cd .. && ./deploy.sh "$IP"
```

## Updating

The image workflow is release-gated: dependency audit, the full PostgreSQL test
suite, and the production build must pass before either architecture is
published. Prefer an immutable release/commit tag over `main` for production.

`deploy.sh` / `deploy-micro.sh` then perform a hosted-safe rollout in this
order:

1. verify the instance-local environment contains every managed-production prerequisite, including custody, OAuth, Nango, transactional SMTP and the advertised companion release version, without printing secret values;
2. create and validate a mode-0600 custom-format PostgreSQL backup;
3. pull the requested image;
4. run `dist-server/server/migrate-job.js` in the one-shot `migrate` service;
5. refuse the rollout if tenant-isolation hardening is still deferred or a
   legacy proxy credential remains plaintext;
6. only after that succeeds, recreate the API and worker and wait for health.

The running API/worker therefore do not race to mutate shared schema on boot.
They verify the database and refuse if the release job was skipped.

```sh
./deploy.sh "$IP"            # latest main
./deploy.sh "$IP" sha-abc123 # immutable tag / rollback target
```

For the two-micro layout, use `deploy-micro.sh <app-public-ip> <db-public-ip>
<db-private-ip> [tag]`; backups are stored under `/mnt/data/backups` on the DB
instance.

## Operating

```sh
ssh ubuntu@$IP
cd /opt/trevra
docker compose --env-file .env.oracle -f compose.oracle.yml ps
docker compose --env-file .env.oracle -f compose.oracle.yml logs -f trevra
```

Postgres data is on the attached block volume at `/mnt/data/postgres`, not in a
Docker volume, so destroying and recreating the instance preserves it. The
volume is only formatted when it has no filesystem.

Every deploy now creates and verifies a pre-migration custom-format backup in
`/mnt/data/backups` and retains deploy snapshots for 14 days. Keep an additional
off-instance backup schedule as well; a block-volume failure should not be able
to take both the database and every backup with it.
