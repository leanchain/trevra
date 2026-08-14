/**
 * The local-CLI agent backend: run the hosted agent through `claude -p` or
 * `codex exec` instead of a BYOK model key.
 *
 * WHY THIS EXISTS. A self-hoster already pays for a Claude or ChatGPT
 * subscription. `provider.ts` can only spend an API key, so a founder running
 * Trevra on their own machine had to buy inference twice.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS IN, TWO DIFFERENT TRUST BOUNDARIES.
 *
 * `resolveCliBackend()` reads GLOBAL env vars
 * (`TREVRA_AGENT_CLI`/`TREVRA_AGENT_CLI_OAUTH_TOKEN`/...) set once by whoever
 * runs this server process. That one credential would then drive every
 * workspace's runs -- so on `TREVRA_DEPLOYMENT_MODE=hosted` it refuses
 * outright, the same unconditional shape the LinkedIn worker uses in
 * `config.ts`, and NO OTHER VARIABLE TURNS THIS PATH BACK ON. The reason is a
 * licence boundary, not a preference: a subscription CLI is authenticated as
 * ONE HUMAN, under consumer terms that cover that human's own use. Pointing a
 * multi-tenant service at it so other people's work is billed to one person's
 * subscription breaches those terms and gets the account terminated.
 *
 * `resolveWorkspaceCliBackend()` is a SEPARATE path added later: a workspace
 * stores its OWN token in `workspace_cli_agent_config` /
 * `workspace_secrets(kind='cli_oauth_token')` and explicitly accepts a risk
 * disclaimer (`risk_accepted_at`) before it is usable. That is a different
 * shape, not a loosening of the rule above -- it backs only that workspace's
 * own runs with that workspace's own credential, which is architecturally the
 * same thing BYOK already is (bring your own credential), not the
 * one-subscription-for-every-tenant shape the hosted refusal above exists to
 * stop. It therefore works on every deployment mode, hosted included, gated
 * instead on the workspace's own explicit consent. See the doc comment on
 * `resolveWorkspaceCliBackend` for the fuller threat model and
 * docs/cli-agent-and-hosted.md for the write-up.
 *
 * A subscription pasted into ANY automated context can still brush against
 * that subscription's own consumer terms independent of multi-tenancy --
 * that residual risk is real, is the workspace's own to take, and is exactly
 * what the risk disclaimer must say plainly before a token is ever pasted.
 * ---------------------------------------------------------------------------
 *
 * WHAT IS DIFFERENT FROM `loop.ts`. There, the AI SDK owns the tool-calling
 * loop and Trevra executes the tools. Here the CLI owns both: it decides when
 * to call a tool AND runs the call itself. So Trevra reaches it the only way a
 * CLI accepts tools at all -- over MCP, pointed at `src/mcp/server.ts`, which
 * proxies the same surface `loop.ts` gets from `tools.ts`. One tool surface,
 * two drivers; a tool added to `tools.ts` appears here with no change.
 *
 * The four things `loop.ts` says the SDK does not know about are still Trevra's
 * job and are still enforced, because they are what make an unattended model
 * loop safe rather than merely convenient:
 *
 *   budget   every assistant turn is charged via `recordAgentModelCall` and
 *            re-checked between turns; exceeding it kills the child.
 *   ledger   every turn and every tool call becomes an `agent_runs` step.
 *   scopes   the child holds a single-run token minted with exactly the hosted
 *            agent's scopes and revoked in `finally`.
 *   stop     `isAgentRunStopRequested` is polled between turns, and the kill
 *            switch signals the child rather than orphaning it.
 *
 * A subscription costs no marginal dollars, so the budget's cents are notional
 * here. They are still charged, because the cap is also the runaway guard --
 * see the note on TREVRA_AGENT_CLI_MODEL in `.env.example`.
 *
 * THE CHILD GETS NO API KEY -- AND NOTHING ELSE OUT OF THE SERVER'S
 * ENVIRONMENT EITHER. `ANTHROPIC_API_KEY` and friends never reach it: the
 * entire point is to spend the subscription, and a stray key in the operator's
 * shell would silently bill the thing they asked to avoid.
 *
 * That used to be a DENY list -- a copy of `process.env` with nine names
 * deleted -- which is the wrong shape the moment more than one tenant shares
 * this process. A deny list removes the secrets somebody remembered; every
 * secret nobody thought of was inherited by a child whose prompt a tenant
 * steers and whose context ingests scraped Reddit and LinkedIn text (the
 * prompt-injection surface `loop.ts` names). What that actually handed over:
 * `BETTER_AUTH_SECRET` (forge a session for any user in any workspace),
 * `TREVRA_SECRETS_KEY_PREVIOUS` (the rotation-window sibling of the one key
 * name that WAS denied -- it decrypts every tenant's stored LinkedIn/Reddit
 * passwords and model keys), the Stripe, Nango, Temporal and admin tokens.
 * `INHERITED_ENV` below inverts it: the child's environment is BUILT from an
 * allowlist, so the next secret added to the deployment is invisible to it
 * until someone decides otherwise in writing.
 *
 * AND THE CHILD GETS ITS OWN HOME. A run that brings its own subscription
 * token is given a scratch HOME (Claude) / CODEX_HOME (Codex) inside the run's
 * scratch directory, so one tenant's session, credentials and history cannot
 * be read by the next tenant's child, and a poisoned config cannot be left
 * behind for it to load. See `childEnv` and `claudeHomeForRun`.
 *
 * KNOWN LIMIT: a tool result over ~100k characters is written to a file by the
 * CLI, which then wants its own `read` tool to open it -- and `read` is blocked
 * here, because it reads any path in the container and Trevra's own secrets
 * live in some of them. The agent reports the result as too large rather than
 * reading it. The fix belongs in the tool, not here: a Trevra tool that returns
 * 100k characters is unusable to a model whatever opens it.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createAgentToken, revokeAgentToken, type AgentScope } from '../agent-access.js';
import type { Db } from '../db.js';
import { getWorkspaceCliAgentConfig, readWorkspaceSecretPlaintext } from '../secrets/store.js';
import { AgentBudgetError, assertAgentBudgetAvailable, recordAgentModelCall } from './budget.js';
import {
  appendAgentRunStep,
  finishAgentRun,
  getAgentRun,
  isAgentRunStopRequested,
  startAgentRun,
  type AgentRunRecord
} from './runs.js';

/** The MCP server name the child sees. Tools arrive as `mcp__trevra__*`. */
const MCP_SERVER_NAME = 'trevra';

