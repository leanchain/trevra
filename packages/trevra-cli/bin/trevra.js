#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { WebSocket } from 'ws';

const VERSION = '0.1.0';
const HOME = join(homedir(), '.trevra');
const CONFIG = join(HOME, 'companion.json');
const PROFILES = join(HOME, 'linkedin-companion');
const LOCK = join(HOME, 'linkedin-companion.lock');
const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Trevra ${VERSION}\n\nUsage:\n  npx trevra linkedin --pair XXXX-XXXX-XXXX --url https://app.usetrevra.com\n  npx trevra linkedin\n\nCommands:\n  linkedin       Lend this computer's Chrome browser to your Trevra workspace\n\nOptions:\n  --pair CODE    One-time pairing code shown in Trevra\n  --url URL      Trevra URL (default: saved URL or https://app.usetrevra.com)\n  --label NAME   Name this computer in Trevra\n  --help         Show this help\n  --version      Show the version\n`);
  process.exit(exitCode);
}

function argValue(args, name) {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1] ?? '';
  const prefix = `${name}=`;
  const item = args.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : '';
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs do not use POSIX modes. */ }
}

function saveConfig(config) {
  ensurePrivateDir(HOME);
  const temp = `${CONFIG}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temp, 0o600); } catch { /* Windows */ }
  rmSync(CONFIG, { force: true });
  // renameSync is deliberately avoided on Windows when antivirus has the old
  // file open; writing the final file from the already-private bytes is safer
  // than leaving a temp path as the source of truth.
  const bytes = readFileSync(temp);
  writeFileSync(CONFIG, bytes, { mode: 0o600 });
  try { chmodSync(CONFIG, 0o600); } catch { /* Windows */ }
  rmSync(temp, { force: true });
}

function readConfig() {
  try {
    const value = JSON.parse(readFileSync(CONFIG, 'utf8'));
    if (!value || typeof value.url !== 'string' || typeof value.token !== 'string') return null;
    return value;
  } catch { return null; }
}

function secureBaseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Not a Trevra URL: ${raw}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The Trevra URL must use https (http is allowed only on localhost).');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function wsUrl(base) {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/linkedin/companion/socket';
  return url.toString();
}

async function pair(base, code, label) {
  const response = await fetch(`${base}/api/linkedin/companion/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Pairing failed (${response.status}).`);
  saveConfig({
    url: base,
    token: body.token,
    workspaceId: body.workspaceId,
    deviceId: body.deviceId,
    label: body.label,
    pairedAt: new Date().toISOString()
  });
  return body;
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || 'owner';
}

function which(name) {
  try {
    return execFileSync(platform() === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? null;
  } catch { return null; }
}

function systemChrome() {
  const candidates = [];
  if (platform() === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (platform() === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'msedge']) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

async function playwrightChromium() {
  const require = createRequire(import.meta.url);
  const { chromium } = await import('playwright');
  let executable = chromium.executablePath();
  if (existsSync(executable)) return executable;

  process.stdout.write('No system Chrome was found. Installing Trevra’s Chromium fallback once…\n');
  const cli = require.resolve('playwright/cli');
  await new Promise((resolveInstall, rejectInstall) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    child.once('error', rejectInstall);
    child.once('exit', (code) => code === 0 ? resolveInstall() : rejectInstall(new Error(`Chromium install exited ${code}`)));
  });
  executable = chromium.executablePath();
  if (!existsSync(executable)) throw new Error('Chromium finished installing but its executable could not be found.');
  return executable;
}

function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

function readDevToolsEndpoint(profileDir) {
  try {
    const [port, path] = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    if (!port || !path) return null;
    return `ws://127.0.0.1:${Number(port)}${path}`;
  } catch { return null; }
}

async function endpointResponds(endpoint) {
  if (!endpoint) return false;
  return new Promise((resolveCheck) => {
    const ws = new WebSocket(endpoint);
    const timer = setTimeout(() => { ws.terminate(); resolveCheck(false); }, 1500);
    ws.once('open', () => { clearTimeout(timer); ws.close(); resolveCheck(true); });
    ws.once('error', () => { clearTimeout(timer); resolveCheck(false); });
  });
}

