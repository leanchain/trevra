#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
  chmodSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { WebSocket } from 'ws';
import {
  installStablePackage,
  installedServiceStatus,
  registerBackgroundService,
  restartBackgroundService,
  startBackgroundService,
  stopBackgroundService,
  uninstallBackgroundService
} from '../lib/service.js';
import { isNewerVersion, officialCompanionPackage } from '../lib/update.js';
import { chromeLaunchArgs } from '../lib/browser.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = String(
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
);
const HOME = join(homedir(), '.trevra');
const CONFIG = join(HOME, 'companion.json');
const PROFILES = join(HOME, 'linkedin-companion');
const LOCK = join(HOME, 'linkedin-companion.lock');
const LOGS = join(HOME, 'logs');
const ACTIVITY_LOG = join(LOGS, 'linkedin-companion.log');
const ACTIVITY_LOG_OLD = join(LOGS, 'linkedin-companion.log.1');
const MAX_ACTIVITY_LOG_BYTES = 2 * 1024 * 1024;
const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';
const REDDIT_HOME = 'https://www.reddit.com/';
const REDDIT_COMPANION_PROFILE_KEY = '__reddit__';

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(
    `Trevra ${VERSION}\n\nUsage:\n  <install command copied from Trevra>\n  trevra linkedin setup [--force]\n  trevra linkedin status\n  trevra linkedin logs [--follow] [--lines 200]\n  trevra linkedin reconnect [--seat owner]\n  trevra linkedin start\n  trevra linkedin stop\n  trevra linkedin restart\n  trevra linkedin uninstall\n  trevra linkedin                     # foreground/debug mode\n\nLinkedIn companion commands:\n  setup          Install/register the background companion without requiring pairing\n  install        Pair if needed, ensure the background service is installed, and start it\n  status         Show whether this computer is paired, installed, and running\n  logs           Show local companion activity; --follow streams new entries\n  reconnect      Temporarily open the same LinkedIn profile visibly for login/CAPTCHA/2FA recovery\n  start          Start the installed background companion\n  stop           Stop it without removing pairing or the LinkedIn browser profile\n  restart        Restart the installed background companion\n  uninstall      Remove the background service; keep pairing and browser profile\n\nOptions:\n  --pair CODE    One-time pairing code shown in Trevra\n  --url URL      Trevra URL (default: saved URL or https://app.usetrevra.com)\n  --label NAME   Name this computer in Trevra\n  --seat KEY     LinkedIn account profile to recover (default: owner)\n  --lines N      Number of recent log lines to show (default: 200)\n  --follow, -f   Continue streaming new log entries\n  --force        Reinstall the local companion package during setup\n  --help         Show this help\n  --version      Show the version\n`
  );
  process.exit(exitCode);
}

function argValue(args, name) {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1] ?? '';
  const prefix = `${name}=`;
  const item = args.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : '';
}

