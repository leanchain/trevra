import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { openDatabase, type Db } from '../db.js';
import {
  companionRelaySecret,
  createCompanionPairing,
  exchangeCompanionPairing
} from './companion.js';
import { installLinkedInCompanionRelay } from './companion-relay.js';
import { COMPANION_RELEASE_VERSION } from './companion-release.js';

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
  return new Promise((resolve) =>
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>))
  );
}

beforeEach(async () => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = KEY;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Relay test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_companion_devices WHERE workspace_id=?').run(WORKSPACE_ID);
  await db
    .prepare('DELETE FROM linkedin_companion_pairings WHERE workspace_id=?')
    .run(WORKSPACE_ID);

  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  installLinkedInCompanionRelay(server, db);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay test server did not bind');
  base = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      /* already closed */
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
});

describe('LinkedIn companion reverse CDP relay', () => {
  it('advertises the required companion version before browser work', async () => {
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const paired = await exchangeCompanionPairing(db, {
      code: pairing.code,
      label: 'Laptop',
      now: NOW
    });
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`${base}/api/linkedin/companion/socket`, {
        headers: { authorization: `Bearer ${paired.token}` }
      });
      sockets.push(ws);
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
      ws.once('error', reject);
    });
    expect(hello).toMatchObject({
      type: 'hello',
      workspaceId: WORKSPACE_ID,
      companionVersion: COMPANION_RELEASE_VERSION
    });
  });

  it('bridges raw browser frames only after a paired laptop is online', async () => {
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const paired = await exchangeCompanionPairing(db, {
      code: pairing.code,
      label: 'Laptop',
      now: NOW
    });

    const control = await openSocket(`${base}/api/linkedin/companion/socket`, paired.token);

    const relayToken = companionRelaySecret();
    expect(relayToken).toBeTruthy();
    const opening = nextJson(control);
    const browser = await openSocket(
      `${base}/api/linkedin/companion/browser/${WORKSPACE_ID}/owner`,
      relayToken!
    );
    const open = await opening;
    expect(open).toMatchObject({ type: 'open', workspaceId: WORKSPACE_ID, seatKey: 'owner' });
    const relayId = String(open.relayId);

    control.send(JSON.stringify({ type: 'ready', relayId }));

    const toLaptop = nextJson(control);
    browser.send('{"id":1,"method":"Browser.getVersion"}');
    expect(await toLaptop).toMatchObject({
      type: 'cdp',
      relayId,
      data: '{"id":1,"method":"Browser.getVersion"}',
      binary: false
    });

    const toWorker = new Promise<string>((resolve) =>
      browser.once('message', (raw) => resolve(raw.toString()))
    );
    control.send(
      JSON.stringify({
        type: 'cdp',
        relayId,
        data: '{"id":1,"result":{"product":"Chrome"}}',
        binary: false
      })
    );
    expect(await toWorker).toBe('{"id":1,"result":{"product":"Chrome"}}');
  });

  it('keeps only one live control socket for a workspace, even when the same device starts twice', async () => {
    const pairing = await createCompanionPairing(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: 'usr_owner',
      now: NOW
    });
    const paired = await exchangeCompanionPairing(db, {
      code: pairing.code,
      label: 'Laptop',
      now: NOW
    });

    const first = await openSocket(`${base}/api/linkedin/companion/socket`, paired.token);
    const firstClosed = new Promise<number>((resolve) =>
      first.once('close', (code) => resolve(code))
    );
    const second = await openSocket(`${base}/api/linkedin/companion/socket`, paired.token);
    expect(await firstClosed).toBe(4001);

    const opening = nextJson(second);
    const browser = await openSocket(
      `${base}/api/linkedin/companion/browser/${WORKSPACE_ID}/owner`,
      companionRelaySecret()!
    );
    const open = await opening;
    expect(open).toMatchObject({ type: 'open', workspaceId: WORKSPACE_ID, seatKey: 'owner' });
    browser.close();
  });

  /**
   * THE SOCKET THAT HAD NO HEARTBEAT, AND THE BATCH THAT DIED IN THE GAP.
   *
   * `local-worker.ts` sleeps `ACTION_GAP_SECONDS.max` -- 120 seconds -- between
   * two actions of the same batch, and a loaded LinkedIn profile emits no CDP
   * events while it waits. The browser relay therefore carried zero bytes for
   * the whole gap, and on 2026-08-24 a five-action batch completed exactly one
   * action because the relay was gone by the time the second one navigated.
   *
   * A REAL SOCKET AND A SHORT PERIOD, not fake timers: what has to be proved is
   * that a frame reaches the peer, and a faked clock proves only that a
   * callback ran. The period is injected so several keepalives fit in a test
   * rather than in a minute and a half; 30_000 is what production uses.
   */
  it('keeps an idle browser relay alive with protocol pings', async () => {
    const idleServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    installLinkedInCompanionRelay(idleServer, db, { heartbeatMs: 150 });
    await new Promise<void>((resolve) => idleServer.listen(0, '127.0.0.1', resolve));
    const address = idleServer.address();
    if (!address || typeof address === 'string') throw new Error('idle relay server did not bind');
    const idleBase = `ws://127.0.0.1:${address.port}`;

    let control: WebSocket | null = null;
    let browser: WebSocket | null = null;
    try {
      const pairing = await createCompanionPairing(db, {
        workspaceId: WORKSPACE_ID,
        actorUserId: 'usr_owner',
        now: NOW
      });
      const paired = await exchangeCompanionPairing(db, {
        code: pairing.code,
        label: 'Laptop',
        now: NOW
      });
      control = await openSocket(`${idleBase}/api/linkedin/companion/socket`, paired.token);
      // Queued frames, read in order: the control socket is greeted with
      // `hello` before any relay exists, so waiting for a single next message
      // would consume the greeting and then wait forever for an `open` that had
      // already been delivered.
      const fromServer: Array<Record<string, unknown>> = [];
      control.on('message', (raw) =>
        fromServer.push(JSON.parse(raw.toString()) as Record<string, unknown>)
      );
      browser = await openSocket(
        `${idleBase}/api/linkedin/companion/browser/${WORKSPACE_ID}/owner`,
        companionRelaySecret()!
      );
      const waitFor = async (type: string): Promise<Record<string, unknown>> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const found = fromServer.find((message) => message.type === type);
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`relay never sent a '${type}' message`);
      };
      const open = await waitFor('open');
      const relayId = String(open.relayId);
      control.send(JSON.stringify({ type: 'ready', relayId }));

      let browserPings = 0;
      let controlPings = 0;
      browser.on('ping', () => {
        browserPings += 1;
      });
      control.on('ping', () => {
        controlPings += 1;
      });

      // Not one byte of CDP traffic in either direction for many heartbeat
      // periods -- an action gap, in miniature.
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(browserPings).toBeGreaterThanOrEqual(2);
      expect(controlPings).toBeGreaterThanOrEqual(2);
      // And the idle relay is still usable, which is the whole point: a batch
      // resuming after its gap has a tunnel to resume onto.
      expect(browser.readyState).toBe(WebSocket.OPEN);
      browser.send('{"id":9,"method":"Browser.getVersion"}');
      expect(await waitFor('cdp')).toMatchObject({ type: 'cdp', relayId });
    } finally {
      // Before `close`, always: an http server with a live upgraded socket on
      // it never finishes closing, and this test's sockets outlive the assert.
      control?.terminate();
      browser?.terminate();
      await new Promise<void>((resolve) => idleServer.close(() => resolve()));
    }
  });

  it('refuses the worker browser socket when no companion device is online', async () => {
    const token = companionRelaySecret();
    await expect(
      openSocket(`${base}/api/linkedin/companion/browser/${WORKSPACE_ID}/owner`, token!)
    ).rejects.toThrow(/503/);
  });
});