/**
 * Built-in CLI tools the agent must not have.
 *
 * `loop.ts` is explicit that the safety of this agent rests on "no tool in this
 * surface can approve or execute". A coding CLI ships Bash and Write by
 * default, which would hand every scraped Reddit thread a shell on the
 * operator's machine. An allowlist alone is not enough -- a non-allowed tool is
 * merely un-approved, so the model still sees it, still calls it, and burns
 * turns being refused. These are removed outright.
 */
const CLAUDE_BLOCKED_TOOLS = [
  // Filesystem, shell and network.
  'Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
  'NotebookEdit', 'WebFetch', 'WebSearch',
  // Delegation and scheduling. A subagent or a cron job is a way to keep
  // working after this run's ledger, budget and kill switch have stopped
  // watching, which is the one thing an audited run must not be able to do.
  'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'TaskUpdate', 'Workflow', 'ScheduleWakeup', 'CronCreate', 'CronDelete',
  'CronList', 'Monitor', 'RemoteTrigger', 'SendMessage', 'PushNotification',
  // Everything else the CLI ships that is not a Trevra tool.
  'TodoWrite', 'Skill', 'ToolSearch', 'DesignSync', 'ReportFindings',
  'EnterWorktree', 'ExitWorktree', 'SlashCommand'
];

/**
 * The ONLY environment variables copied from this server process into the
 * child. Everything else is absent by construction.
 *
 * WHY AN ALLOWLIST AND NOT A DENY LIST. `CLAUDE_BLOCKED_TOOLS` above is a soft
 * boundary and says so itself: it is a list of tool NAMES, and a CLI release
 * that ships a new built-in ships it enabled until this file learns the name.
 * The environment has to be the hard boundary, and a deny list cannot be one.
 * Its failure mode is silent and it lives in the future: the next
 * `STRIPE_SECRET_KEY`-shaped variable added to the deployment is readable by
 * every tenant's child from the moment it is set, and nothing announces it.
 * Inverted, the failure mode is loud, immediate and cheap -- a run that needs
 * a variable it cannot see fails visibly, and the fix is one line here.
 *
 * ADDING A NAME TO THIS LIST IS A SECURITY DECISION, not a configuration
 * convenience. The question to answer first is what a hostile child holding
 * that value could do to another tenant, to the deployment, or to the
 * operator -- and the child must be assumed hostile, because its prompt is
 * tenant-steered and its context ingests scraped text. Per-run credentials are
 * NOT added here: they are set on the object `childEnv` returns, for exactly
 * one run.
 *
 * Deliberately absent even though the CLI would use them: `XDG_CONFIG_HOME`
 * and its siblings (they point the child back at the server user's shared
 * config directory, which is precisely the sharing `claudeHomeForRun` exists
 * to end), `NODE_ENV`, `DATABASE_URL`, and every `TREVRA_*` name but the one
 * tuning knob below.
 *
 * POSIX only, as the rest of this file already assumes (HOME, 0600/0700 file
 * modes). A Windows host would need `SystemRoot`/`PATHEXT`/`ComSpec` here
 * before `spawn` worked at all.
 */
const INHERITED_ENV = [
  // Find the CLI itself; the CLI's own child processes need it too.
  'PATH',
  // The credential of last resort: on a host where the CLI is already signed
  // in as the user running Trevra, HOME *is* the subscription. `childEnv`
  // REPLACES this with a per-run scratch directory whenever the run carries
  // its own token, so the inherited value survives only for that self-hoster.
  'HOME',
  // Text handling. A child that decodes its own output as ASCII mangles every
  // non-English name the agent reads back into the ledger.
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  // Scratch space: `os.tmpdir()` reads TMPDIR, and both CLIs stage large tool
  // results through it.
  'TMPDIR',
  // Egress. In the container this backend usually runs in, an outbound proxy
  // and a corporate CA bundle are the difference between a working run and a
  // run that cannot reach the model at all. Both spellings, because both are
  // conventional and neither CLI promises which it reads.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Read by the MCP bridge (`src/mcp/server.ts`), which the CLI spawns as its
  // own child and which therefore inherits exactly this environment. The
  // bridge's two REQUIRED variables (TREVRA_API_URL, TREVRA_AGENT_TOKEN_FILE)
  // are injected per run by `mcpConfig`; this optional timeout is the only one
  // an operator sets globally, and dropping it would silently undo their
  // tuning rather than fail.
  'TREVRA_AGENT_TIMEOUT_MS'
];
/** The run summary is a human's first look at the run, not a transcript. */
const SUMMARY_LIMIT = 2000;

