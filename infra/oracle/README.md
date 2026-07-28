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
  under 20% CPU, network, *and* memory across 7 days. The Trevra worker plus
  Postgres normally keeps memory above that, but it is not guaranteed.
- **Nango has no arm64 image.** `nangohq/nango-server` publishes amd64 only,
  on every tag. Use Nango Cloud (free tier: 10 connections, 100k proxy
  requests) or accept qemu emulation via `compose.oracle.nango.yml`.
- **Home region only.** Resources created outside it are billed normally.
- **One box, no HA.** Backups and patching are yours; nothing here is managed.

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

`./deploy.sh <ip>` rsyncs the checkout, rebuilds natively on ARM, and restarts.
It refuses to run if `/opt/trevra/.env.oracle` is missing and never copies a
local env file over it.

## Operating

```sh
ssh ubuntu@$IP
cd /opt/trevra/src-tree/infra/oracle
docker compose --env-file /opt/trevra/.env.oracle -f compose.oracle.yml ps
docker compose --env-file /opt/trevra/.env.oracle -f compose.oracle.yml logs -f trevra
```

Postgres data is on the attached block volume at `/mnt/data/postgres`, not in a
Docker volume, so destroying and recreating the instance preserves it. The
volume is only formatted when it has no filesystem.

Back it up — nothing here does:

```sh
docker compose -f compose.oracle.yml exec -T postgres \
  pg_dump -U trevra trevra | gzip > trevra-$(date +%F).sql.gz
```