const browsers = new Map();
let browserExecutable = null;

async function ensureBrowser(workspaceId, seatKey) {
  const key = `${workspaceId}/${seatKey}`;
  const old = browsers.get(key);
  if (old?.endpoint && await endpointResponds(old.endpoint)) return old;

  const profileDir = join(PROFILES, safeSegment(workspaceId), safeSegment(seatKey));
  ensurePrivateDir(profileDir);
  const onDisk = readDevToolsEndpoint(profileDir);
  if (onDisk && await endpointResponds(onDisk)) {
    const handle = { endpoint: onDisk, child: null, profileDir };
    browsers.set(key, handle);
    return handle;
  }

  browserExecutable ??= systemChrome() ?? await playwrightChromium();
  process.stdout.write(`Opening LinkedIn in Chrome for ${seatKey === 'owner' ? 'your account' : `account ${seatKey}`}…\n`);
  const child = spawn(browserExecutable, [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--start-maximized',
    LINKEDIN_FEED
  ], { stdio: 'ignore', windowsHide: false });

  const handle = { endpoint: null, child, profileDir };
  browsers.set(key, handle);
  child.once('exit', () => {
    const current = browsers.get(key);
    if (current?.child === child) browsers.delete(key);
  });
  child.once('error', (error) => {
    process.stderr.write(`Chrome could not start: ${error.message}\n`);
  });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const endpoint = readDevToolsEndpoint(profileDir);
    if (endpoint && await endpointResponds(endpoint)) {
      handle.endpoint = endpoint;
      return handle;
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`Chrome opened no DevTools endpoint for ${seatKey}. Close the Trevra Chrome window and run the command again.`);
}