/** Long enough for one run, short enough that a leaked token is worthless. */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/** Grace between SIGTERM and SIGKILL when the budget or kill switch fires. */
const KILL_GRACE_MS = 5_000;

/** Tail of the child's stderr kept for the failure message. */
const STDERR_LIMIT = 4_000;

export interface CliBackend {
  kind: 'claude' | 'codex';
  /** The executable. `TREVRA_AGENT_CLI_BIN` overrides it; default is the kind. */
  bin: string;
  /** Passed through to the CLI's own `--model`. Null means the CLI's default. */
  model: string | null;
  /** argv for the stdio MCP bridge the child will spawn. */
  mcpCommand: string[];
  /** Origin the bridge calls back into. */
  apiUrl: string;
  /**
   * A subscription OAuth token supplied by the operator, or null to let the CLI
   * find its own credential on disk.
   *
   * This is what makes the backend work IN A CONTAINER, where there is no
   * interactive login and no `~/.claude` to read. Trevra never mints, refreshes
   * or inspects it -- it hands the string to the child under the name that CLI
   * expects and forgets it.
   */
  oauthToken: string | null;
  /**
   * `HOME` for the child, when the credential is a mounted directory rather
   * than a token. Null means inherit the server's.
   */
  home: string | null;
}

/**
 * The configured CLI backend, or `null` when this deployment uses BYOK.
 *
 * Throws rather than returning `null` when the configuration is contradictory
 * (a CLI asked for in hosted mode, or an unknown name): an operator who set the
 * variable meant to enable something, and silently falling back to a model key
 * they may not have is the failure they would notice last.
 */
export function resolveCliBackend(env: NodeJS.ProcessEnv = process.env): CliBackend | null {
  const requested = env.TREVRA_AGENT_CLI?.trim();
  if (!requested) return null;

  if (requested !== 'claude' && requested !== 'codex') {
    throw new Error(`TREVRA_AGENT_CLI must be 'claude' or 'codex' (got '${requested}')`);
  }
  if (env.TREVRA_DEPLOYMENT_MODE === 'hosted') {
    throw new Error(
      'TREVRA_AGENT_CLI cannot be used when TREVRA_DEPLOYMENT_MODE=hosted: the CLI is signed in as one ' +
      'human under a personal subscription, and billing other tenants to it breaches that subscription. ' +
      'Configure a BYOK model key instead.'
    );
  }

  const model = env.TREVRA_AGENT_CLI_MODEL?.trim();
  return {
    kind: requested,
    bin: env.TREVRA_AGENT_CLI_BIN?.trim() || requested,
    model: model || null,
    mcpCommand: resolveMcpCommand(env),
    apiUrl: (env.TREVRA_API_URL?.trim() || `http://127.0.0.1:${env.PORT?.trim() || '43887'}`).replace(/\/$/, ''),
    oauthToken: env.TREVRA_AGENT_CLI_OAUTH_TOKEN?.trim() || null,
    home: env.TREVRA_AGENT_CLI_HOME?.trim() || null
  };
}

/**
 * The workspace-scoped CLI backend -- the opt-in third way to run the hosted
 * agent, alongside BYOK (`provider.ts`) and the operator's global env vars
 * above. See the module comment ("TWO WAYS IN, TWO DIFFERENT TRUST
 * BOUNDARIES") for the short version; this is the fuller one, and
 * docs/cli-agent-and-hosted.md has the write-up.
 *
 * THE THREAT MODEL, IN BRIEF. What a compromise of this token gets an
 * attacker: the ability to run the hosted agent AS THIS ONE WORKSPACE'S
 * subscription, bounded by the same budget, ledger, scopes and kill switch
 * every other backend is bounded by (cli.ts's own driveCli enforces those
 * identically regardless of where the credential came from). That is exactly
 * the blast radius a leaked BYOK model key already has -- one workspace's own
 * credential, spent on one workspace's own runs. It is NOT the global-env
 * path's blast radius, where a compromise (or just an honest configuration)
 * lets ONE credential silently bill EVERY tenant on the deployment, which is
 * the actual licence/ToS problem `resolveCliBackend`'s hosted refusal exists
 * to stop. Per-workspace scoping is what changes the analysis: the failure
 * mode collapses from "multi-tenant fleet backed by one stranger's
 * subscription" to "a workspace member's own subscription, misused within
 * their own workspace" -- ordinary BYOK-shaped risk, not a new category.
 *
 * docs/byok-and-hosted-agent.md section 8 says storing a new kind of secret in
 * `workspace_secrets` is "a new decision with a new threat model, not a
 * convenience." `cli_oauth_token` (this function's other half) is exactly
 * that new decision, made once, here, and for the reason above -- it is
 * explicitly OUT OF SCOPE for that document, which is about the model-key
 * secret specifically and should not grow CLI-token content wholesale.
 *
 * WHAT STILL MAKES THIS "AT YOUR OWN RISK" EVEN THOUGH SCOPING FIXES THE
 * MULTI-TENANCY PROBLEM. Pasting a personal subscription's OAuth session into
 * any automated, server-side context can itself brush against that
 * subscription's own consumer terms -- a risk that has nothing to do with
 * multi-tenancy and that per-workspace scoping does not and cannot fix. That
 * is why `risk_accepted_at` exists as an explicit, revocable, timestamped gate
 * rather than an implicit consequence of pasting a token: the workspace is
 * told this plainly before they can, and is accepting it for their own
 * subscription.
 *
 * Returns null (never throws) for a workspace that has not opted in, has not
 * accepted the risk, or has not stored a token -- this is a normal "not
 * configured" state, not an error, exactly like `resolveWorkspaceModel`
 * returning null for BYOK.
 */
