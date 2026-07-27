# Temporal orchestration

Trevra supports two durable orchestration modes without changing playbook definitions or agent APIs.

## PostgreSQL mode

```env
TREVRA_ORCHESTRATOR=postgres
```

The standalone worker claims persisted steps through PostgreSQL leases. This is the default self-hosted mode and requires no additional service.

## Temporal mode

```env
TREVRA_ORCHESTRATOR=temporal
TEMPORAL_ADDRESS=<frontend-address>
TEMPORAL_NAMESPACE=<namespace>
TEMPORAL_TASK_QUEUE=trevra-playbooks
TEMPORAL_TLS=true
TEMPORAL_API_KEY=<optional-cloud-api-key>
```

The API starts or signals a Temporal workflow. A separate Trevra worker hosts the activity implementation. Run it independently from the API:

```bash
npm run start:worker
```

Approval steps wait on a workflow signal. Skill and action state remains persisted in PostgreSQL, so Trevra’s ledger and browser APIs do not depend on Temporal visibility retention.

For local development, start Temporal’s development server profile and select Temporal mode:

```bash
TREVRA_ORCHESTRATOR=temporal \
docker compose --profile temporal --env-file .env.dev -f compose.dev.yml up --build
```

## Hosted process separation

Terraform provisions two Cloud Run services from the same image:

- `trevra`: public API and application;
- `trevra-worker`: internal-only, always-on worker with idle CPU disabled.

The worker command is `node dist-server/worker/index.js`. It owns Temporal polling, PostgreSQL fallback workflows, standing automation, and commercial projection updates.
