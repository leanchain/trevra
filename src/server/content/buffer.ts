import { z } from 'zod';
import { id, type Db } from '../db.js';
import { getNango } from '../integration-service.js';

export interface BufferChannel {
  id: string;
  name: string;
  displayName: string;
  service: string;
  organizationId: string;
  organizationName: string;
  isQueuePaused: boolean;
}

export interface BufferConnectionState {
  connected: boolean;
  channels: BufferChannel[];
}

export const bufferDraftPayloadSchema = z
  .object({
    channelId: z.string().trim().min(1).max(300),
    text: z.string().trim().min(1).max(20_000),
    metadata: z
      .object({
        sourcePostId: z.string().trim().min(1).max(200),
        contentAssetId: z.string().trim().max(200).nullable().optional(),
        channelName: z.string().trim().max(300).nullable().optional(),
        mode: z.literal('draft_only').default('draft_only')
      })
      .strict()
  })
  .strict();
export type BufferDraftPayload = z.infer<typeof bufferDraftPayloadSchema>;

export class BufferDraftError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

interface BufferProxy {
  post(endpoint: string, data: unknown): Promise<unknown>;
}

interface BufferOptions {
  proxyFor?: (providerConfigKey: string, connectionId: string) => BufferProxy;
}

function productionProxy(providerConfigKey: string, connectionId: string): BufferProxy {
  const nango = getNango();
  return {
    async post(endpoint: string, data: unknown): Promise<unknown> {
      const response = await nango.post<unknown>({
        endpoint,
        providerConfigKey,
        connectionId,
        // External draft creation has its own exact-payload ledger. Do not let
        // a transport layer retry an ambiguous mutation underneath it.
        retries: 0,
        data
      });
      return response.data;
    }
  };
}

async function connectedBuffer(
  db: Db,
  workspaceId: string
): Promise<{ providerConfigKey: string; connectionId: string } | null> {
  const row = await db
    .prepare(
      `SELECT provider_config_key,external_connection_id
       FROM connections
       WHERE workspace_id=? AND provider='buffer' AND status='connected' AND is_demo=0
       ORDER BY updated_at DESC,id DESC LIMIT 1`
    )
    .get<{ provider_config_key: string; external_connection_id: string }>(workspaceId);
  return row
    ? { providerConfigKey: row.provider_config_key, connectionId: row.external_connection_id }
    : null;
}