export async function resolveWorkspaceCliBackend(
  db: Db,
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CliBackend | null> {
  const config = await getWorkspaceCliAgentConfig(db, workspaceId);
  if (!config || !config.riskAcceptedAt) return null;

  const token = await readWorkspaceSecretPlaintext(db, workspaceId, 'cli_oauth_token');
  if (!token) return null;

  return {
    kind: config.cli,
    // Deliberately NOT `TREVRA_AGENT_CLI_BIN`: that override is paired with the
    // operator's own single global `TREVRA_AGENT_CLI` choice, and reusing it
    // here could point a workspace's `codex` config at a binary path the
    // operator meant for `claude`, or vice versa. The kind IS the binary name
    // on a normal install.
    bin: config.cli,
    model: config.model,
    mcpCommand: resolveMcpCommand(env),
    apiUrl: (env.TREVRA_API_URL?.trim() || `http://127.0.0.1:${env.PORT?.trim() || '43887'}`).replace(/\/$/, ''),
    // The one field that differs in kind from the env path: a token read out
    // of `workspace_secrets` at resolve time rather than out of the
    // environment. From here it flows through the exact same `childEnv` /
    // `driveCli` / `buildCliArgs` code the env path uses -- nothing downstream
    // knows or cares where it came from.
    oauthToken: token,
    // No mounted-credential-directory equivalent for a workspace: `home` is a
    // machine-level escape hatch for an operator who would rather bind-mount
    // `~/.claude`/`~/.codex` than hold a token, and a workspace has no
    // filesystem of its own to mount from.
    home: null
  };
}

/**
 * argv for the MCP stdio bridge.
 *
 * Derived from this module's own location rather than the process's cwd, which
 * belongs to whoever ran `npm start` and is not ours to assume. The extension
 * we were loaded with tells us which half of the build we are in: `.ts` means
 * tsx in development, `.js` means the compiled tree.
 */
function resolveMcpCommand(env: NodeJS.ProcessEnv): string[] {
  const override = env.TREVRA_AGENT_CLI_MCP_COMMAND?.trim();
  if (override) return override.split(/\s+/).filter(Boolean);

  const self = fileURLToPath(import.meta.url);
  const source = self.endsWith('.ts');
  const bridge = fileURLToPath(new URL(source ? '../../mcp/server.ts' : '../../mcp/server.js', import.meta.url));
  if (!source) return [process.execPath, bridge];

  // ABSOLUTE, not the bare specifier `tsx`.
  //
  // The CLI spawns this command with ITS cwd, which is the run's scratch
  // directory -- so `node --import tsx` resolves `tsx` from an empty temp dir,
  // fails with ERR_MODULE_NOT_FOUND, and the MCP server comes up `failed`. The
  // CLI reports that as a status in its init event and then carries on with no
  // Trevra tools at all, which reads as a working run that did nothing.
  return [process.execPath, '--import', createRequire(import.meta.url).resolve('tsx'), bridge];
}

export interface CliAgentRunInput {
  workspaceId: string;
  goal: string;
  trigger: 'manual' | 'schedule';
  /** Already clamped by the caller. */
  maxSteps: number;
  /** Exactly the scopes the minted single-run token carries. */
  scopes: readonly AgentScope[];
  systemPrompt: string;
}

/**
 * Run the hosted agent once through the CLI, and return the finished run.
 *
 * Same failure rule as `runHostedAgent`: the caller has already done the budget
 * pre-flight, so from here on every failure is recorded ON the run and returned
 * as a 'failed' record. A row left 'running' is the thing §6 calls unauditable.
 */
export async function runHostedAgentViaCli(
  db: Db,
  backend: CliBackend,
  input: CliAgentRunInput
): Promise<AgentRunRecord> {
  const run = await startAgentRun(db, {
    workspaceId: input.workspaceId,
    trigger: input.trigger,
    goal: input.goal,
    maxSteps: input.maxSteps
  });

  let tokenId: string | null = null;
  let workDir: string | null = null;

  try {
    // One token, one run, revoked in `finally`. The child is a separate process
    // Trevra does not otherwise trust, so it gets its own credential with the
    // hosted agent's scopes and nothing else -- notably no approve and no
    // execute, which do not exist as scopes at all (loop.ts, HOSTED_AGENT_SCOPES).
    const minted = await createAgentToken(db, {
      workspaceId: input.workspaceId,
      userId: null,
      name: `hosted-agent-cli ${run.id}`,
      scopes: [...input.scopes],
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString()
    });
    tokenId = minted.record.id;

    workDir = await mkdtemp(join(tmpdir(), 'trevra-agent-'));
    const outcome = await driveCli(db, backend, input, run.id, minted.token, workDir);

    if (outcome.stopped) {
      // 'stopped', not 'failed': a human asked for this and nothing went wrong.
      await finishAgentRun(db, run.id, { status: 'stopped', summary: outcome.summary });
    } else if (outcome.error) {
      await finishAgentRun(db, run.id, { status: 'failed', summary: outcome.summary, error: outcome.error });
    } else {
      await finishAgentRun(db, run.id, { status: 'completed', summary: outcome.summary });
    }
  } catch (cause) {
    await finishAgentRun(db, run.id, {
      status: 'failed',
      error: cause instanceof Error ? cause.message : String(cause)
    });
  } finally {
    // Both are best-effort on purpose: a run that finished must not be reopened
    // by a cleanup failure. The token expires on its own either way.
    if (tokenId) await revokeAgentToken(db, input.workspaceId, null, tokenId).catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const finished = await getAgentRun(db, input.workspaceId, run.id);
  if (!finished) throw new Error(`Agent run disappeared: ${run.id}`);
  const { steps: _steps, ...record } = finished;
  return record;
}

interface CliOutcome {
  stopped: boolean;
  summary: string | null;
  error: string | null;
}

/**
 * Spawn the CLI, translate its event stream into ledger rows, and stop it when
 * the budget, the step ceiling or the kill switch says so.
 */
async function driveCli(
  db: Db,
  backend: CliBackend,
  input: CliAgentRunInput,
  runId: string,
  token: string,
  workDir: string
): Promise<CliOutcome> {
  const tokenPath = join(workDir, 'agent-token');
  const mcpPath = join(workDir, 'mcp.json');

  // The token goes in a 0600 FILE, never in argv: argv is world-readable through
  // `ps` on the machine this is designed to run on, and this token is the
  // child's entire authority over the workspace.
  await writeFile(tokenPath, token, { mode: 0o600 });
  await writeFile(mcpPath, JSON.stringify(mcpConfig(backend, tokenPath)), { mode: 0o600 });

  const args = buildCliArgs(backend, input, { mcpPath, tokenPath });
  const env = await childEnv(backend, workDir);

  // cwd is the scratch directory, not the repo: a coding CLI reads project
  // instructions from wherever it starts, and the agent's context is
  // attacker-influenced by design (loop.ts). It has nothing to find in here.
  const child = spawn(backend.bin, args, {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });

  const state: CliRunState = {
    db,
    workspaceId: input.workspaceId,
    runId,
    model: backend.model ?? backend.kind,
    maxSteps: input.maxSteps,
    steps: 0,
    summary: null,
    failure: null,
    stopped: false,
    budgetStop: null,
    lastEventAt: Date.now(),
    pendingTools: new Map(),
    halt: false
  };

  let spawnError: unknown = null;
  let killTimer: NodeJS.Timeout | null = null;
  const kill = (): void => {
    if (child.killed || child.exitCode !== null) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    killTimer.unref();
  };

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });

  child.once('error', (cause) => { spawnError = cause; });
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });

  const lines = createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let event: Record<string, unknown>;
      try {
        event = asRecord(JSON.parse(trimmed));
      } catch {
        // Not every line a CLI prints is an event. Skipping is right; failing
        // the run because a banner appeared on stdout is not.
        continue;
      }
      if (backend.kind === 'claude') await handleClaudeEvent(state, event);
      else await handleCodexEvent(state, event);
      if (state.halt) {
        kill();
        break;
      }
    }
  } finally {
    lines.close();
    // Keep draining after we stop reading. A child that fills its stdout pipe
    // blocks on write, and a blocked child never sees SIGTERM cleanly -- so
    // stopping the run would turn into waiting out the SIGKILL grace period.
    child.stdout.resume();
  }

  const code = await exited;
  if (killTimer) clearTimeout(killTimer);

  if (spawnError) {
    throw new Error(
      `Could not run '${backend.bin}': ${describeError(spawnError)}. ` +
      'Install the CLI and sign it in, or set TREVRA_AGENT_CLI_BIN to its path.'
    );
  }

  const summary = truncate(state.summary);
  if (state.stopped) return { stopped: true, summary, error: null };
  if (state.budgetStop) return { stopped: false, summary, error: state.budgetStop };
  if (state.failure) return { stopped: false, summary, error: state.failure };
  // `state.halt` means Trevra killed it, so a non-zero code is the signal we
  // sent, not a failure. Only an exit nobody asked for is reported as one.
  if (!state.halt && code !== 0) {
    return {
      stopped: false,
      summary,
      error: `${backend.bin} exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`
    };
  }
  return { stopped: false, summary, error: null };
}

