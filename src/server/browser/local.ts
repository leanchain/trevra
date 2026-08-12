/**
 * Can this process drive a real browser, and how does it open one?
 *
 * PLATFORM-NEUTRAL ON PURPOSE. Nothing here knows about Reddit, LinkedIn, or
 * any site: it answers "is Playwright installed", "is there a Chromium", "is
 * there a display", and "open a persistent context at this directory". The
 * per-platform modules own the profile directory, the selectors and the
 * refusal sentences, because those are the parts an operator reads.
 *
 * CHEAP AND NON-LAUNCHING, and that is a hard requirement rather than an
 * optimisation: these probes feed status endpoints, and a status endpoint that
 * opens Chrome is a status endpoint that hangs. Every check is a
 * `require.resolve`, a `stat` or an environment read.
 *
 * FAILS CLOSED. Anything that could not be determined counts as not ready: the
 * cost of a wrong `true` is a request routed to a process that will sit there
 * failing to launch a browser nobody can see.
 *
 * lc-debt: `linkedin/local-worker.ts` still carries its own copy of these
 * probes and its own browser singleton; this module was written for the Reddit
 * worker rather than retrofitted onto both, so a fix to a probe has two homes.
 * Upgrade path: delete the copies in linkedin/local-worker.ts and have
 * `linkedInBrowserReadiness` wrap `browserBlockers` + `displayBlocker` from
 * here, keeping its own `linkedInOffReason` wording.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const localRequire = createRequire(import.meta.url);

/** True when this process is inside a container -- the fact that explains the rest. */
export function inContainer(): boolean {
  if (existsSync('/.dockerenv')) return true;
  try {
    return /docker|containerd|podman|kubepods|lxc/i.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    // No /proc/1/cgroup is not evidence of a container; on macOS and Windows it
    // simply does not exist.
    return false;
  }
}

/**
 * Where Playwright keeps its downloaded browsers, derived rather than asked.
 *
 * Asking would mean importing playwright, which is the ~400MB load this whole
 * probe exists to avoid. The rules are Playwright's own and stable: the env
 * override wins, `0` means "inside the package", and otherwise it is the
 * platform cache directory.
 */
export function playwrightBrowsersPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured === '0') {
    try {
      return join(dirname(localRequire.resolve('playwright-core')), '.local-browsers');
    } catch {
      return null;
    }
  }
  if (configured) return configured;
  if (platform === 'win32') return join(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'ms-playwright');
}

/** A chromium build actually present in the registry, not just the registry directory. */
export function chromiumInstalled(browsersPath: string | null): boolean {
  if (!browsersPath) return false;
  try {
    if (!statSync(browsersPath).isDirectory()) return false;
    return readdirSync(browsersPath).some((entry) => entry.startsWith('chromium'));
  } catch {
    return false;
  }
}

/** The two checks a browser of ANY kind needs: the package, and a chromium build. */
export function browserBlockers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const blockers: string[] = [];

  let playwrightResolvable = false;
  try {
    localRequire.resolve('playwright');
    playwrightResolvable = true;
  } catch {
    blockers.push('Playwright is not installed here; run `npm i playwright && npx playwright install chromium`.');
  }

  // Only worth asking once playwright itself resolves: "install the browsers"
  // is not the next action for somebody who has no playwright.
  if (playwrightResolvable && !chromiumInstalled(playwrightBrowsersPath(env, platform))) {
    blockers.push('No Chromium is installed here; run `npx playwright install chromium`.');
  }

  return blockers;
}

/**
 * The one extra thing a HEADED window needs: somewhere to draw.
 *
 * THE DECISIVE SIGNAL ON LINUX -- neither X11 nor Wayland is reachable without
 * one of these variables. macOS and Windows have no equivalent and always have
 * a window server, so they answer null.
 */
export function displayBlocker(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform !== 'linux') return null;
  if (env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim()) return null;
  return 'No display is attached to this process, so a browser window cannot open here.';
}

/** The slice of a Playwright persistent context this codebase touches. */
export interface BrowserContextLike {
  pages(): unknown[];
  newPage(): Promise<unknown>;
  close(): Promise<void>;
}

export interface PlaywrightLike {
  chromium: {
    launchPersistentContext(userDataDir: string, options?: Record<string, unknown>): Promise<BrowserContextLike>;
  };
}

/**
 * Load Playwright, or report its absence and stay off.
 *
 * The specifier is typed as `string` rather than written as a literal so that
 * neither `tsc` nor the Vite marketing build tries to resolve a package that is
 * deliberately optional. A HARD dependency would add ~400MB to the container
 * image and break the Cloudflare build -- for a feature that is off on every
 * deployment except a self-hoster who asked for it.
 *
 * ABSENCE IS NEVER FATAL. This returns null; it does not throw. A worker process
 * that crashed because an optional browser was missing would take the automation
 * cycle, the playbook engine and the schedule sweep down with it.
 */
export async function loadPlaywright(): Promise<PlaywrightLike | null> {
  const specifier: string = 'playwright';
  try {
    return (await import(specifier)) as PlaywrightLike;
  } catch {
    return null;
  }
}

/**
 * Attach to a persistent Chrome profile, launching Chromium if needed.
 *
 * `--no-sandbox` goes on only in a container, where Chromium runs as root and
 * refuses to start without it. It is NOT added on a normal machine: weakening
 * the browser sandbox for a process that does not need it would be paying a
 * real cost for nothing.
 *
 * Returns the context and its first page, or null with the reason -- never
 * throws, because both callers are loops that must survive a browser that will
 * not start.
 */
export async function openPersistentBrowser(
  profileDir: string,
  options: { headless: boolean }
): Promise<{ context: BrowserContextLike; page: unknown } | { failed: string }> {
  const playwright = await loadPlaywright();
  if (!playwright) {
    return { failed: 'Playwright is not installed here; run `npm i playwright && npx playwright install chromium`.' };
  }
  try {
    const context = await playwright.chromium.launchPersistentContext(profileDir, {
      headless: options.headless,
      ...(options.headless ? {} : { viewport: null }),
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(options.headless && inContainer() ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])
      ]
    });
    const existing = context.pages()[0];
    const page = existing ?? (await context.newPage());
    return { context, page };
  } catch (cause) {
    return { failed: `Could not open the browser profile at ${profileDir}: ${cause instanceof Error ? cause.message : String(cause)}.` };
  }
}
