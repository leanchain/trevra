import 'dotenv/config';
import { validateEnvironment } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { redditWorkspaceIds } from '../server/reddit/account.js';
import {
  closeRedditBrowser,
  loginRedditAccount,
  redditBrowserReadiness,
  redditOffReason,
  redditProfileDirBase
} from '../server/reddit/local-worker.js';

/**
 * `npm run reddit:worker` -- the Reddit session, on the machine that has a
 * display.
 *
 * WHAT IT IS FOR. The API usually runs in a container: no display, no browser
 * binary, and a home directory that is not the operator's. A headless Chromium
 * can type a password, but it cannot show a human the one thing Reddit
 * eventually asks for -- a captcha. This command is the machine where that
 * window exists.
 *
 * SAME FUNCTION, DIFFERENT PROCESS. It calls `loginRedditAccount`, the same one
 * the HTTP route calls. There is no second implementation of the session rule
 * here and there must never be one: reuse first, sign in second, stamp
 * `session_valid_at` only on a session actually seen to be live.
 *
 * IT IS A KEEP-ALIVE, NOT A SEND QUEUE. Nothing in this scope pushes comments
 * on a schedule -- the operator chooses each thread and writes each reply from
 * the app. What this loop does is keep the stored session warm and give a
 * captcha somewhere to appear, so the container never has to ask a human for
 * something it cannot show them.
 *
 * REFUSES TO START rather than looping uselessly. A worker that cannot open a
 * HEADED browser contributes nothing this process is for -- the container can
 * already do headless -- so the readiness probe is a precondition here, not a
 * per-tick inconvenience.
 */

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** `--otp 123456`, for the one run where Reddit asks for a two-factor code. */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

// A config problem must arrive as one line, not as a zod stack trace. This
// command is run by an operator on their own laptop, and a wall of JSON is the
// same dead end this whole split exists to remove.
let runtime: ReturnType<typeof validateEnvironment>;
try {
  runtime = validateEnvironment();
} catch (error) {
  if (!process.env.DATABASE_URL?.trim()) {
    fail('Set DATABASE_URL to the Trevra database (your stack publishes it on localhost:45432 by default), then run this again.');
  }
  fail(`This machine's environment is not valid for Trevra: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
}

const config = runtime.redditLocalWorker;
if (!config.enabled) fail(redditOffReason(config));

const readiness = redditBrowserReadiness(config);
if (!readiness.canLaunchHeaded) fail(readiness.reasons.join(' '));

const db = await openDatabase();
/**
 * The BASE, not a profile directory. Each workspace signs into its own
 * `<base>-<workspace>-profile`, which is what stops one tenant's tick from
 * inheriting -- or overwriting -- another tenant's Reddit session. Printing a
 * single directory here would misdescribe what this loop is about to do.
 */
const profileBase = redditProfileDirBase(config.profileDir);
/** `--workspace ws_x` narrows the loop to one; absent means every workspace with a Reddit account. */
const onlyWorkspace = flag('workspace');
/** Consumed by the FIRST pass only: a two-factor code is single-use and expires in seconds. */
let otp = flag('otp');

process.stdout.write(`Reddit worker running against one Chrome profile per workspace under ${profileBase}-<workspace>-profile\n`);
process.stdout.write(`Re-checking the session every ${Math.round(runtime.automationIntervalMs / 1000)}s. Ctrl-C to stop.\n`);

let running = false;
let draining = false;

async function cycle(): Promise<void> {
  if (running || draining) return;
  running = true;
  try {
    const workspaces = onlyWorkspace ? [onlyWorkspace] : await redditWorkspaceIds(db);
    if (workspaces.length === 0) {
      process.stdout.write('No workspace has a Reddit account yet. Save your username and password in Setup to connect one.\n');
      return;
    }
    for (const workspaceId of workspaces) {
      const outcome = await loginRedditAccount(db, config, { workspaceId, otp });
      // Spent whether it worked or not: Reddit invalidates the code on the
      // attempt, so reusing it next tick would fail and burn a retry.
      otp = undefined;
      const who = outcome.username ? `u/${outcome.username}` : workspaceId;
      process.stdout.write(`[${outcome.status}] ${who}: ${outcome.message}\n`);
      if (outcome.status === 'otp_required') {
        process.stdout.write('  Re-run with `npm run reddit:worker -- --otp <code>` to finish.\n');
      }
      // ONE WINDOW AT A TIME. Each workspace now signs into its OWN profile
      // directory and its own browser, so a loop that left them all open would
      // put one headed Chrome per tenant on the operator's screen and keep
      // every one of them there. The session is not in the process, it is in
      // the profile directory on disk, so closing costs nothing this loop
      // exists to preserve.
      //
      // EXCEPT WHEN A HUMAN IS NEEDED. `otp_required` and `challenge` are the
      // two answers whose entire point is that a person finishes them in that
      // window; closing it would take away the thing this whole command exists
      // to provide.
      if (outcome.status !== 'otp_required' && outcome.status !== 'challenge') {
        await closeRedditBrowser(workspaceId);
      }
    }
  } catch (error) {
    // `loginRedditAccount` does not throw by contract. This is for the case it
    // is wrong about that: a browser problem must not end a loop the operator
    // started and walked away from.
    console.error('Reddit worker cycle failed', error);
  } finally {
    running = false;
  }
}

await cycle();
const timer = setInterval(() => void cycle(), runtime.automationIntervalMs);

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  process.stdout.write(`\n${signal} received; finishing the current pass\n`);
  clearInterval(timer);
  // A pass mid-flight has a real browser on a real page. It is allowed to
  // finish, because killing it between a click and its outcome is exactly the
  // `unknown` a human then has to settle by hand.
  const deadline = Date.now() + 20_000;
  while (running && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
  // Before the pool closes: a browser left open holds the profile directory
  // locked, and the next worker cannot attach to it.
  await closeRedditBrowser();
  await db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
