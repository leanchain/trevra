// CHROME HAS NO "START MINIMIZED" SWITCH.
//
// Companion 0.2.9 shipped `--start-minimized` and logged
// `browser_opening mode=minimized` on every autonomous relay, and every one of
// those windows still opened focused and in front of whatever the member was
// doing. Chrome drops switches it does not recognise without a word, so the
// flag was pure decoration. Measured on this machine, Chrome 149.0.7827.200:
//
//   * the browser binary's switch table contains start-maximized,
//     start-fullscreen, window-position and window-size -- and no
//     start-minimized at all;
//   * launching with `--start-minimized` yields an X11 window that is
//     `Map State: IsViewable` with `_NET_WM_STATE_FOCUSED`, i.e. exactly the
//     desktop takeover the member reported.
//
// The window state therefore has to be set through the browser itself, over the
// DevTools endpoint the companion already holds for the relay. That works
// regardless of window manager, needs no wmctrl/xdotool, and is the same code
// path on Windows and macOS. `--window-position=-32000,-32000` would also get
// the window off screen on X11, but a window that is off screen *and* whose
// minimize failed is a window the member cannot find or close, so it is not
// worth the belt-and-braces.

const DEFAULT_CDP_TIMEOUT_MS = 3000;
const MINIMIZE_KEEPER_INTERVAL_MS = 1500;
// A keeper whose endpoint has gone away must stop rather than poll a dead
// socket for the rest of the companion's life: the browser it was minimizing
// can disappear without the child-exit hook firing (reused profiles have no
// child process to watch at all).
const MINIMIZE_KEEPER_MAX_FAILURES = 5;

export function chromeLaunchArgs({ profileDir, headless = false, minimized = false, startUrl }) {
  const args = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode'
  ];
  if (headless) {
    args.push('--headless', '--window-size=1365,900');
  } else if (!minimized) {
    // Minimized mode deliberately adds no window switch: there is none that
    // works (see the note above), and `--start-maximized` would only make the
    // brief pre-minimize flash bigger. minimizeBrowserWindows() finishes the job.
    args.push('--start-maximized');
  }
  args.push(startUrl);
  return args;
}

function connectCdp({ endpoint, WebSocketImpl, timeoutMs = DEFAULT_CDP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocketImpl(endpoint);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const failAll = (error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.terminate?.();
      } catch {
        /* already gone */
      }
      reject(new Error('devtools connect timed out'));
    }, timeoutMs);
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof message?.id !== 'number') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error)
        entry.reject(new Error(String(message.error?.message ?? 'devtools call failed')));
      else entry.resolve(message.result ?? {});
    });
    socket.once('error', (error) => {
      clearTimeout(connectTimer);
      const failure = error instanceof Error ? error : new Error(String(error));
      failAll(failure);
      if (settled) return;
      settled = true;
      reject(failure);
    });
    socket.once('close', () => {
      clearTimeout(connectTimer);
      const failure = new Error('devtools socket closed');
      failAll(failure);
      if (settled) return;
      settled = true;
      reject(failure);
    });
    socket.once('open', () => {
      clearTimeout(connectTimer);
      if (settled) return;
      settled = true;
      resolve({
        get open() {
          return socket.readyState === 1;
        },
        send(method, params = {}) {
          return new Promise((resolveCall, rejectCall) => {
            const id = nextId;
            nextId += 1;
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCall(new Error(`${method} timed out`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (result) => {
                clearTimeout(timer);
                resolveCall(result);
              },
              reject: (error) => {
                clearTimeout(timer);
                rejectCall(error);
              }
            });
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              clearTimeout(timer);
              pending.delete(id);
              rejectCall(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            /* already closed */
          }
        }
      });
    });
  });
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

// Window state is only reachable per target, so the page targets are what maps
// the browser onto its windows. Returns windowId -> windowState, deduplicated:
// every tab of one window answers with the same windowId, and setting the same
// bounds once per tab would be pointless work.
async function windowStates(client) {
  const { targetInfos } = await client.send('Target.getTargets');
  const pages = (Array.isArray(targetInfos) ? targetInfos : []).filter(
    (target) => target?.type === 'page' && target?.targetId
  );
  const windows = new Map();
  for (const page of pages) {
    try {
      const { windowId, bounds } = await client.send('Browser.getWindowForTarget', {
        targetId: page.targetId
      });
      if (typeof windowId !== 'number' || windows.has(windowId)) continue;
      windows.set(windowId, String(bounds?.windowState ?? 'normal'));
    } catch {
      // The tab closed between listing and asking. Another pass will see the
      // browser as it actually is; one vanished target must not abort the rest.
    }
  }
  return windows;
}