function acquireLock() {
  ensurePrivateDir(HOME);
  try {
    const fd = openSync(LOCK, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    let pid = 0;
    try { pid = Number(readFileSync(LOCK, 'utf8').trim()); } catch { /* stale */ }
    if (pid > 0) {
      try { process.kill(pid, 0); throw new Error(`Trevra LinkedIn is already running (process ${pid}).`); }
      catch (error) {
        if (error?.message?.includes('already running')) throw error;
      }
    }
    rmSync(LOCK, { force: true });
    const fd = openSync(LOCK, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  }
  return () => rmSync(LOCK, { force: true });
}

async function runCompanion(config) {
  const releaseLock = acquireLock();
  ensurePrivateDir(PROFILES);
  let stopping = false;
  let control = null;
  let ping = null;
  const relays = new Map();

  const closeRelays = () => {
    for (const relay of relays.values()) {
      relay.expectClose = true;
      try { relay.ws.close(); } catch { /* already closed */ }
    }
    relays.clear();
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (ping) clearInterval(ping);
    closeRelays();
    try { control?.close(); } catch { /* already closed */ }
    for (const handle of browsers.values()) {
      try { handle.child?.kill(); } catch { /* already gone */ }
    }
    releaseLock();
    process.stdout.write('\nTrevra LinkedIn companion stopped.\n');
  };
  process.once('SIGINT', () => { shutdown(); process.exit(0); });
  process.once('SIGTERM', () => { shutdown(); process.exit(0); });
  process.once('exit', releaseLock);

  // Open the owner profile immediately: pairing is also the sign-in journey,
  // so a first run should show LinkedIn without waiting for a queued campaign.
  try {
    await ensureBrowser(config.workspaceId, 'owner');
    process.stdout.write('Use this dedicated Chrome window only for LinkedIn; Trevra can control it while the companion is connected. Sign in if needed, then keep this command open.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
  }

  let backoff = 1000;
  while (!stopping) {
    try {
      await new Promise((resolveConnection, rejectConnection) => {
        const socket = new WebSocket(wsUrl(config.url), { headers: { authorization: `Bearer ${config.token}` } });
        control = socket;
        let opened = false;

        socket.once('open', () => {
          opened = true;
          backoff = 1000;
          process.stdout.write(`Connected to ${config.url}. LinkedIn cycles will use this computer only while a Trevra tab is also open.\n`);
          ping = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
          }, 20_000);
        });

        socket.on('message', async (raw) => {
          let message;
          try { message = JSON.parse(raw.toString()); } catch { return; }
          if (message.type === 'open' && message.relayId && message.seatKey) {
            try {
              const handle = await ensureBrowser(config.workspaceId, message.seatKey);
              const local = new WebSocket(handle.endpoint);
              const relay = { ws: local, expectClose: false };
              relays.set(message.relayId, relay);
              local.once('open', () => socket.send(JSON.stringify({ type: 'ready', relayId: message.relayId })));
              local.on('message', (data, binary) => {
                if (socket.readyState !== WebSocket.OPEN) return;
                socket.send(JSON.stringify({
                  type: 'cdp', relayId: message.relayId,
                  data: binary ? Buffer.from(data).toString('base64') : data.toString(),
                  binary
                }));
              });
              local.once('error', (error) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', relayId: message.relayId, message: error.message }));
              });
              local.once('close', () => {
                const current = relays.get(message.relayId);
                relays.delete(message.relayId);
                if (!current?.expectClose && socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: 'error', relayId: message.relayId, message: 'The local Chrome connection closed before the Trevra browser session finished.' }));
                }
              });
            } catch (error) {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', relayId: message.relayId, message: error.message }));
            }
            return;
          }
          if (message.type === 'cdp' && message.relayId && typeof message.data === 'string') {
            const relay = relays.get(message.relayId);
            if (!relay || relay.ws.readyState !== WebSocket.OPEN) return;
            if (!message.binary) {
              try {
                const command = JSON.parse(message.data);
                if (command?.method === 'Browser.close') relay.expectClose = true;
              } catch { /* CDP is JSON, but forwarding it never depends on parsing it. */ }
            }
            relay.ws.send(message.binary ? Buffer.from(message.data, 'base64') : message.data);
            return;
          }
          if (message.type === 'close' && message.relayId) {
            const relay = relays.get(message.relayId);
            if (relay) { relay.expectClose = true; relay.ws.close(); }
            relays.delete(message.relayId);
          }
        });

        socket.once('close', (code) => {
          if (ping) clearInterval(ping);
          ping = null;
          closeRelays();
          if (stopping) resolveConnection();
          else if (code === 1008 || code === 4401) rejectConnection(new Error('This companion is no longer authorised. Pair this computer again in Trevra.'));
          else resolveConnection();
        });
        socket.once('error', (error) => {
          if (!opened) rejectConnection(error);
        });
      });
    } catch (error) {
      if (/no longer authorised|401|Unexpected server response: 401/i.test(error.message)) {
        shutdown();
        throw error;
      }
      process.stderr.write(`Trevra connection interrupted: ${error.message}\n`);
    }
    if (stopping) break;
    process.stdout.write(`Reconnecting in ${Math.round(backoff / 1000)}s…\n`);
    await sleep(backoff);
    backoff = Math.min(15_000, backoff * 2);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  if (args.includes('--version') || args.includes('-v')) { process.stdout.write(`${VERSION}\n`); return; }
  const command = args[0];
  if (command !== 'linkedin') usage(command ? 1 : 0);

  const saved = readConfig();
  const requestedUrl = argValue(args, '--url') || saved?.url || 'https://app.usetrevra.com';
  const base = secureBaseUrl(requestedUrl);
  const code = argValue(args, '--pair');
  const label = argValue(args, '--label') || saved?.label || hostname();

  let config = saved;
  if (code) {
    process.stdout.write(`Pairing ${label} with ${base}…\n`);
    const paired = await pair(base, code, label);
    config = { ...readConfig(), ...paired, url: base };
    process.stdout.write(`Paired as ${paired.label}. Future runs are just: npx trevra linkedin\n`);
  }
  if (!config) {
    throw new Error('This computer is not paired yet. In Trevra open Outreach → LinkedIn accounts → Connect this computer, then run the command it shows.');
  }
  if (config.url !== base) config = { ...config, url: base };
  await runCompanion(config);
}

main().catch((error) => {
  process.stderr.write(`trevra: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
