import { randomUUID } from 'node:crypto';
import { COMPANION_RELEASE_VERSION } from './companion-release.js';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Db } from '../db.js';
import {
  authenticateCompanionToken,
  companionDeviceIsActive,
  companionRelaySecretMatches,
  companionWorkspaceReady,
  touchCompanionDevice
} from './companion.js';

interface ControlConnection {
  ws: WebSocket;
  deviceId: string;
  workspaceId: string;
  label: string;
  connectedAt: number;
  lastDbTouch: number;
}

interface RelaySession {
  id: string;
  workspaceId: string;
  seatKey: string;
  browser: WebSocket;
  control: ControlConnection;
  ready: boolean;
  pending: Array<{ data: string; binary: boolean }>;
  pendingBytes: number;
}

const MAX_PENDING_BYTES = 2 * 1024 * 1024;

function bearer(request: IncomingMessage): string {
  return String(request.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
}

function reject(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  socket.destroy();
}

function text(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

/** Reverse-CDP bridge between the hosted worker and one paired member computer. */
export function installLinkedInCompanionRelay(server: Server, db: Db): void {
  const controlServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const browserServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const controls = new Map<string, ControlConnection>();
  const sessions = new Map<string, RelaySession>();

  const forgetSession = (session: RelaySession, notifyControl = true): void => {
    if (!sessions.delete(session.id)) return;
    if (notifyControl) sendJson(session.control.ws, { type: 'close', relayId: session.id });
    if (session.browser.readyState === WebSocket.OPEN || session.browser.readyState === WebSocket.CONNECTING) {
      session.browser.close(1000, 'Companion relay closed');
    }
  };

  const setupControl = (
    ws: WebSocket,
    identity: { deviceId: string; workspaceId: string; label: string }
  ): void => {
    const connection: ControlConnection = {
      ws,
      ...identity,
      connectedAt: Date.now(),
      lastDbTouch: Date.now()
    };

    // Only one live control connection may own a workspace. A replacement or
    // restarted companion wins immediately and detaches every browser session
    // owned by the previous socket before becoming selectable by the worker.
    const prior = controls.get(identity.workspaceId);
    if (prior) {
      for (const session of [...sessions.values()]) {
        if (session.control === prior) forgetSession(session, false);
      }
      if (prior.ws.readyState === WebSocket.OPEN || prior.ws.readyState === WebSocket.CONNECTING) {
        prior.ws.close(4001, 'Another companion connected');
      }
    }
    controls.set(identity.workspaceId, connection);
    sendJson(ws, {
      type: 'hello',
      workspaceId: identity.workspaceId,
      deviceId: identity.deviceId,
      label: identity.label,
      companionVersion: COMPANION_RELEASE_VERSION
    });

    ws.on('message', (raw: RawData) => {
      let message: { type?: string; relayId?: string; data?: string; binary?: boolean; message?: string };
      try { message = JSON.parse(text(raw)) as typeof message; } catch { return; }

      const now = Date.now();
      if (now - connection.lastDbTouch > 30_000) {
        connection.lastDbTouch = now;
        void touchCompanionDevice(db, connection.deviceId, new Date(now)).catch(() => undefined);
      }
      if (message.type === 'ping') {
        sendJson(ws, { type: 'pong', at: new Date().toISOString() });
        return;
      }
      if (!message.relayId) return;
      const session = sessions.get(message.relayId);
      if (!session || session.control !== connection) return;

      if (message.type === 'ready') {
        session.ready = true;
        for (const item of session.pending) sendJson(ws, { type: 'cdp', relayId: session.id, data: item.data, binary: item.binary });
        session.pending = [];
        session.pendingBytes = 0;
        return;
      }
      if (message.type === 'cdp' && typeof message.data === 'string') {
        if (session.browser.readyState !== WebSocket.OPEN) return;
        if (message.binary) session.browser.send(Buffer.from(message.data, 'base64'));
        else session.browser.send(message.data);
        return;
      }
      if (message.type === 'error') {
        if (session.browser.readyState === WebSocket.OPEN) session.browser.close(1011, (message.message ?? 'Companion browser failed').slice(0, 120));
        forgetSession(session, false);
      }
    });

    ws.on('close', () => {
      if (controls.get(connection.workspaceId) === connection) controls.delete(connection.workspaceId);
      for (const session of [...sessions.values()]) {
        if (session.control === connection) forgetSession(session, false);
      }
    });
  };

  const setupBrowser = (
    browser: WebSocket,
    meta: { workspaceId: string; seatKey: string; control: ControlConnection }
  ): void => {
    const session: RelaySession = {
      id: randomUUID(),
      workspaceId: meta.workspaceId,
      seatKey: meta.seatKey,
      browser,
      control: meta.control,
      ready: false,
      pending: [],
      pendingBytes: 0
    };
    sessions.set(session.id, session);
    sendJson(meta.control.ws, { type: 'open', relayId: session.id, workspaceId: meta.workspaceId, seatKey: meta.seatKey });

    browser.on('message', (raw: RawData, binary: boolean) => {
      const payload = binary ? Buffer.from(raw as Buffer).toString('base64') : text(raw);
      if (!session.ready) {
        session.pendingBytes += Buffer.byteLength(payload);
        if (session.pendingBytes > MAX_PENDING_BYTES) {
          browser.close(1013, 'Companion browser did not become ready');
          forgetSession(session);
          return;
        }
        session.pending.push({ data: payload, binary });
        return;
      }
      sendJson(session.control.ws, { type: 'cdp', relayId: session.id, data: payload, binary });
    });
    browser.on('close', () => forgetSession(session));
    browser.on('error', () => forgetSession(session));
  };

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://localhost'); }
      catch { return reject(socket, 400, 'Bad Request'); }

      if (url.pathname === '/api/linkedin/companion/socket') {
        const token = bearer(request);
        const identity = token ? await authenticateCompanionToken(db, token) : null;
        if (!identity) return reject(socket, 401, 'Unauthorized');
        controlServer.handleUpgrade(request, socket, head, (ws: WebSocket) => setupControl(ws, identity));
        return;
      }

      const match = url.pathname.match(/^\/api\/linkedin\/companion\/browser\/([^/]+)\/([^/]+)$/);
      if (!match) return reject(socket, 404, 'Not Found');
      const workspaceId = decodeURIComponent(match[1]);
      const seatKey = decodeURIComponent(match[2]);
      if (!companionRelaySecretMatches(bearer(request))) return reject(socket, 401, 'Unauthorized');
      if (!(await companionWorkspaceReady(db, workspaceId))) return reject(socket, 503, 'Companion unavailable');

      const candidate = controls.get(workspaceId);
      if (!candidate || candidate.ws.readyState !== WebSocket.OPEN || !(await companionDeviceIsActive(db, candidate.deviceId))) {
        return reject(socket, 503, 'Companion unavailable');
      }

      browserServer.handleUpgrade(request, socket, head, (ws: WebSocket) => setupBrowser(ws, { workspaceId, seatKey, control: candidate }));
    })().catch(() => reject(socket, 500, 'Relay error'));
  });
}