async function applyMinimize(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const windows = await windowStates(client);
  if (windows.size === 0)
    return { minimized: false, windows: 0, raised: 0, reason: 'no browser window found' };

  const raised = [...windows.entries()]
    .filter(([, state]) => state !== 'minimized')
    .map(([windowId]) => windowId);
  if (raised.length === 0)
    return { minimized: true, windows: windows.size, raised: 0, reason: null };

  for (const windowId of raised) {
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' }
    });
  }

  // VERIFY, DO NOT ASSUME -- AND DO NOT VERIFY IMMEDIATELY.
  //
  // setWindowBounds resolves as soon as Chrome has asked the window manager;
  // measured against Chrome 149 on X11, Browser.getWindowBounds still answers
  // `windowState: "normal"` right afterwards and only flips to "minimized"
  // about 400ms later. A single read-back would report failure for a minimize
  // that worked perfectly -- which is the same class of lie as the flag this
  // replaces, just in the other direction. So poll until the browser agrees or
  // the deadline passes, and only then call it a failure.
  const unconfirmed = new Set(raised);
  while (unconfirmed.size > 0 && Date.now() < deadline) {
    await delay(120);
    for (const windowId of [...unconfirmed]) {
      try {
        const { bounds } = await client.send('Browser.getWindowBounds', { windowId });
        if (bounds?.windowState === 'minimized') unconfirmed.delete(windowId);
      } catch {
        // Window closed underneath us; nothing left to keep minimized.
        unconfirmed.delete(windowId);
      }
    }
  }

  return {
    minimized: unconfirmed.size === 0,
    windows: windows.size,
    raised: raised.length,
    reason: unconfirmed.size === 0 ? null : 'window manager did not confirm minimized'
  };
}

// Minimize every window of an already-running browser through its own DevTools
// endpoint. Never throws: a browser that is up and visible beats a browser that
// the companion refused to use because it could not be tidied away, so the
// caller gets a result to log and carries on either way.
export async function minimizeBrowserWindows({
  endpoint,
  WebSocketImpl,
  timeoutMs = DEFAULT_CDP_TIMEOUT_MS
}) {
  let client = null;
  try {
    client = await connectCdp({ endpoint, WebSocketImpl, timeoutMs });
    return await applyMinimize(client, timeoutMs);
  } catch (error) {
    return {
      minimized: false,
      windows: 0,
      raised: 0,
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    client?.close();
  }
}

// Restore and focus a browser that may have been minimized by an earlier
// autonomous run. Recovery and the foreground/debug mode are the paths that are
// *supposed* to interrupt the member, and they reuse the same dedicated profile
// the background service minimizes -- without this, `trevra linkedin reconnect`
// against a still-running Chrome would ask the member to complete a sign-in in
// a window they cannot see. Only genuinely minimized windows are restored:
// nothing else about the member's window layout is ours to change.
export async function raiseBrowserWindows({
  endpoint,
  WebSocketImpl,
  timeoutMs = DEFAULT_CDP_TIMEOUT_MS
}) {
  let client = null;
  try {
    client = await connectCdp({ endpoint, WebSocketImpl, timeoutMs });
    const windows = await windowStates(client);
    let restored = 0;
    for (const [windowId, state] of windows) {
      if (state !== 'minimized') continue;
      await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      restored += 1;
    }
    const { targetInfos } = await client.send('Target.getTargets');
    const page = (Array.isArray(targetInfos) ? targetInfos : []).find(
      (target) => target?.type === 'page' && target?.targetId
    );
    if (page) await client.send('Target.activateTarget', { targetId: page.targetId });
    return { raised: true, restored, reason: null };
  } catch (error) {
    return {
      raised: false,
      restored: 0,
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    client?.close();
  }
}

// ONE MINIMIZE IS NOT ENOUGH.
//
// Trevra drives the companion's Chrome with Playwright over the relay, and the
// first thing a run does is open a page in the reused context. Measured on
// Chrome 149: `Target.createTarget` -- which is what `context.newPage()` sends --
// puts a minimized window straight back to `IsViewable` + `_NET_WM_STATE_FOCUSED`.
// Playwright raises the window for some other operations too. So a minimize
// applied once when the browser opens is undone by the very first action of
// every campaign, which is indistinguishable, from the member's desk, from not
// minimizing at all.
//
// The keeper re-asserts the state on a slow poll, which bounds how long a raise
// is visible without needing an event Chrome does not offer (the Browser domain
// has no window-bounds-changed notification). It runs only while the companion
// holds a browser in minimized mode -- recovery starts no keeper, and a keeper
// dies with the process that started it, so it can never fight a member who
// asked for a visible window.
export function startMinimizeKeeper({
  endpoint,
  WebSocketImpl,
  intervalMs = MINIMIZE_KEEPER_INTERVAL_MS,
  timeoutMs = DEFAULT_CDP_TIMEOUT_MS,
  onEvent = () => {}
}) {
  let stopped = false;
  let running = false;
  let failures = 0;
  let client = null;

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    client?.close();
    client = null;
  };

  const tick = async () => {
    // Overlapping ticks would fight each other over the same windowId while a
    // minimize is still being confirmed; skip instead of queueing.
    if (stopped || running) return;
    running = true;
    try {
      if (!client?.open) client = await connectCdp({ endpoint, WebSocketImpl, timeoutMs });
      const result = await applyMinimize(client, timeoutMs);
      failures = 0;
      // Quiet unless something actually had to be fixed: the steady state is a
      // window that is already minimized, and logging that every 1.5s would
      // drown the activity log the member reads.
      if (result.raised > 0 || !result.minimized) onEvent(result);
    } catch (error) {
      client?.close();
      client = null;
      failures += 1;
      if (failures >= MINIMIZE_KEEPER_MAX_FAILURES) {
        stop();
        onEvent({
          minimized: false,
          windows: 0,
          raised: 0,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return stop;
}
