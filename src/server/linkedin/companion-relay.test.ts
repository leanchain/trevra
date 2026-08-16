import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { openDatabase, type Db } from '../db.js';
import {
  companionRelaySecret,
  createCompanionPairing,
  exchangeCompanionPairing,
  markCompanionWebsitePresence
} from './companion.js';
import { installLinkedInCompanionRelay } from './companion-relay.js';

const WORKSPACE_ID = 'ws_companion_relay_test';
const NOW = new Date();
const KEY = Buffer.alloc(32, 9).toString('base64');

let db: Db;
let server: Server;
let base: string;
let previousKey: string | undefined;
const sockets: WebSocket[] = [];

function openSocket(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>)));
}

beforeEach(async () => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = KEY;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'Relay test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_companion_presence WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_companion_devices WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_companion_pairings WHERE workspace_id=?').run(WORKSPACE_ID);

  server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  installLinkedInCompanionRelay(server, db);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay test server did not bind');
  base = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try { socket.terminate(); } catch { /* already closed */ }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
});

describe('LinkedIn companion reverse CDP relay', () => {
  it('bridges raw browser frames only after a paired laptop and website presence are both active', async () => {
    const pairing = await createCompanionPairing(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_owner', now: NOW });
    const paired = await exchangeCompanionPairing(db, { code: pairing.code, label: 'Laptop', now: NOW });
    await markCompanionWebsitePresence(db, WORKSPACE_ID, 'usr_owner', NOW);

    const control = await openSocket(`${base}/api/linkedin/companion/socket`, paired.token);

    const relayToken = companionRelaySecret();
    expect(relayToken).toBeTruthy();
    const opening = nextJson(control);
    const browser = await openSocket(`${base}/api/linkedin/companion/browser/${WORKSPACE_ID}/owner`, relayToken!);
    const open = await opening;
    expect(open).toMatchObject({ type: 'open', workspaceId: WORKSPACE_ID, seatKey: 'owner' });
    const relayId = String(open.relayId);

    control.send(JSON.stringify({ type: 'ready', relayId }));

    const toLaptop = nextJson(control);
    browser.send('{"id":1,"method":"Browser.getVersion"}');
    expect(await toLaptop).toMatchObject({
      type: 'cdp', relayId, data: '{"id":1,"method":"Browser.getVersion"}', binary: false
    });

    const toWorker = new Promise<string>((resolve) => browser.once('message', (raw) => resolve(raw.toString())));
    control.send(JSON.stringify({ type: 'cdp', relayId, data: '{"id":1,"result":{"product":"Chrome"}}', binary: false }));
    expect(await toWorker).toBe('{"id":1,"result":{"product":"Chrome"}}');
  });

  it('keeps only one live control socket for a workspace, even when the same device starts twice', async () => {
    const pairing = await createCompanionPairing(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_owner', now: NOW });
    const paired = await exchangeCompanionPairing(db, { code: pairing.code, label: 'Laptop', now: NOW });
    await markCompanionWebsitePresence(db, WORKSPACE_ID, 'usr_owner', NOW);

    const first = await openSocket(`${base}/api/linkedin/companion/socket`, paired.token);
    const firstClosed = new Promise<number>((resolve) => first.once('close', (code) => resolve(code)));
    const second = await openSocket(`${base}/api/linkedin/companion/socket`, paired.token);
    expect(await firstClosed).toBe(4001);

    const opening = nextJson(second);
    const browser = await openSocket(`${base}/api/linkedin/companion/browser/${WORKSPACE_ID}/owner`, companionRelaySecret()!);
    const open = await opening;
    expect(open).toMatchObject({ type: 'open', workspaceId: WORKSPACE_ID, seatKey: 'owner' });
    browser.close();
  });

  it('refuses the worker browser socket when no Trevra website lease is alive', async () => {
    const pairing = await createCompanionPairing(db, { workspaceId: WORKSPACE_ID, actorUserId: 'usr_owner', now: NOW });
    const paired = await exchangeCompanionPairing(db, { code: pairing.code, label: 'Laptop', now: NOW });
    await openSocket(`${base}/api/linkedin/companion/socket`, paired.token);

    const token = companionRelaySecret();
    await expect(openSocket(`${base}/api/linkedin/companion/browser/${WORKSPACE_ID}/owner`, token!))
      .rejects.toThrow(/503/);
  });
});