interface CliRunState {
  db: Db;
  workspaceId: string;
  runId: string;
  /** Fallback label when the CLI does not name the model it used. */
  model: string;
  maxSteps: number;
  steps: number;
  summary: string | null;
  failure: string | null;
  stopped: boolean;
  budgetStop: string | null;
  lastEventAt: number;
  /** tool_use id -> what was called, so the result event can name it. */
  pendingTools: Map<string, { name: string; input: unknown }>;
  /** Set when the loop should stop the child after this event. */
  halt: boolean;
}

/**
 * Claude Code's `--output-format stream-json` events.
 *
 * `assistant` is one model turn, `user` carries the tool results for the turn
 * before it, and `result` closes the run. Anything else -- init banners,
 * partial-message chunks -- is not ledger material and is ignored.
 */
async function handleClaudeEvent(state: CliRunState, event: Record<string, unknown>): Promise<void> {
  if (event.type === 'assistant') {
    const message = asRecord(event.message);
    const content = Array.isArray(message.content) ? message.content : [];
    const toolCalls: string[] = [];
    let text = '';

    for (const entry of content) {
      const block = asRecord(entry);
      if (block.type === 'text') text += String(block.text ?? '');
      if (block.type !== 'tool_use') continue;
      const name = String(block.name ?? 'unknown');
      toolCalls.push(name);
      state.pendingTools.set(String(block.id ?? ''), { name, input: block.input });
    }
    if (text.trim()) state.summary = text;

    const usage = asRecord(message.usage);
    await recordModelTurn(state, {
      model: typeof message.model === 'string' ? message.model : state.model,
      text,
      finishReason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      toolCalls,
      // `null`, not `?? 0`: absent usage is not zero usage, and budget.ts
      // charges a floor for it rather than letting the run be free forever.
      promptTokens: numberOrNull(usage.input_tokens),
      completionTokens: numberOrNull(usage.output_tokens)
    });
    return;
  }

  if (event.type === 'user') {
    const message = asRecord(event.message);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const entry of content) {
      const block = asRecord(entry);
      if (block.type !== 'tool_result') continue;
      const key = String(block.tool_use_id ?? '');
      const pending = state.pendingTools.get(key);
      state.pendingTools.delete(key);
      const failed = block.is_error === true;
      await recordToolStep(state, {
        toolName: pending?.name ?? 'unknown',
        input: pending?.input,
        output: failed ? undefined : block.content,
        error: failed ? describeContent(block.content) : null
      });
    }
    return;
  }

  if (event.type === 'result') {
    const result = typeof event.result === 'string' ? event.result : null;
    if (result?.trim()) state.summary = result;
    const subtype = typeof event.subtype === 'string' ? event.subtype : null;
    if (event.is_error === true || (subtype !== null && subtype !== 'success')) {
      state.failure ??= result?.trim() || `the CLI ended with '${subtype ?? 'an error'}'`;
    }
  }
}

