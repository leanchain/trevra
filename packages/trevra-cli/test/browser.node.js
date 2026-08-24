import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import {
  chromeLaunchArgs,
  minimizeBrowserWindows,
  raiseBrowserWindows,
  startMinimizeKeeper
} from '../lib/browser.js';

// A stand-in for Chrome's browser-level DevTools endpoint. It answers the three
// calls the minimize path uses and, crucially, reproduces the two behaviours
// measured against real Chrome 149 that the implementation has to cope with:
//
//   * getWindowBounds keeps reporting "normal" for a beat after setWindowBounds
//     has already resolved, so success cannot be read back immediately;
//   * something else (Target.createTarget, i.e. Playwright's newPage) can put
//     the window back to "normal" at any moment, so a single minimize does not
//     stay applied.
function fakeChrome({ confirmDelayMs = 40, confirms = true, windows = [1] } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const state = new Map(windows.map((windowId) => [windowId, 'normal']));
  const calls = [];
  const timers = new Set();

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      calls.push({ method, params });
      const reply = (result) => socket.send(JSON.stringify({ id, result }));
      if (method === 'Target.getTargets') {
        reply({
          targetInfos: [
            { type: 'browser', targetId: 'browser-target' },
            ...[...state.keys()].map((windowId) => ({
              type: 'page',
              targetId: `page-${windowId}`,
              url: 'https://www.linkedin.com/feed/'
            }))
          ]
        });
        return;
      }
      if (method === 'Browser.getWindowForTarget') {
        const windowId = Number(String(params.targetId).replace('page-', ''));
        reply({ windowId, bounds: { windowState: state.get(windowId) ?? 'normal' } });
        return;
      }
      if (method === 'Browser.setWindowBounds') {
        // Real Chrome resolves this call before the window manager has acted:
        // the new state shows up in getWindowBounds a few hundred milliseconds
        // later, or never if the request is refused.
        if (confirms) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            state.set(params.windowId, params.bounds.windowState);
          }, confirmDelayMs);
          timers.add(timer);
        }
        reply({});
        return;
      }
      if (method === 'Browser.getWindowBounds') {
        reply({ bounds: { windowState: state.get(params.windowId) ?? 'normal' } });
        return;
      }
      if (method === 'Target.activateTarget') {
        reply({});
        return;
      }
      socket.send(JSON.stringify({ id, error: { message: `unsupported ${method}` } }));
    });
  });

  return {
    ready: new Promise((resolve) => server.once('listening', resolve)),
    get endpoint() {
      const address = server.address();
      return `ws://127.0.0.1:${address.port}/devtools/browser/fake`;
    },
    state,
    calls,
    // What Playwright's first newPage() does to a minimized window, verified
    // against real Chrome: it raises it.
    raiseWindow: (windowId = 1) => state.set(windowId, 'normal'),
    close: () =>
      new Promise((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.close(resolve);
      })
  };
}

test('launch args no longer claim a Chrome switch that does not exist', () => {
  const minimized = chromeLaunchArgs({
    profileDir: '/tmp/trevra-profile',
    minimized: true,
    startUrl: 'https://www.linkedin.com/feed/'
  });
  // Chrome silently ignores unknown switches, so shipping `--start-minimized`
  // read as "minimized" in the log while every window opened focused.
  assert.ok(!minimized.includes('--start-minimized'));
  assert.ok(!minimized.includes('--start-maximized'));
  assert.ok(!minimized.includes('--headless'));
  assert.ok(minimized.includes('--user-data-dir=/tmp/trevra-profile'));
  assert.equal(minimized.at(-1), 'https://www.linkedin.com/feed/');

  const background = chromeLaunchArgs({
    profileDir: '/tmp/trevra-profile',
    headless: true,
    startUrl: 'https://www.linkedin.com/feed/'
  });
  assert.ok(background.includes('--headless'));
  assert.ok(background.includes('--window-size=1365,900'));

  const visible = chromeLaunchArgs({
    profileDir: '/tmp/trevra-profile',
    headless: false,
    startUrl: 'https://www.linkedin.com/feed/'
  });
  assert.ok(visible.includes('--start-maximized'));
  assert.ok(!visible.includes('--headless'));
});

test('minimize drives the browser over CDP and waits for it to confirm', async () => {
  const chrome = fakeChrome({ confirmDelayMs: 260 });
  await chrome.ready;
  try {
    const result = await minimizeBrowserWindows({
      endpoint: chrome.endpoint,
      WebSocketImpl: WebSocket
    });
    assert.deepEqual(result, { minimized: true, windows: 1, raised: 1, reason: null });
    assert.equal(chrome.state.get(1), 'minimized');
    const bounds = chrome.calls.find((call) => call.method === 'Browser.setWindowBounds');
    assert.deepEqual(bounds.params.bounds, { windowState: 'minimized' });
    // The window state only settled on the second read-back; a single one would
    // have declared failure for a minimize that worked.
    assert.ok(chrome.calls.filter((call) => call.method === 'Browser.getWindowBounds').length >= 2);
  } finally {
    await chrome.close();
  }
});

