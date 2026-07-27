# Community module sandbox

Untrusted community code never executes inside the Trevra API or workflow worker process.

## Gateway protocol

The product runtime sends signed release metadata and JSON input to a separate gateway:

```text
POST /v1/execute
Authorization: Bearer <sandbox-gateway-token>
```

The gateway has no Trevra database credentials. It validates the request, enforces the signed resource contract, executes the artifact, captures one bounded JSON output, and returns it to the control plane.

Configure the product runtime:

```env
TREVRA_SANDBOX_GATEWAY_URL=https://sandbox.example.com
TREVRA_SANDBOX_GATEWAY_TOKEN=<at-least-32-random-characters>
```

Run the gateway process:

```bash
PORT=43987 \
TREVRA_SANDBOX_GATEWAY_TOKEN='<token>' \
npm run sandbox:start
```

## Kubernetes and gVisor

Set `TREVRA_SANDBOX_BACKEND=kubernetes` on the gateway. OCI releases are scheduled as one-shot Kubernetes Jobs with:

- a digest-pinned image;
- a configured gVisor RuntimeClass;
- no service-account token in the module pod;
- restricted Pod Security Standards;
- non-root UID and GID;
- read-only root filesystem;
- all Linux capabilities dropped;
- no privilege escalation;
- fixed CPU, memory, PID, output, and deadline limits;
- a memory-only `/tmp` volume;
- namespace-wide default-deny ingress and egress.

Create the bearer-token Secret, replace the gateway image with your published Trevra image, then apply the trusted gateway Deployment, sandbox namespace, restricted RBAC, and default network policy:

```bash
kubectl -n trevra-system create secret generic trevra-sandbox-gateway \
  --from-literal=token='<at-least-32-random-characters>'

kubectl apply -f infra/sandbox/kubernetes.yaml
```

Expose the ClusterIP service only through private networking to the Trevra worker. Do not publish the gateway directly to the internet.

The gateway runs in `trevra-system`; untrusted Jobs run in the separate default-deny `trevra-sandbox` namespace. Its cross-namespace service account can create, inspect, read logs from, and delete Jobs only in the sandbox namespace.

Networked OCI modules are rejected by default because standard Kubernetes NetworkPolicy cannot safely express domain allowlists. Use a separately reviewed FQDN-aware policy backend before permitting them. Signed `remote` modules may call only the exact HTTPS hostname declared in their manifest and cannot request secrets without a dedicated secret broker.

## Local runtimes

For development, the gateway also supports:

- OCI execution through `TREVRA_CONTAINER_RUNTIME`, default `docker`;
- WASI execution through `TREVRA_WASI_RUNTIME`, default `wasmtime`.

Local OCI execution uses no network, a read-only filesystem, dropped capabilities, no-new-privileges, an unprivileged user, resource limits, and digest-pinned images. WASI artifacts are SHA-256 verified before execution.

## Module input contract

OCI sandbox Jobs receive input as base64 JSON in `TREVRA_MODULE_INPUT_B64`. The process must emit exactly one JSON value on stdout. Logs beyond the declared output limit terminate the run.