/**
 * Codex's `exec --json` events.
 *
 * Shaped differently from Claude's: work arrives as `item.completed` entries
 * and usage is reported once per TURN rather than per message, so the charge
 * and the between-turn checks hang off `turn.completed` instead of off each
 * model step. Item types Trevra has no ledger row for are ignored.
 */
async function handleCodexEvent(state: CliRunState, event: Record<string, unknown>): Promise<void> {
  if (event.type === 'item.completed') {
    const item = asRecord(event.item);
    const kind = String(item.item_type ?? item.type ?? '');

    if (kind === 'agent_message') {
      const text = String(item.text ?? '');
      if (text.trim()) state.summary = text;
      state.steps += 1;
      await appendAgentRunStep(state.db, {
        runId: state.runId,
        workspaceId: state.workspaceId,
        kind: 'model',
        input: { step: state.steps, model: state.model },
        output: { text, finishReason: null, toolCalls: [] },
        durationMs: elapsed(state)
      });
      return;
    }

    if (kind === 'mcp_tool_call') {
      const failed = String(item.status ?? '') === 'failed';
      const name = [item.server, item.tool].filter((part) => typeof part === 'string' && part).join('__');
      await recordToolStep(state, {
        toolName: name || 'unknown',
        input: item.arguments ?? item.input,
        output: failed ? undefined : (item.result ?? item.output),
        error: failed ? describeContent(item.error ?? item.result) : null
      });
    }
    return;
  }

  if (event.type === 'turn.completed') {
    const usage = asRecord(event.usage);
    await recordAgentModelCall(state.db, {
      workspaceId: state.workspaceId,
      runId: state.runId,
      model: state.model,
      promptTokens: numberOrNull(usage.input_tokens),
      completionTokens: numberOrNull(usage.output_tokens)
    });
    await afterTurn(state);
    return;
  }

  if (event.type === 'turn.failed' || event.type === 'error') {
    const message = typeof event.message === 'string' ? event.message : describeContent(event.error);
    state.failure ??= message || 'the CLI reported an error';
    state.halt = true;
  }
}

/**
 * One model turn: charge it, write it, then decide whether to keep going.
 *
 * The charge goes FIRST for the reason loop.ts gives: if only one of the two
 * writes lands, it should be the one that costs the workspace money.
 */
async function recordModelTurn(
  state: CliRunState,
  turn: {
    model: string;
    text: string;
    finishReason: string | null;
    toolCalls: string[];
    promptTokens: number | null;
    completionTokens: number | null;
  }
): Promise<void> {
  state.steps += 1;
  const durationMs = elapsed(state);

  await recordAgentModelCall(state.db, {
    workspaceId: state.workspaceId,
    runId: state.runId,
    model: turn.model,
    promptTokens: turn.promptTokens,
    completionTokens: turn.completionTokens
  });

  await appendAgentRunStep(state.db, {
    runId: state.runId,
    workspaceId: state.workspaceId,
    kind: 'model',
    input: { step: state.steps, model: turn.model },
    output: { text: turn.text, finishReason: turn.finishReason, toolCalls: turn.toolCalls },
    durationMs
  });

  await afterTurn(state);
}

