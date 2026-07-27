import * as k8s from '@kubernetes/client-node';
import { createHash } from 'node:crypto';
import type { InstalledCommunityModule } from '../server/sandbox/community-runtime.js';

export async function executeKubernetesOciModule(module: InstalledCommunityModule, input: unknown): Promise<unknown> {
  if (module.runtime !== 'oci') throw new Error('Kubernetes sandbox currently accepts OCI releases only');
  if (!module.artifactRef.includes(`@${module.artifactDigest}`)) throw new Error('OCI image must be digest-pinned');
  if (module.manifest.permissions.network.length > 0) {
    throw new Error('Networked OCI modules require a dedicated FQDN-aware network-policy backend');
  }
  if (module.manifest.permissions.secrets.length > 0) {
    throw new Error('Kubernetes OCI modules with secret permissions require a dedicated secret broker');
  }

  const namespace = process.env.TREVRA_SANDBOX_NAMESPACE?.trim() || 'trevra-sandbox';
  const runtimeClassName = process.env.TREVRA_SANDBOX_RUNTIME_CLASS?.trim() || 'gvisor';
  const name = `trv-${createHash('sha256').update(`${module.id}:${module.version}:${Date.now()}:${Math.random()}`).digest('hex').slice(0,20)}`;
  const labels = { 'app.kubernetes.io/name': 'trevra-module', 'trevra.io/execution': name };
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  const batch = kc.makeApiClient(k8s.BatchV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const inputJson = JSON.stringify(input);
  if (Buffer.byteLength(inputJson) > 900_000) throw new Error('Kubernetes sandbox input exceeds 900 KB');

  const job: k8s.V1Job = {
    metadata: { name, namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: module.manifest.resources.timeoutSeconds,
      ttlSecondsAfterFinished: 60,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          runtimeClassName,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' }
          },
          containers: [{
            name: 'module',
            image: module.artifactRef,
            imagePullPolicy: 'IfNotPresent',
            args: module.manifest.entrypoint,
            env: [
              { name: 'TREVRA_MODULE_INPUT_B64', value: Buffer.from(inputJson).toString('base64') },
              { name: 'TREVRA_MODULE_ID', value: module.id },
              { name: 'TREVRA_MODULE_VERSION', value: module.version }
            ],
            resources: {
              requests: { cpu: String(module.manifest.resources.cpu), memory: `${module.manifest.resources.memoryMb}Mi` },
              limits: { cpu: String(module.manifest.resources.cpu), memory: `${module.manifest.resources.memoryMb}Mi` }
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              privileged: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] }
            },
            volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }]
          }],
          volumes: [{ name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }]
        }
      }
    }
  };

  await batch.createNamespacedJob({ namespace, body: job });
  try {
    const deadline = Date.now() + (module.manifest.resources.timeoutSeconds + 15) * 1000;
    let failedMessage = '';
    while (Date.now() < deadline) {
      const current = await batch.readNamespacedJobStatus({ name, namespace });
      if ((current.status?.succeeded ?? 0) > 0) break;
      if ((current.status?.failed ?? 0) > 0) {
        failedMessage = current.status?.conditions?.find((condition) => condition.type === 'Failed')?.message ?? 'Sandbox job failed';
        throw new Error(failedMessage);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (Date.now() >= deadline) throw new Error('Kubernetes sandbox job timed out');
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `trevra.io/execution=${name}` });
    const podName = pods.items[0]?.metadata?.name;
    if (!podName) throw new Error('Sandbox pod was not found');
    const log = await core.readNamespacedPodLog({ name: podName, namespace, container: 'module', follow: false, limitBytes: module.manifest.resources.maxOutputBytes });
    if (Buffer.byteLength(log) > module.manifest.resources.maxOutputBytes) throw new Error('Sandbox output exceeded the declared limit');
    try { return JSON.parse(log.trim()); }
    catch { throw new Error(`Sandbox output must be one JSON value; received: ${log.slice(0,500)}`); }
  } finally {
    await batch.deleteNamespacedJob({ name, namespace, gracePeriodSeconds: 0, propagationPolicy: 'Background' }).catch(() => undefined);
  }
}