function graphErrors(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const errors = (value as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((item) =>
      item &&
      typeof item === 'object' &&
      typeof (item as { message?: unknown }).message === 'string'
        ? String((item as { message: string }).message)
        : ''
    )
    .filter(Boolean);
}

export async function listBufferChannels(
  db: Db,
  workspaceId: string,
  options: BufferOptions = {}
): Promise<BufferConnectionState> {
  const connection = await connectedBuffer(db, workspaceId);
  if (!connection) return { connected: false, channels: [] };
  const proxy = (options.proxyFor ?? productionProxy)(
    connection.providerConfigKey,
    connection.connectionId
  );
  const organizationsResponse = (await proxy.post('/', {
    query: `query TrevraBufferOrganizations { account { organizations { id name } } }`
  })) as {
    data?: { account?: { organizations?: Array<{ id: string; name?: string | null }> } };
    errors?: Array<{ message?: string }>;
  };
  const organizationErrors = graphErrors(organizationsResponse);
  if (organizationErrors.length > 0)
    throw new BufferDraftError(
      `Buffer could not list organizations: ${organizationErrors.join('; ')}`,
      502
    );
  const organizations = organizationsResponse.data?.account?.organizations ?? [];
  const channels: BufferChannel[] = [];
  for (const organization of organizations) {
    if (!organization?.id) continue;
    const channelResponse = (await proxy.post('/', {
      query: `query TrevraBufferChannels($organizationId: OrganizationId!) {
        channels(input: { organizationId: $organizationId }) {
          id name displayName service isQueuePaused
        }
      }`,
      variables: { organizationId: organization.id }
    })) as {
      data?: {
        channels?: Array<{
          id: string;
          name?: string | null;
          displayName?: string | null;
          service?: string | null;
          isQueuePaused?: boolean | null;
        }>;
      };
      errors?: Array<{ message?: string }>;
    };
    const channelErrors = graphErrors(channelResponse);
    if (channelErrors.length > 0)
      throw new BufferDraftError(
        `Buffer could not list channels: ${channelErrors.join('; ')}`,
        502
      );
    for (const channel of channelResponse.data?.channels ?? []) {
      if (!channel?.id) continue;
      channels.push({
        id: channel.id,
        name: channel.name?.trim() || channel.displayName?.trim() || channel.id,
        displayName: channel.displayName?.trim() || channel.name?.trim() || channel.id,
        service: channel.service?.trim() || 'unknown',
        organizationId: organization.id,
        organizationName: organization.name?.trim() || organization.id,
        isQueuePaused: Boolean(channel.isQueuePaused)
      });
    }
  }
  channels.sort(
    (a, b) =>
      a.organizationName.localeCompare(b.organizationName) ||
      a.service.localeCompare(b.service) ||
      a.displayName.localeCompare(b.displayName) ||
      a.id.localeCompare(b.id)
  );
  return { connected: true, channels };
}

export async function createBufferDraft(
  db: Db,
  workspaceId: string,
  rawPayload: unknown,
  payloadHash: string,
  options: BufferOptions = {}
): Promise<{ provider: 'buffer'; externalRef: string; reused: boolean }> {
  const payload = bufferDraftPayloadSchema.parse(rawPayload);
  if (!payloadHash.trim())
    throw new BufferDraftError('Buffer draft requires an exact payload hash.');
  const sourcePost = await db
    .prepare('SELECT id FROM linkedin_posts WHERE workspace_id=? AND id=?')
    .get<{ id: string }>(workspaceId, payload.metadata.sourcePostId);
  if (!sourcePost) throw new BufferDraftError('Source post not found.', 404);

  const connection = await connectedBuffer(db, workspaceId);
  if (!connection) throw new BufferDraftError('Connect Buffer before creating a draft.', 409);

  const channelState = await listBufferChannels(db, workspaceId, options);
  if (!channelState.channels.some((channel) => channel.id === payload.channelId))
    throw new BufferDraftError('Buffer channel is not available to this workspace.', 404);

  const claimed = await db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`buffer-draft\u001f${workspaceId}\u001f${payload.channelId}\u001f${payloadHash}`);
    const existing = await tx
      .prepare(
        `SELECT id,status,external_ref,last_error FROM content_buffer_drafts
         WHERE workspace_id=? AND buffer_channel_id=? AND payload_hash=? FOR UPDATE`
      )
      .get<{ id: string; status: string; external_ref: string | null; last_error: string | null }>(
        workspaceId,
        payload.channelId,
        payloadHash
      );
    if (existing?.status === 'created' && existing.external_ref)
      return { kind: 'reused' as const, externalRef: existing.external_ref };
    if (existing?.status === 'creating' || existing?.status === 'unknown')
      throw new BufferDraftError(
        'Buffer draft outcome is unknown or still in progress. Check Buffer before trying again.',
        409
      );
    const now = new Date().toISOString();
    if (existing) {
      await tx
        .prepare(
          `UPDATE content_buffer_drafts SET status='creating',external_ref=NULL,last_error=NULL,updated_at=?
           WHERE workspace_id=? AND id=?`
        )
        .run(now, workspaceId, existing.id);
      return { kind: 'claimed' as const, ledgerId: existing.id };
    }
    const ledgerId = id('bufdraft');
    await tx
      .prepare(
        `INSERT INTO content_buffer_drafts
         (id,workspace_id,source_post_id,buffer_channel_id,payload_hash,status,created_at,updated_at)
         VALUES (?,?,?,?,?,'creating',?,?)`
      )
      .run(
        ledgerId,
        workspaceId,
        payload.metadata.sourcePostId,
        payload.channelId,
        payloadHash,
        now,
        now
      );
    return { kind: 'claimed' as const, ledgerId };
  });
  if (claimed.kind === 'reused')
    return { provider: 'buffer', externalRef: claimed.externalRef, reused: true };

  const proxy = (options.proxyFor ?? productionProxy)(
    connection.providerConfigKey,
    connection.connectionId
  );
  try {
    const response = (await proxy.post('/', {
      query: `mutation TrevraCreateBufferDraft($input: CreatePostInput!) {
        createPost(input: $input) {
          __typename
          ... on PostActionSuccess { post { id text } }
          ... on MutationError { message }
        }
      }`,
      variables: {
        input: {
          text: payload.text,
          channelId: payload.channelId,
          schedulingType: 'automatic',
          mode: 'addToQueue',
          saveToDraft: true
        }
      }
    })) as {
      data?: {
        createPost?: {
          __typename?: string;
          post?: { id?: string | null; text?: string | null } | null;
          message?: string | null;
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };
    const mutationErrors = graphErrors(response);
    const createPost = response.data?.createPost ?? null;
    if (createPost?.__typename === 'MutationError') {
      const message = createPost.message?.trim() || 'Buffer rejected the draft.';
      await db
        .prepare(
          `UPDATE content_buffer_drafts SET status='failed',last_error=?,updated_at=?
           WHERE workspace_id=? AND id=?`
        )
        .run(message, new Date().toISOString(), workspaceId, claimed.ledgerId);
      throw new BufferDraftError(message, 422);
    }
    const externalRef = createPost?.post?.id?.trim() || '';
    if (mutationErrors.length > 0 || !externalRef) {
      const message = mutationErrors.join('; ') || 'Buffer returned no confirmed draft identifier.';
      await db
        .prepare(
          `UPDATE content_buffer_drafts SET status='unknown',last_error=?,updated_at=?
           WHERE workspace_id=? AND id=?`
        )
        .run(message, new Date().toISOString(), workspaceId, claimed.ledgerId);
      throw new BufferDraftError(
        'Buffer draft outcome is unknown. Check Buffer before trying again.',
        502
      );
    }
    await db
      .prepare(
        `UPDATE content_buffer_drafts SET status='created',external_ref=?,last_error=NULL,updated_at=?
         WHERE workspace_id=? AND id=?`
      )
      .run(externalRef, new Date().toISOString(), workspaceId, claimed.ledgerId);
    return { provider: 'buffer', externalRef, reused: false };
  } catch (error) {
    if (error instanceof BufferDraftError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    await db
      .prepare(
        `UPDATE content_buffer_drafts SET status='unknown',last_error=?,updated_at=?
         WHERE workspace_id=? AND id=?`
      )
      .run(detail.slice(0, 2000), new Date().toISOString(), workspaceId, claimed.ledgerId);
    throw new BufferDraftError(
      'Buffer draft outcome is unknown. Check Buffer before trying again.',
      502
    );
  }
}