async function recordToolStep(
  state: CliRunState,
  step: { toolName: string; input: unknown; output?: unknown; error: string | null }
): Promise<void> {
  await appendAgentRunStep(state.db, {
    runId: state.runId,
    workspaceId: state.workspaceId,
    kind: 'tool',
    toolName: step.toolName,
    input: step.input,
    output: step.output,
    error: step.error,
    durationMs: elapsed(state)
  });
}

/**
 * The three reasons to stop, checked between turns rather than mid-turn: the
 * step ceiling, the operator's kill switch, and the budget. Each sets `halt`,
 * and the caller signals the child.
 */
async function afterTurn(state: CliRunState): Promise<void> {
  if (state.steps >= state.maxSteps) {
    state.halt = true;
    return;
  }
  if (await isAgentRunStopRequested(state.db, state.runId)) {
    state.stopped = true;
    state.halt = true;
    return;
  }
  try {
    await assertAgentBudgetAvailable(state.db, state.workspaceId);
  } catch (cause) {
    if (!(cause instanceof AgentBudgetError)) throw cause;
    state.budgetStop = cause.message;
    state.halt = true;
  }
}

/**
 * Time since the previous event, and the honest limit of what a CLI stream can
 * tell us: events alternate model turn / tool results, so the gap before an
 * assistant event is the model call and the gap before a tool result is that
 * tool. It is wall clock between events, not a number the CLI reported.
 */
function elapsed(state: CliRunState): number {
  const now = Date.now();
  const ms = now - state.lastEventAt;
  state.lastEventAt = now;
  return ms;
}

function mcpConfig(backend: CliBackend, tokenPath: string): Record<string, unknown> {
  const [command, ...args] = backend.mcpCommand;
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command,
        args,
        env: { TREVRA_API_URL: backend.apiUrl, TREVRA_AGENT_TOKEN_FILE: tokenPath }
      }
    }
  };
}

/**
 * The child's argv.
 *
 * Exported for the tests, which assert the parts that are load-bearing rather
 * than cosmetic: the built-in tools are removed, the operator's own MCP servers
 * are not loaded, and the token appears nowhere in argv.
 */
export function buildCliArgs(
  backend: CliBackend,
  input: CliAgentRunInput,
  paths: { mcpPath: string; tokenPath: string }
): string[] {
  return backend.kind === 'claude'
    ? claudeArgs(backend, input, paths.mcpPath)
    : codexArgs(backend, input, paths.tokenPath);
}

function claudeArgs(backend: CliBackend, input: CliAgentRunInput, mcpPath: string): string[] {
  const args = [
    '-p', input.goal,
    '--output-format', 'stream-json', '--verbose',
    // `--strict-mcp-config` matters: without it the child also loads whatever
    // MCP servers the operator configured for their own interactive use, and
    // the agent's tool surface stops being the one tools.ts describes.
    '--strict-mcp-config', '--mcp-config', mcpPath,
    '--allowedTools', `mcp__${MCP_SERVER_NAME}`,
    // An allowlist alone does NOT remove a tool -- it only auto-approves one,
    // and a built-in that needs no approval still runs. The deny list is what
    // actually leaves the agent with the Trevra surface and nothing else.
    //
    // It is a list of NAMES, so it is version-sensitive: a CLI release that
    // ships a new built-in ships it enabled here until this list learns about
    // it. `system/init` in the stream names every tool the child got -- read it
    // after a CLI upgrade and add anything unexpected.
    '--disallowedTools', ...CLAUDE_BLOCKED_TOOLS,
    '--disable-slash-commands',
    '--append-system-prompt', input.systemPrompt,
    '--no-session-persistence'
  ];
  if (backend.model) args.push('--model', backend.model);
  return args;
}

