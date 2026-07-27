import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { stableJson } from './payload.js';
import { executePreparedPlaybookAction, listRemoteActionAdapters } from './execution.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
  delete process.env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON;
  delete process.env.TEST_PROPRIETARY_ACTION_TOKEN;
});

describe('remote proprietary action adapters', () => {
  it('validates and sends an exact, signed, idempotent approved payload', async () => {
    const token = 'test-proprietary-action-token-with-32-characters';
    const payloadHash = 'a'.repeat(64);
    let observed = false;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const serialized = Buffer.concat(chunks).toString('utf8');
        expect(req.headers.authorization).toBe(`Bearer ${token}`);
        expect(req.headers['x-trevra-action']).toBe('acme.crm.update');
        expect(req.headers['x-trevra-idempotency-key']).toBe(payloadHash);
        expect(req.headers['x-trevra-signature']).toBe(`sha256=${createHmac('sha256', token).update(serialized).digest('hex')}`);
        expect(serialized).toBe(stableJson({
          actionType: 'acme.crm.update',
          workspaceId: 'ws_test',
          idempotencyKey: payloadHash,
          payload: { contactId: 'contact_123', lifecycle: 'qualified' }
        }));
        observed = true;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ provider: 'acme-crm', externalRef: 'change_456' }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');

    process.env.TEST_PROPRIETARY_ACTION_TOKEN = token;
    process.env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON = JSON.stringify([{
      actionType: 'acme.crm.update',
      endpoint: `http://127.0.0.1:${address.port}/execute`,
      tokenEnv: 'TEST_PROPRIETARY_ACTION_TOKEN',
      provider: 'acme-crm',
      timeoutSeconds: 5,
      payloadSchema: {
        type: 'object',
        properties: {
          contactId: { type: 'string' },
          lifecycle: { enum: ['qualified', 'customer'] }
        },
        required: ['contactId', 'lifecycle'],
        additionalProperties: false
      }
    }]);

    const result = await executePreparedPlaybookAction({} as Db, {
      workspaceId: 'ws_test',
      actionType: 'acme.crm.update',
      payload: { contactId: 'contact_123', lifecycle: 'qualified' },
      payloadHash
    });
    expect(observed).toBe(true);
    expect(result).toEqual({ provider: 'acme-crm', externalRef: 'change_456', actionType: 'acme.crm.update' });
  });

  it('rejects payloads outside the configured schema before contacting the adapter', async () => {
    process.env.TEST_PROPRIETARY_ACTION_TOKEN = 'test-proprietary-action-token-with-32-characters';
    process.env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON = JSON.stringify([{
      actionType: 'acme.crm.update',
      endpoint: 'http://127.0.0.1:9/execute',
      tokenEnv: 'TEST_PROPRIETARY_ACTION_TOKEN',
      payloadSchema: {
        type: 'object',
        properties: { contactId: { type: 'string' } },
        required: ['contactId'],
        additionalProperties: false
      }
    }]);
    await expect(executePreparedPlaybookAction({} as Db, {
      workspaceId: 'ws_test',
      actionType: 'acme.crm.update',
      payload: { unexpected: true },
      payloadHash: 'b'.repeat(64)
    })).rejects.toThrow('failed validation');
  });

  it('rejects duplicate adapter names and non-HTTPS production endpoints', () => {
    const duplicate = JSON.stringify([
      { actionType: 'acme.crm.update', endpoint: 'https://one.example/action', tokenEnv: 'TOKEN_ONE' },
      { actionType: 'acme.crm.update', endpoint: 'https://two.example/action', tokenEnv: 'TOKEN_TWO' }
    ]);
    expect(() => listRemoteActionAdapters({ TREVRA_REMOTE_ACTION_ADAPTERS_JSON: duplicate })).toThrow('Duplicate remote action adapter');
    const insecure = JSON.stringify([{ actionType: 'acme.crm.update', endpoint: 'http://internal/action', tokenEnv: 'TOKEN_ONE' }]);
    expect(() => listRemoteActionAdapters({ NODE_ENV: 'production', TREVRA_REMOTE_ACTION_ADAPTERS_JSON: insecure })).toThrow('must use HTTPS');
  });
});
