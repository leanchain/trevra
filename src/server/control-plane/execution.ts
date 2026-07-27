import { createHmac } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { z } from 'zod';
import type { Db } from '../db.js';
import { stableJson } from './payload.js';
import { executeConnectedAction } from '../integration-service.js';

export type ExecutionActionType = string;

const actionTypeSchema = z.string().regex(/^[a-z][a-z0-9_.-]{2,119}$/);

const emailPayloadSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  metadata: z.record(z.unknown()).optional()
});

const invoicePayloadSchema = z.object({
  recipient: z.string().email(),
  amount: z.number().positive().max(10_000_000),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  description: z.string().min(1).max(500),
  dueDays: z.number().int().min(0).max(365).default(14),
  message: z.string().max(20_000).default('')
});

const changeOrderPayloadSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  amount: z.number().nonnegative().max(10_000_000),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  description: z.string().min(1).max(500)
});

const remoteActionAdapterSchema = z.object({
  actionType: actionTypeSchema,
  endpoint: z.string().url(),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
  provider: z.string().trim().min(1).max(100).optional(),
  timeoutSeconds: z.number().int().min(1).max(300).default(30),
  payloadSchema: z.record(z.unknown()).optional()
});

export type RemoteActionAdapterConfig = z.infer<typeof remoteActionAdapterSchema>;

export async function executePreparedPlaybookAction(
  db: Db,
  input: {
    workspaceId: string;
    actionType: ExecutionActionType;
    payload: unknown;
    payloadHash: string;
  }
): Promise<{ provider: string; externalRef: string; actionType: ExecutionActionType }> {
  const actionType = actionTypeSchema.parse(input.actionType);
  if (actionType === 'email.send') {
    const payload = emailPayloadSchema.parse(input.payload);
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'email_draft',
      recipient: payload.recipient,
      subject: payload.subject,
      body: payload.body,
      structured_payload_json: JSON.stringify(payload.metadata ?? {}),
      payload_hash: input.payloadHash
    });
    return { ...delivery, actionType };
  }
  if (actionType === 'invoice.create') {
    const payload = invoicePayloadSchema.parse(input.payload);
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'invoice_draft',
      recipient: payload.recipient,
      subject: payload.description,
      body: payload.message,
      structured_payload_json: JSON.stringify({
        recipient: payload.recipient,
        amount: payload.amount,
        currency: payload.currency,
        description: payload.description,
        dueDays: payload.dueDays
      }),
      payload_hash: input.payloadHash
    });
    return { ...delivery, actionType };
  }
  if (actionType === 'change_order.create') {
    const payload = changeOrderPayloadSchema.parse(input.payload);
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'change_order_draft',
      recipient: payload.recipient,
      subject: payload.subject,
      body: payload.body,
      structured_payload_json: JSON.stringify({
        recipient: payload.recipient,
        amount: payload.amount,
        currency: payload.currency,
        description: payload.description
      }),
      payload_hash: input.payloadHash
    });
    return { ...delivery, actionType };
  }

  const adapter = listRemoteActionAdapters().find((candidate) => candidate.actionType === actionType);
  if (!adapter) throw new Error(`No approved action adapter is configured for ${actionType}`);
  validateRemotePayload(adapter, input.payload);
  const delivery = await executeRemoteActionAdapter(adapter, {
    workspaceId: input.workspaceId,
    actionType,
    payload: input.payload,
    payloadHash: input.payloadHash
  });
  return { ...delivery, actionType };
}

export function listRemoteActionAdapters(env: NodeJS.ProcessEnv = process.env): RemoteActionAdapterConfig[] {
  const raw = env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('TREVRA_REMOTE_ACTION_ADAPTERS_JSON must contain valid JSON'); }
  const adapters = z.array(remoteActionAdapterSchema).max(100).parse(parsed);
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.actionType)) throw new Error(`Duplicate remote action adapter: ${adapter.actionType}`);
    seen.add(adapter.actionType);
    const endpoint = new URL(adapter.endpoint);
    if (env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
      throw new Error(`Remote action adapter ${adapter.actionType} must use HTTPS in production`);
    }
  }
  return adapters;
}

async function executeRemoteActionAdapter(
  adapter: RemoteActionAdapterConfig,
  input: { workspaceId: string; actionType: string; payload: unknown; payloadHash: string }
): Promise<{ provider: string; externalRef: string }> {
  const token = process.env[adapter.tokenEnv]?.trim();
  if (!token) throw new Error(`Remote action adapter ${adapter.actionType} requires ${adapter.tokenEnv}`);
  const body = {
    actionType: input.actionType,
    workspaceId: input.workspaceId,
    idempotencyKey: input.payloadHash,
    payload: input.payload
  };
  const serialized = stableJson(body);
  const signature = createHmac('sha256', token).update(serialized).digest('hex');
  const response = await fetch(adapter.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Trevra-Action': input.actionType,
      'X-Trevra-Idempotency-Key': input.payloadHash,
      'X-Trevra-Signature': `sha256=${signature}`
    },
    body: serialized,
    redirect: 'error',
    signal: AbortSignal.timeout(adapter.timeoutSeconds * 1000)
  });
  const result = await response.json().catch(() => ({ error: response.statusText })) as {
    provider?: unknown;
    externalRef?: unknown;
    id?: unknown;
    error?: unknown;
  };
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Action adapter returned ${response.status}`);
  const externalRef = result.externalRef ?? result.id;
  if (typeof externalRef !== 'string' || !externalRef.trim()) {
    throw new Error(`Remote action adapter ${adapter.actionType} returned no external reference`);
  }
  return {
    provider: typeof result.provider === 'string' && result.provider.trim() ? result.provider : adapter.provider ?? 'custom',
    externalRef
  };
}

function validateRemotePayload(adapter: RemoteActionAdapterConfig, payload: unknown): void {
  if (!adapter.payloadSchema) return;
  let validator: ValidateFunction;
  try { validator = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true }).compile(adapter.payloadSchema); }
  catch (error) {
    throw new Error(`Payload schema for ${adapter.actionType} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (validator(payload)) return;
  const issues = (validator.errors ?? []).map((item) => `${item.instancePath || '/'} ${item.message ?? 'is invalid'}`).join('; ');
  throw new Error(`Payload for ${adapter.actionType} failed validation: ${issues}`);
}