function codexArgs(backend: CliBackend, input: CliAgentRunInput, tokenPath: string): string[] {
  const [command, ...rest] = backend.mcpCommand;
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--ephemeral',
    // Read-only with no approvals: the agent's only sanctioned capability is
    // the Trevra MCP surface, and an approval prompt in a headless run is a
    // hang, not a safeguard.
    '--sandbox', 'read-only',
    '-c', 'approval_policy="never"',
    '-c', `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(command)}`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(rest)}`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.env.TREVRA_API_URL=${JSON.stringify(backend.apiUrl)}`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.env.TREVRA_AGENT_TOKEN_FILE=${JSON.stringify(tokenPath)}`
  ];
  if (backend.model) args.push('--model', backend.model);
  // Codex has no append-system-prompt, so the rules ride in front of the goal.
  args.push(`${input.systemPrompt}\n\n---\n\n${input.goal}`);
  return args;
}

/**
 * The child's environment: BUILT from `INHERITED_ENV`, plus the one credential
 * this run must have and nothing else.
 *
 * The direction matters more than the contents. Nothing reaches the child
 * because it happened to be set on the server -- a name is either in
 * `INHERITED_ENV` (a decision, with a comment) or it is set right here, for
 * this run. See `INHERITED_ENV` for why the previous deny list could not hold.
 *
 * TWO WAYS TO GIVE IT A SUBSCRIPTION, and the first is the one that works in a
 * container -- which is where this backend usually runs, so it is the default
 * shape rather than the fallback:
 *
 *   TREVRA_AGENT_CLI_OAUTH_TOKEN  a long-lived subscription token (Claude:
 *                                 `claude setup-token`. Codex: the ChatGPT
 *                                 access token from `~/.codex/auth.json`).
 *                                 Nothing needs to be mounted and nothing
 *                                 needs an interactive login.
 *   TREVRA_AGENT_CLI_HOME         a mounted credential directory, for an
 *                                 operator who would rather bind-mount
 *                                 ~/.claude or ~/.codex than copy a token.
 *
 * Neither is required on a host where the CLI is already signed in as the user
 * running Trevra: then the inherited HOME is the credential.
 *
 * Codex has no auth environment variable, so a token is materialised into a
 * per-run CODEX_HOME by `codex login --with-access-token`, which reads STDIN.
 * The token never reaches argv, and the directory dies with the run.
 *
 * A TOKEN ALSO BUYS A PRIVATE HOME, on both backends and for the same reason:
 * a token-carrying run is the multi-tenant shape (`resolveWorkspaceCliBackend`
 * mints one per workspace), so it must not read or write the server user's
 * `~/.claude`. Codex already had this; `claudeHomeForRun` is Claude's half.
 * When an operator sets BOTH a token and TREVRA_AGENT_CLI_HOME, the token wins
 * and the mounted directory is left alone: the token is the credential in use,
 * and the mount would only reintroduce the shared state.
 *
 * Exported for the tests, which assert the property that matters -- a
 * representative deployment secret is ABSENT from what the child gets, while
 * the run still has what it needs to work.
 */
export async function childEnv(backend: CliBackend, workDir: string): Promise<NodeJS.ProcessEnv> {
  const copy: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) copy[key] = value;
  }
  if (backend.home) copy.HOME = backend.home;

  if (backend.kind === 'claude') {
    if (backend.oauthToken) {
      copy.CLAUDE_CODE_OAUTH_TOKEN = backend.oauthToken;
      copy.HOME = await claudeHomeForRun(workDir);
      // Belt and braces: recent CLI versions relocate the config directory with
      // CLAUDE_CONFIG_DIR independently of HOME, and the whole point here is
      // that neither can land in the server user's home.
      copy.CLAUDE_CONFIG_DIR = join(copy.HOME, '.claude');
    }
    return copy;
  }

  if (backend.home) copy.CODEX_HOME = join(backend.home, '.codex');
  if (backend.oauthToken) copy.CODEX_HOME = await codexHomeFromToken(backend, workDir, copy);
  return copy;
}

/**
 * A scratch HOME for one Claude run, and the second half of the isolation
 * `INHERITED_ENV` begins.
 *
 * WHY. `--no-session-persistence` stops a run from RESUMING another run's
 * session; it does not stop the CLI from reading and writing the single
 * `~/.claude` it finds. On a self-hoster's machine that directory is the
 * operator's own and sharing it is the point -- which is why an inherited HOME
 * stays inherited when there is no token to isolate. In a deployment where
 * every workspace arrives with its own subscription token, sharing it means
 * one tenant's child can read the previous tenant's credentials, session store
 * and history, and -- worse, because it outlives the run -- can WRITE a
 * config or instruction file that the next tenant's run loads. That turns a
 * shared directory into a prompt-injection channel between tenants, which is
 * the one thing the scratch cwd in `driveCli` was already careful about.
 *
 * So a run that brings its own token gets its own HOME, 0700, inside the run's
 * scratch directory, deleted with it by `runHostedAgentViaCli`'s `finally` --
 * the same lifecycle Codex's scratch CODEX_HOME has always had.
 *
 * SEEDED WITH ONLY WHAT THE RUN NEEDS: the directory, and the one flag that
 * keeps a first-run CLI from stopping to onboard a human who is not there. The
 * credential itself never lands on disk; it is passed as
 * CLAUDE_CODE_OAUTH_TOKEN.
 */
async function claudeHomeForRun(workDir: string): Promise<string> {
  const home = join(workDir, 'claude-home');
  await mkdir(join(home, '.claude'), { mode: 0o700, recursive: true });

  // Written to both places the CLI has kept this file across versions; the
  // version that does not read one simply ignores an unknown file, and being
  // wrong here costs a stray 47-byte file in a directory that is about to be
  // deleted.
  const seed = JSON.stringify({ hasCompletedOnboarding: true });
  await writeFile(join(home, '.claude.json'), seed, { mode: 0o600 });
  await writeFile(join(home, '.claude', '.claude.json'), seed, { mode: 0o600 });

  return home;
}

/** Log a scratch CODEX_HOME in with the operator's token, and return its path. */
async function codexHomeFromToken(
  backend: CliBackend,
  workDir: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const home = join(workDir, 'codex-home');
  await mkdir(home, { mode: 0o700, recursive: true });

  await new Promise<void>((resolve, reject) => {
    const login = spawn(backend.bin, ['login', '--with-access-token'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...env, CODEX_HOME: home }
    });
    let stderr = '';
    login.stderr.setEncoding('utf8');
    login.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
    login.once('error', reject);
    login.once('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`codex login rejected TREVRA_AGENT_CLI_OAUTH_TOKEN: ${stderr.trim() || `exit ${code}`}`)));
    login.stdin.end(`${backend.oauthToken}\n`);
  });

  return home;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function describeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string | null): string | null {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return null;
  return trimmed.length <= SUMMARY_LIMIT ? trimmed : `${trimmed.slice(0, SUMMARY_LIMIT)}…`;
}