function argNumber(args, name, fallback) {
  const value = Number(argValue(args, name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    /* Windows ACLs do not use POSIX modes. */
  }
}

function safeLogText(value) {
  return String(value ?? '')
    .replace(/trv_cmp_[A-Za-z0-9_-]+/g, '[redacted-device-token]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function activity(event, detail = '') {
  try {
    ensurePrivateDir(LOGS);
    if (existsSync(ACTIVITY_LOG) && statSync(ACTIVITY_LOG).size >= MAX_ACTIVITY_LOG_BYTES) {
      rmSync(ACTIVITY_LOG_OLD, { force: true });
      renameSync(ACTIVITY_LOG, ACTIVITY_LOG_OLD);
      try {
        chmodSync(ACTIVITY_LOG_OLD, 0o600);
      } catch {
        /* Windows */
      }
    }
    const suffix = detail ? ` ${safeLogText(detail)}` : '';
    appendFileSync(ACTIVITY_LOG, `${new Date().toISOString()} ${event}${suffix}\n`, {
      mode: 0o600
    });
    try {
      chmodSync(ACTIVITY_LOG, 0o600);
    } catch {
      /* Windows */
    }
  } catch {
    /* Logging must never stop the companion. */
  }
}

function recentLogText(lines) {
  const chunks = [];
  for (const path of [ACTIVITY_LOG_OLD, ACTIVITY_LOG]) {
    try {
      chunks.push(readFileSync(path, 'utf8'));
    } catch {
      /* no log yet */
    }
  }
  return chunks.join('').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

async function showActivityLogs({ lines = 200, follow = false } = {}) {
  const count = Math.max(1, Math.min(5000, Math.trunc(lines)));
  const initial = recentLogText(count);
  process.stdout.write(initial ? `${initial}\n` : 'No companion activity has been logged yet.\n');
  if (!follow) return;

  let seen = '';
  try {
    seen = readFileSync(ACTIVITY_LOG, 'utf8');
  } catch {
    /* created later */
  }
  process.stdout.write('--- following Trevra LinkedIn companion logs (Ctrl+C to stop) ---\n');
  while (true) {
    await sleep(500);
    let current = '';
    try {
      current = readFileSync(ACTIVITY_LOG, 'utf8');
    } catch {
      continue;
    }
    if (current.startsWith(seen)) {
      const next = current.slice(seen.length);
      if (next) process.stdout.write(next);
    } else if (current !== seen) {
      process.stdout.write(current);
    }
    seen = current;
  }
}

function saveConfig(config) {
  ensurePrivateDir(HOME);
  const temp = `${CONFIG}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    /* Windows */
  }
  rmSync(CONFIG, { force: true });
  // renameSync is deliberately avoided on Windows when antivirus has the old
  // file open; writing the final file from the already-private bytes is safer
  // than leaving a temp path as the source of truth.
  const bytes = readFileSync(temp);
  writeFileSync(CONFIG, bytes, { mode: 0o600 });
  try {
    chmodSync(CONFIG, 0o600);
  } catch {
    /* Windows */
  }
  rmSync(temp, { force: true });
}

function readConfig() {
  try {
    const value = JSON.parse(readFileSync(CONFIG, 'utf8'));
    if (!value || typeof value.url !== 'string' || typeof value.token !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function secureBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a Trevra URL: ${raw}`);
  }
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
  return (
    String(value)
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 96) || 'owner'
  );
}

function which(name) {
  try {
    return (
      execFileSync(platform() === 'win32' ? 'where' : 'which', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
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
    for (const base of [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA
    ].filter(Boolean)) {
      candidates.push(
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of [
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'microsoft-edge-stable',
    'msedge'
  ]) {
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
    child.once('exit', (code) =>
      code === 0 ? resolveInstall() : rejectInstall(new Error(`Chromium install exited ${code}`))
    );
  });
  executable = chromium.executablePath();
  if (!existsSync(executable))
    throw new Error('Chromium finished installing but its executable could not be found.');
  return executable;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readDevToolsEndpoint(profileDir) {
  try {
    const [port, path] = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8')
      .trim()
      .split(/\r?\n/);
    if (!port || !path) return null;
    return `ws://127.0.0.1:${Number(port)}${path}`;
  } catch {
    return null;
  }
}

async function endpointResponds(endpoint) {
  if (!endpoint) return false;
  return new Promise((resolveCheck) => {
    const ws = new WebSocket(endpoint);
    const timer = setTimeout(() => {
      ws.terminate();
      resolveCheck(false);
    }, 1500);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolveCheck(true);
    });
    ws.once('error', () => {
      clearTimeout(timer);
      resolveCheck(false);
    });
  });
}
async function recoverySessionHealthy(endpoint) {
  if (!endpoint) return false;
  return new Promise((resolveCheck) => {
    const ws = new WebSocket(endpoint);
    let cookies = null;
    let targets = null;
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolveCheck(healthy);
    };
    const decide = () => {
      if (!cookies || !targets) return;
      const authenticatedCookie = cookies.some(
        (cookie) =>
          cookie?.name === 'li_at' &&
          typeof cookie?.value === 'string' &&
          cookie.value.length > 0 &&
          /(^|\.)linkedin\.com$/i.test(String(cookie?.domain ?? '').replace(/^\./, ''))
      );
      const healthyPage = targets.some((target) => {
        if (target?.type !== 'page' || typeof target?.url !== 'string') return false;
        try {
          const url = new URL(target.url);
          if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return false;
          return !/^\/(?:login(?:\/|$)|uas\/login|checkpoint(?:\/|$)|authwall(?:\/|$)|flagship-web\/login)/i.test(
            url.pathname
          );
        } catch {
          return false;
        }
      });
      finish(authenticatedCookie && healthyPage);
    };
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      finish(false);
    }, 2500);
    ws.once('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
      ws.send(JSON.stringify({ id: 2, method: 'Target.getTargets' }));
    });
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id === 1)
          cookies = Array.isArray(message.result?.cookies) ? message.result.cookies : [];
        if (message.id === 2)
          targets = Array.isArray(message.result?.targetInfos) ? message.result.targetInfos : [];
        decide();
      } catch {
        /* wait for the next frame */
      }
    });
    ws.once('error', () => finish(false));
  });
}