test('every window of the browser is minimized, once each', async () => {
  const chrome = fakeChrome({ windows: [7, 9] });
  await chrome.ready;
  try {
    const result = await minimizeBrowserWindows({
      endpoint: chrome.endpoint,
      WebSocketImpl: WebSocket
    });
    assert.equal(result.minimized, true);
    assert.equal(result.windows, 2);
    assert.deepEqual(
      chrome.calls
        .filter((call) => call.method === 'Browser.setWindowBounds')
        .map((call) => call.params.windowId),
      [7, 9]
    );
  } finally {
    await chrome.close();
  }
});

test('a minimize that never takes is reported, not silently claimed', async () => {
  const chrome = fakeChrome({ confirms: false });
  await chrome.ready;
  try {
    const result = await minimizeBrowserWindows({
      endpoint: chrome.endpoint,
      WebSocketImpl: WebSocket,
      timeoutMs: 500
    });
    assert.equal(result.minimized, false);
    assert.match(result.reason, /did not confirm/);
  } finally {
    await chrome.close();
  }
});

test('a browser that cannot be minimized is still a usable browser', async () => {
  // Nothing is listening on this endpoint. The call must resolve with a
  // loggable failure rather than throw: ensureBrowser awaits it on the path
  // that hands the relay to Trevra, and a visible browser beats no browser.
  const started = Date.now();
  const result = await minimizeBrowserWindows({
    endpoint: 'ws://127.0.0.1:1/devtools/browser/nothing-here',
    WebSocketImpl: WebSocket,
    timeoutMs: 800
  });
  assert.equal(result.minimized, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  assert.ok(Date.now() - started < 5000, 'a dead endpoint must not stall browser startup');
});

test('the keeper puts the window back down after Trevra raises it', async () => {
  const chrome = fakeChrome();
  await chrome.ready;
  const events = [];
  const stop = startMinimizeKeeper({
    endpoint: chrome.endpoint,
    WebSocketImpl: WebSocket,
    intervalMs: 40,
    timeoutMs: 2000,
    onEvent: (event) => events.push(event)
  });
  const waitForEvents = async (count) => {
    for (let attempt = 0; attempt < 200 && events.length < count; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      events.length >= count,
      true,
      `expected ${count} keeper events, saw ${events.length}`
    );
  };
  try {
    await waitForEvents(1);
    assert.deepEqual(events[0], { minimized: true, windows: 1, raised: 1, reason: null });
    assert.equal(chrome.state.get(1), 'minimized');

    // This is what context.newPage() does to the window on real Chrome, and why
    // minimizing once when the browser opens is not enough.
    chrome.raiseWindow(1);
    await waitForEvents(2);
    assert.deepEqual(events[1], { minimized: true, windows: 1, raised: 1, reason: null });
    assert.equal(chrome.state.get(1), 'minimized');
  } finally {
    stop();
    await chrome.close();
  }
});

test('the keeper gives up on a dead endpoint instead of polling forever', async () => {
  const events = [];
  const stop = startMinimizeKeeper({
    endpoint: 'ws://127.0.0.1:1/devtools/browser/nothing-here',
    WebSocketImpl: WebSocket,
    intervalMs: 20,
    timeoutMs: 200,
    onEvent: (event) => events.push(event)
  });
  try {
    for (let attempt = 0; attempt < 200 && events.length === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.length, 1);
    assert.equal(events[0].minimized, false);
    // Proven stopped: no further events arrive once it has given up.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(events.length, 1);
  } finally {
    stop();
  }
});

test('recovery can raise a window an earlier autonomous run left minimized', async () => {
  const chrome = fakeChrome({ confirmDelayMs: 0 });
  await chrome.ready;
  chrome.state.set(1, 'minimized');
  try {
    const result = await raiseBrowserWindows({
      endpoint: chrome.endpoint,
      WebSocketImpl: WebSocket
    });
    assert.equal(result.raised, true);
    assert.equal(result.restored, 1);
    assert.deepEqual(
      chrome.calls.find((call) => call.method === 'Browser.setWindowBounds').params,
      { windowId: 1, bounds: { windowState: 'normal' } }
    );
    assert.ok(chrome.calls.some((call) => call.method === 'Target.activateTarget'));
  } finally {
    await chrome.close();
  }
});

test('raising leaves a window the member already arranged alone', async () => {
  const chrome = fakeChrome({ confirmDelayMs: 0 });
  await chrome.ready;
  chrome.state.set(1, 'maximized');
  try {
    const result = await raiseBrowserWindows({
      endpoint: chrome.endpoint,
      WebSocketImpl: WebSocket
    });
    assert.equal(result.raised, true);
    assert.equal(result.restored, 0);
    assert.equal(chrome.state.get(1), 'maximized');
    assert.ok(!chrome.calls.some((call) => call.method === 'Browser.setWindowBounds'));
    // Still brought forward: recovery is the path that is meant to interrupt.
    assert.ok(chrome.calls.some((call) => call.method === 'Target.activateTarget'));
  } finally {
    await chrome.close();
  }
});