async function reportRecoveryState(config, seatKey, state) {
  try {
    const endpoint = new URL('/api/linkedin/companion/recovery/status', config.url);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ seatKey, state })
    });
    if (!response.ok) {
      activity('recovery_status_failed', `seat=${seatKey} state=${state} http=${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    activity(
      'recovery_status_failed',
      `seat=${seatKey} state=${state} ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

const browsers = new Map();
let browserExecutable = null;

async function ensureBrowser(workspaceId, seatKey, { headless = false } = {}) {
  const key = `${workspaceId}/${seatKey}`;
  const old = browsers.get(key);
  if (old?.endpoint && (await endpointResponds(old.endpoint))) {
    activity('browser_reused', `seat=${seatKey}`);
    return old;
  }

  const profileDir = join(PROFILES, safeSegment(workspaceId), safeSegment(seatKey));
  ensurePrivateDir(profileDir);
  const onDisk = readDevToolsEndpoint(profileDir);
  if (onDisk && (await endpointResponds(onDisk))) {
    const handle = { endpoint: onDisk, child: null, profileDir };
    browsers.set(key, handle);
    activity('browser_reused', `seat=${seatKey}`);
    return handle;
  }

  browserExecutable ??= systemChrome() ?? (await playwrightChromium());
  const browserMode = headless ? 'background' : 'visible';
  const reddit = seatKey === REDDIT_COMPANION_PROFILE_KEY;
  const browserLabel = reddit ? 'Reddit' : 'LinkedIn';
  const startUrl = reddit ? REDDIT_HOME : LINKEDIN_FEED;
  activity('browser_opening', `seat=${seatKey} mode=${browserMode}`);
  if (!headless) {
    process.stdout.write(
      reddit
        ? 'Opening Reddit in Chrome…\n'
        : `Opening LinkedIn in Chrome for ${seatKey === 'owner' ? 'your account' : `account ${seatKey}`}…\n`
    );
  }
  const child = spawn(browserExecutable, chromeLaunchArgs({ profileDir, headless, startUrl }), {
    stdio: 'ignore',
    windowsHide: headless
  });

  const handle = { endpoint: null, child, profileDir };
  browsers.set(key, handle);
  child.once('exit', (code) => {
    activity('browser_closed', `seat=${seatKey} code=${code ?? 'unknown'}`);
    const current = browsers.get(key);
    if (current?.child === child) browsers.delete(key);
  });
  child.once('error', (error) => {
    activity('browser_error', `seat=${seatKey} ${error.message}`);
    process.stderr.write(`${browserLabel} Chrome could not start: ${error.message}\n`);
  });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const endpoint = readDevToolsEndpoint(profileDir);
    if (endpoint && (await endpointResponds(endpoint))) {
      handle.endpoint = endpoint;
      activity('browser_ready', `seat=${seatKey}`);
      return handle;
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  activity('browser_error', `seat=${seatKey} devtools endpoint unavailable`);
  throw new Error(
    `Chrome opened no DevTools endpoint for ${seatKey}. Close the Trevra Chrome window and run the command again.`
  );
}

function lockPid() {
  try {
    return Number(readFileSync(LOCK, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

function processLooksLikeCompanion(pid) {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    if (platform() === 'win32') {
      const ps = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      const command = execFileSync(
        ps,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }
      );
      return /trevra[^\r\n]*linkedin/i.test(command);
    }
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return /trevra[^\r\n]*linkedin/i.test(command);
  } catch {
    // If process inspection is unavailable, fail closed: do not decide that an
    // unrelated live PID is a Trevra process merely because an old lock reused it.
    return false;
  }
}

async function stopExistingCompanion() {
  const pid = lockPid();
  if (!pid) {
    rmSync(LOCK, { force: true });
    return;
  }
  if (!processLooksLikeCompanion(pid)) {
    rmSync(LOCK, { force: true });
    return;
  }
  process.stdout.write(`Stopping the existing foreground companion (process ${pid})…\n`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    rmSync(LOCK, { force: true });
    return;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(100);
    try {
      process.kill(pid, 0);
    } catch {
      rmSync(LOCK, { force: true });
      return;
    }
  }
  throw new Error(
    `The existing Trevra LinkedIn process ${pid} did not stop. Close it, then run install again.`
  );
}

function acquireLock() {
  ensurePrivateDir(HOME);
  try {
    const fd = openSync(LOCK, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    const pid = lockPid();
    if (pid > 0 && processLooksLikeCompanion(pid)) {
      throw new Error(`Trevra LinkedIn is already running (process ${pid}).`);
    }
    // The recorded PID is gone or belongs to something else after PID reuse.
    rmSync(LOCK, { force: true });
    const fd = openSync(LOCK, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  }
  return () => rmSync(LOCK, { force: true });
}

async function runVisibleRecovery(config, seatKey = 'owner') {
  const releaseLock = acquireLock();
  ensurePrivateDir(PROFILES);
  let stopping = false;
  let handle = null;
  let probeTimer = null;
  let probing = false;
  let verifiedAnnounced = false;

  const reportCurrentState = async () => {
    if (stopping || probing || !handle?.endpoint) return;
    probing = true;
    try {
      const healthy = await recoverySessionHealthy(handle.endpoint);
      const state = healthy ? 'verified' : 'open';
      await reportRecoveryState(config, seatKey, state);
      if (healthy && !verifiedAnnounced) {
        verifiedAnnounced = true;
        activity('recovery_session_verified', `seat=${seatKey}`);
        process.stdout.write(
          'LinkedIn is signed in. Trevra has marked this account recovered. Keep using this visible window if you need to; background campaign work remains paused until you close it.\n'
        );
      }
    } finally {
      probing = false;
    }
  };

  const finish = async (code) => {
    if (stopping) return;
    stopping = true;
    if (probeTimer) clearInterval(probeTimer);
    await reportRecoveryState(config, seatKey, 'closed');
    activity('recovery_browser_closed', `seat=${seatKey}`);
    releaseLock();
    process.exit(code);
  };

  const stopFromSignal = (code) => {
    try {
      handle?.child?.kill();
    } catch {
      /* already gone */
    }
    void finish(code);
  };
  process.once('SIGINT', () => stopFromSignal(0));
  process.once('SIGTERM', () => stopFromSignal(0));
  process.once('exit', releaseLock);

  activity('recovery_browser_opening', `seat=${seatKey}`);
  process.stdout.write(
    'Opening the dedicated LinkedIn profile visibly. Complete LinkedIn sign-in, CAPTCHA, 2FA or device verification. Trevra will mark the account recovered as soon as this window is genuinely signed in; close the window whenever you want background mode to resume.\n'
  );
  handle = await ensureBrowser(config.workspaceId, seatKey, { headless: false });
  activity('recovery_browser_ready', `seat=${seatKey}`);
  await reportRecoveryState(config, seatKey, 'open');
  await reportCurrentState();
  probeTimer = setInterval(() => void reportCurrentState(), 10_000);
  probeTimer.unref();

  if (handle.child) {
    if (handle.child.exitCode !== null) await finish(75);
    else
      handle.child.once('exit', () => {
        if (!stopping) void finish(75);
      });
    await new Promise(() => {});
  }

  // If Chrome was already open for this dedicated profile, there is no child
  // handle to watch. Poll only the loopback DevTools endpoint; once the member
  // closes that window the service exits with the normal restart code.
  while (!stopping && (await endpointResponds(handle.endpoint))) await sleep(750);
  if (!stopping) await finish(75);
}

async function runCompanion(config, options = {}) {
  const releaseLock = acquireLock();
  ensurePrivateDir(PROFILES);
  activity('companion_started', serviceInvocation ? 'mode=service' : 'mode=foreground');
  let stopping = false;
  let control = null;
  let ping = null;
  const relays = new Map();

  const closeRelays = () => {
    for (const relay of relays.values()) {
      relay.expectClose = true;
      try {
        relay.ws.close();
      } catch {
        /* already closed */
      }
    }
    relays.clear();
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (ping) clearInterval(ping);
    closeRelays();
    try {
      control?.close();
    } catch {
      /* already closed */
    }
    for (const handle of browsers.values()) {
      try {
        handle.child?.kill();
      } catch {
        /* already gone */
      }
    }
    releaseLock();
    activity('companion_stopped');
    process.stdout.write('\nTrevra LinkedIn companion stopped.\n');
  };
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
  process.once('exit', releaseLock);

  // Foreground mode opens Chrome immediately because it is also the manual
  // sign-in/debug journey. The installed service stays quiet at login and
  // opens/reuses the dedicated profile only when Trevra requests a browser.
  if (options.openBrowserAtStart !== false) {
    try {
      await ensureBrowser(config.workspaceId, 'owner', { headless: false });
      process.stdout.write(
        'Use this dedicated Chrome window only for LinkedIn; Trevra can control it while the companion is connected. Sign in if needed, then keep this command open.\n'
      );
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
    }
  }

  let backoff = 1000;
  while (!stopping) {
    try {
      await new Promise((resolveConnection, rejectConnection) => {
        const socket = new WebSocket(wsUrl(config.url), {
          headers: { authorization: `Bearer ${config.token}` }
        });
        control = socket;
        let opened = false;

        socket.once('open', () => {
          opened = true;
          backoff = 1000;
          activity('server_connected', new URL(config.url).host);
          process.stdout.write(
            `Connected to ${config.url}. LinkedIn cycles will use this computer whenever it is paired and online.\n`
          );
          ping = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
          }, 20_000);
        });

        socket.on('message', async (raw) => {
          let message;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (
            message.type === 'hello' &&
            serviceInvocation &&
            typeof message.companionVersion === 'string'
          ) {
            const targetVersion = message.companionVersion.trim();
            if (isNewerVersion(VERSION, targetVersion)) {
              activity('update_available', `from=${VERSION} to=${targetVersion}`);
              try {
                // The relay sends hello before any browser work. Updating here
                // means no LinkedIn action is interrupted halfway through.
                installStablePackage({
                  version: targetVersion,
                  // Test/development hook only. Production services do not set
                  // this, so remote updates always come from the official,
                  // version-derived Trevra GitHub release URL.
                  installSpec:
                    process.env.TREVRA_COMPANION_UPDATE_SPEC?.trim() ||
                    officialCompanionPackage(targetVersion)
                });
                activity('update_installed', `version=${targetVersion}`);
                process.stderr.write(
                  `Trevra companion updated to ${targetVersion}; restarting background service…\n`
                );
                // All supported service managers restart non-zero exits. The
                // executable path is stable, so the next process is the newly
                // installed version without touching pairing or browser state.
                process.exit(75);
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                activity('update_failed', `target=${targetVersion} ${detail}`);
                process.stderr.write(
                  `Trevra companion update to ${targetVersion} failed; continuing on ${VERSION}.\n`
                );
              }
            }
            return;
          }
          if (message.type === 'open' && message.relayId && message.seatKey) {
            const relayShort = String(message.relayId).slice(0, 8);
            activity('relay_requested', `relay=${relayShort} seat=${message.seatKey}`);
            try {
              const handle = await ensureBrowser(config.workspaceId, message.seatKey, {
                headless: options.headlessBrowser === true
              });
              const local = new WebSocket(handle.endpoint);
              const relay = { ws: local, expectClose: false };
              relays.set(message.relayId, relay);
              local.once('open', () => {
                activity('relay_ready', `relay=${relayShort} seat=${message.seatKey}`);
                socket.send(JSON.stringify({ type: 'ready', relayId: message.relayId }));
              });
              local.on('message', (data, binary) => {
                if (socket.readyState !== WebSocket.OPEN) return;
                socket.send(
                  JSON.stringify({
                    type: 'cdp',
                    relayId: message.relayId,
                    data: binary ? Buffer.from(data).toString('base64') : data.toString(),
                    binary
                  })
                );
              });
              local.once('error', (error) => {
                activity('relay_error', `relay=${relayShort} ${error.message}`);
                if (socket.readyState === WebSocket.OPEN)
                  socket.send(
                    JSON.stringify({
                      type: 'error',
                      relayId: message.relayId,
                      message: error.message
                    })
                  );
              });
              local.once('close', () => {
                const current = relays.get(message.relayId);
                relays.delete(message.relayId);
                activity(
                  'relay_closed',
                  `relay=${relayShort} expected=${Boolean(current?.expectClose)}`
                );
                if (!current?.expectClose && socket.readyState === WebSocket.OPEN) {
                  socket.send(
                    JSON.stringify({
                      type: 'error',
                      relayId: message.relayId,
                      message:
                        'The local Chrome connection closed before the Trevra browser session finished.'
                    })
                  );
                }
              });
            } catch (error) {
              activity('relay_error', `relay=${relayShort} ${error.message}`);
              if (socket.readyState === WebSocket.OPEN)
                socket.send(
                  JSON.stringify({
                    type: 'error',
                    relayId: message.relayId,
                    message: error.message
                  })
                );
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
              } catch {
                /* CDP is JSON, but forwarding it never depends on parsing it. */
              }
            }
            relay.ws.send(message.binary ? Buffer.from(message.data, 'base64') : message.data);
            return;
          }
          if (message.type === 'close' && message.relayId) {
            const relay = relays.get(message.relayId);
            if (relay) {
              relay.expectClose = true;
              relay.ws.close();
            }
            relays.delete(message.relayId);
          }
        });

        socket.once('close', (code, reason) => {
          if (ping) clearInterval(ping);
          ping = null;
          closeRelays();
          activity('server_disconnected', `code=${code} reason=${reason?.toString() || 'none'}`);
          if (stopping) resolveConnection();
          else if (code === 1008 || code === 4401)
            rejectConnection(
              new Error(
                'This companion is no longer authorised. Pair this computer again in Trevra.'
              )
            );
          else if (code === 4001)
            rejectConnection(
              new Error(
                'Another companion connected for this workspace. This computer is no longer the active companion.'
              )
            );
          else resolveConnection();
        });
        socket.once('error', (error) => {
          if (!opened) rejectConnection(error);
        });
      });
    } catch (error) {
      if (
        /no longer authorised|another companion connected|401|Unexpected server response: 401/i.test(
          error.message
        )
      ) {
        activity('companion_authorisation_stopped', error.message);
        shutdown();
        throw error;
      }
      activity('connection_error', error.message);
      process.stderr.write(`Trevra connection interrupted: ${error.message}\n`);
    }
    if (stopping) break;
    activity('reconnect_scheduled', `seconds=${Math.round(backoff / 1000)}`);
    process.stdout.write(`Reconnecting in ${Math.round(backoff / 1000)}s…\n`);
    await sleep(backoff);
    backoff = Math.min(15_000, backoff * 2);
  }
}

const SERVICE_ACTIONS = new Set([
  'setup',
  'install',
  'status',
  'logs',
  'reconnect',
  'start',
  'stop',
  'restart',
  'uninstall',
  'run'
]);
let serviceInvocation = false;

function requirePairing(config) {
  if (!config) {
    throw new Error(
      'This computer is not paired yet. In Trevra open Outreach → LinkedIn accounts → Connect this computer, then run the install command it shows.'
    );
  }
  return config;
}

function printServiceStatus(config) {
  const status = installedServiceStatus();
  process.stdout.write(`Trevra LinkedIn companion\n`);
  process.stdout.write(
    `  paired:    ${config ? `yes (${config.label || 'this computer'})` : 'no'}\n`
  );
  process.stdout.write(`  installed: ${status.installed ? `yes (${status.manager})` : 'no'}\n`);
  process.stdout.write(`  running:   ${status.running ? 'yes' : 'no'}\n`);
  if (status.version) process.stdout.write(`  version:   ${status.version}\n`);
  if (status.detail) process.stdout.write(`  service:   ${status.detail}\n`);
  if (status.installed) process.stdout.write(`  package:   ${status.serviceRoot}\n`);
}

function companionInstallSpec() {
  const installedRoot = join(HOME, 'service');
  const runningFromInstalledService =
    PACKAGE_ROOT === join(installedRoot, 'node_modules', 'trevra');
  return (
    process.env.TREVRA_COMPANION_INSTALL_SPEC?.trim() ||
    (runningFromInstalledService ? undefined : PACKAGE_ROOT)
  );
}

async function ensureBackgroundServiceInstalled({ force = false } = {}) {
  const status = installedServiceStatus();
  if (!force && status.installed && status.version === VERSION) {
    return { changed: false, status };
  }

  stopBackgroundService();
  await stopExistingCompanion();
  activity('service_install_started', `version=${VERSION}`);
  process.stdout.write(`Installing Trevra ${VERSION} as a per-user background service…\n`);
  installStablePackage({ version: VERSION, installSpec: companionInstallSpec() });
  registerBackgroundService();
  return { changed: true, status: installedServiceStatus() };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args[0];
  if (command !== 'linkedin') usage(command ? 1 : 0);

  const action = SERVICE_ACTIONS.has(args[1]) ? args[1] : 'foreground';
  let saved = readConfig();
  const requestedUrl = argValue(args, '--url') || saved?.url || 'https://app.usetrevra.com';
  const base = secureBaseUrl(requestedUrl);
  const code = argValue(args, '--pair');
  const label = argValue(args, '--label') || saved?.label || hostname();

  if (action === 'status') {
    printServiceStatus(saved);
    return;
  }
  if (action === 'setup') {
    const result = await ensureBackgroundServiceInstalled({ force: args.includes('--force') });
    if (saved) {
      if (result.changed || !result.status.running) startBackgroundService();
      activity('service_setup_ready', `version=${VERSION} paired=true`);
      process.stdout.write(
        result.changed
          ? 'Companion installed and started using the existing pairing.\n'
          : 'Companion is already installed; existing pairing is running.\n'
      );
    } else {
      stopBackgroundService();
      activity('service_setup_ready', `version=${VERSION} paired=false`);
      process.stdout.write(
        result.changed
          ? 'Companion installed. Pair this computer from Outreach → LinkedIn accounts when you are ready; no second package install will be needed.\n'
          : 'Companion is already installed and ready to pair from Outreach → LinkedIn accounts.\n'
      );
    }
    printServiceStatus(readConfig());
    return;
  }
  if (action === 'logs') {
    await showActivityLogs({
      lines: argNumber(args, '--lines', 200),
      follow: args.includes('--follow') || args.includes('-f')
    });
    return;
  }
  if (action === 'stop') {
    activity('service_stop_requested');
    stopBackgroundService();
    process.stdout.write('Trevra LinkedIn background companion stopped.\n');
    printServiceStatus(readConfig());
    return;
  }
  if (action === 'start') {
    requirePairing(saved);
    activity('service_start_requested');
    startBackgroundService();
    process.stdout.write('Trevra LinkedIn background companion started.\n');
    printServiceStatus(readConfig());
    return;
  }
  if (action === 'restart') {
    requirePairing(saved);
    activity('service_restart_requested');
    restartBackgroundService();
    process.stdout.write('Trevra LinkedIn background companion restarted.\n');
    printServiceStatus(readConfig());
    return;
  }
  if (action === 'reconnect') {
    const config = requirePairing(saved);
    const status = installedServiceStatus();
    if (!status.installed)
      throw new Error(
        'The Trevra background service is not installed. Run the install command from Trevra first.'
      );
    const seatKey = argValue(args, '--seat') || 'owner';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(seatKey))
      throw new Error('That LinkedIn account key is not valid.');
    const next = { ...config, recoveryOnNextStart: { seatKey } };
    delete next.openOnNextStart;
    saveConfig(next);
    activity('recovery_requested', `seat=${seatKey}`);
    restartBackgroundService();
    process.stdout.write(
      'Opening LinkedIn visibly on the paired computer. Complete the human check, then close that Trevra Chrome window; background mode resumes automatically.\n'
    );
    return;
  }
  if (action === 'uninstall') {
    activity('service_uninstall_requested');
    uninstallBackgroundService();
    activity('service_uninstalled');
    process.stdout.write(
      'Trevra LinkedIn background service removed. Pairing and the dedicated LinkedIn browser profile were kept.\n'
    );
    printServiceStatus(readConfig());
    return;
  }

  let config = saved;
  if (code) {
    process.stdout.write(`Pairing ${label} with ${base}…\n`);
    const paired = await pair(base, code, label);
    config = { ...readConfig(), ...paired, url: base };
    saved = config;
    activity('paired', paired.label);
    process.stdout.write(`Paired as ${paired.label}.\n`);
  }

  if (action === 'install') {
    config = requirePairing(config);
    if (config.url !== base) {
      config = { ...config, url: base };
      saveConfig(config);
    }
    // A dev/self-host setup may already have installed this exact companion.
    // Pairing then becomes cheap: reuse that package/service definition and
    // only reinstall when the version differs (or setup was explicitly forced).
    await ensureBackgroundServiceInstalled();

    // Ask the newly installed service to open the dedicated Chrome profile on
    // its FIRST start only. The one-time installer must not retain a Chrome
    // child handle itself: printing "installed" has to mean the terminal can
    // close immediately. The service clears this before opening, so a broken
    // desktop environment cannot become a browser-pop restart loop.
    saveConfig({ ...config, openOnNextStart: true });
    startBackgroundService();
    activity('service_installed', `version=${VERSION}`);
    process.stdout.write(
      'Installed. The background service is opening Trevra’s dedicated LinkedIn Chrome profile for first sign-in. It starts when you sign into this computer and restarts automatically after crashes. No terminal needs to stay open.\n'
    );
    printServiceStatus(readConfig());
    return;
  }

  if (action === 'run') {
    serviceInvocation = true;
    if (!config) {
      activity('service_waiting_for_pairing');
      return;
    }
  }

  config = requirePairing(config);
  if (config.url !== base) {
    config = { ...config, url: base };
    saveConfig(config);
  }

  if (action === 'run') {
    const requestedRecoverySeat =
      typeof config.recoveryOnNextStart?.seatKey === 'string'
        ? config.recoveryOnNextStart.seatKey
        : null;
    const firstSignIn = config.openOnNextStart === true;
    const visibleSeatKey = requestedRecoverySeat ?? (firstSignIn ? 'owner' : null);
    if (visibleSeatKey) {
      const next = { ...config };
      delete next.openOnNextStart;
      delete next.recoveryOnNextStart;
      saveConfig(next);
      config = next;
      await runVisibleRecovery(config, visibleSeatKey);
      return;
    }
    // LinkedIn background execution uses the same normal headed Chrome the
    // member can see during recovery. Do not switch the authenticated account
    // into a headless browser for unattended work: a prior unusual-activity
    // incident identified that browser-mode change as a restriction risk, and
    // hiding the browser is not a correctness requirement.
    await runCompanion(config, { openBrowserAtStart: false, headlessBrowser: false });
    return;
  }

  // Backwards-compatible foreground/debug mode. It remains useful for seeing
  // logs interactively, but the website now recommends `linkedin install`.
  await runCompanion(config, { openBrowserAtStart: true, headlessBrowser: false });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`trevra: ${message}\n`);
  // A revoked device is not a crash. Background managers restart failures, so
  // exit cleanly here to avoid an infinite restart loop until the user pairs
  // the computer again. Foreground invocations still report failure normally.
  process.exitCode =
    serviceInvocation &&
    /no longer authorised|pair this computer again|another companion connected/i.test(message)
      ? 0
      : 1;
});
