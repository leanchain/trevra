import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { deleteWorkspaceSecret, putWorkspaceCliAgentConfig, putWorkspaceSecret, setWorkspaceCliRiskAccepted } from '../secrets/store.js';
import { buildCliArgs, resolveCliBackend, resolveWorkspaceCliBackend, type CliAgentRunInput } from './cli.js';

const RUN: CliAgentRunInput = {
  workspaceId: 'ws_1',
  goal: 'Review the pipeline',
  trigger: 'manual',
  maxSteps: 12,
  scopes: ['skills:read', 'actions:prepare'],
  systemPrompt: 'No agent approves its own work.'
};

const PATHS = { mcpPath: '/tmp/trevra-agent-x/mcp.json', tokenPath: '/tmp/trevra-agent-x/agent-token' };

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { TREVRA_DEPLOYMENT_MODE: 'local', ...extra };
}

describe('resolveCliBackend', () => {
  it('is off unless an operator asks for it', () => {
    expect(resolveCliBackend(env())).toBeNull();
    expect(resolveCliBackend(env({ TREVRA_AGENT_CLI: '' }))).toBeNull();
  });

  it('refuses in hosted mode, because the subscription belongs to one human', () => {
    expect(() => resolveCliBackend(env({ TREVRA_AGENT_CLI: 'claude', TREVRA_DEPLOYMENT_MODE: 'hosted' })))
      .toThrow(/hosted/i);
  });

  it('refuses an unknown CLI rather than silently falling back to BYOK', () => {
    expect(() => resolveCliBackend(env({ TREVRA_AGENT_CLI: 'gemini' }))).toThrow(/claude.*codex/i);
  });

  it('defaults the binary to the CLI name and the model to the CLI default', () => {
    const backend = resolveCliBackend(env({ TREVRA_AGENT_CLI: 'codex' }));
    expect(backend).toMatchObject({ kind: 'codex', bin: 'codex', model: null });
    expect(backend?.mcpCommand.length).toBeGreaterThan(1);
  });

  it('takes the operator overrides', () => {
    const backend = resolveCliBackend(env({
      TREVRA_AGENT_CLI: 'claude',
      TREVRA_AGENT_CLI_BIN: '/opt/claude/bin/claude',
      TREVRA_AGENT_CLI_MODEL: 'claude-sonnet-4-5',
      TREVRA_AGENT_CLI_MCP_COMMAND: 'node /srv/trevra/mcp.js',
      TREVRA_API_URL: 'http://127.0.0.1:9000/'
    }));
    expect(backend).toEqual({
      kind: 'claude',
      bin: '/opt/claude/bin/claude',
      model: 'claude-sonnet-4-5',
      mcpCommand: ['node', '/srv/trevra/mcp.js'],
      apiUrl: 'http://127.0.0.1:9000',
      oauthToken: null,
      home: null
    });
  });

  it('carries the subscription token and the mounted credential directory', () => {
    expect(resolveCliBackend(env({
      TREVRA_AGENT_CLI: 'claude',
      TREVRA_AGENT_CLI_OAUTH_TOKEN: 'sk-ant-oat01-example',
      TREVRA_AGENT_CLI_HOME: '/creds'
    }))).toMatchObject({ oauthToken: 'sk-ant-oat01-example', home: '/creds' });
  });
});

describe('buildCliArgs', () => {
  const claude = resolveCliBackend(env({ TREVRA_AGENT_CLI: 'claude', TREVRA_AGENT_CLI_MODEL: 'sonnet' }))!;
  const codex = resolveCliBackend(env({ TREVRA_AGENT_CLI: 'codex' }))!;

  it('gives Claude only the Trevra MCP surface', () => {
    const args = buildCliArgs(claude, RUN, PATHS);
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain(PATHS.mcpPath);
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__trevra');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
  });

  it('removes the built-in tools that could execute something', () => {
    const args = buildCliArgs(claude, RUN, PATHS);
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'Task']) expect(args).toContain(tool);
    expect(args.indexOf('Bash')).toBeGreaterThan(args.indexOf('--disallowedTools'));
  });

  it('carries the goal and the system prompt', () => {
    const claudeArgs = buildCliArgs(claude, RUN, PATHS);
    expect(claudeArgs).toContain(RUN.goal);
    expect(claudeArgs).toContain(RUN.systemPrompt);
    // Codex has no --append-system-prompt, so the rules ride in front of the goal.
    const codexArgs = buildCliArgs(codex, RUN, PATHS);
    const prompt = codexArgs[codexArgs.length - 1];
    expect(prompt.startsWith(RUN.systemPrompt)).toBe(true);
    expect(prompt.endsWith(RUN.goal)).toBe(true);
  });

  it('points Codex at the same MCP server without approvals or writes', () => {
    const args = buildCliArgs(codex, RUN, PATHS).join(' ');
    expect(args).toContain('mcp_servers.trevra.command=');
    expect(args).toContain('mcp_servers.trevra.env.TREVRA_AGENT_TOKEN_FILE=');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('--sandbox read-only');
  });

  it('never puts a token in argv -- argv is readable through ps', () => {
    // Whatever the shape, the child is handed a PATH and reads the secret from
    // a 0600 file. Claude gets the path inside --mcp-config; Codex gets it as a
    // config override. Neither ever receives the token itself.
    for (const backend of [claude, codex]) {
      const args = buildCliArgs(backend, RUN, PATHS);
      expect(args.some((arg) => arg.includes('trv_live_'))).toBe(false);
    }
    expect(buildCliArgs(claude, RUN, PATHS)).toContain(PATHS.mcpPath);
    expect(buildCliArgs(codex, RUN, PATHS).join(' ')).toContain(PATHS.tokenPath);
  });
});

/**
 * The workspace-scoped path: a per-workspace token, gated on explicit risk
 * acceptance, usable on every deployment mode. Separate trust boundary from
 * `resolveCliBackend` above -- see cli.ts's module comment and the doc
 * comment on `resolveWorkspaceCliBackend` itself.
 */
describe('resolveWorkspaceCliBackend', () => {
  const WORKSPACE_ID = 'ws_cli_workspace_backend_test';
  const TOKEN = 'sk-ant-oat01-workspace-test-token';

  let db: Db;
  let previousSecretsKey: string | undefined;

  beforeAll(async () => {
    previousSecretsKey = process.env.TREVRA_SECRETS_KEY;
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(WORKSPACE_ID, 'CLI workspace backend test', new Date().toISOString());
  });

  beforeEach(async () => {
    await db.prepare('DELETE FROM workspace_secrets WHERE workspace_id=?').run(WORKSPACE_ID);
    await db.prepare('DELETE FROM workspace_cli_agent_config WHERE workspace_id=?').run(WORKSPACE_ID);
  });

  afterAll(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db?.close();
    if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
    else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
  });

  afterEach(() => {
    delete process.env.TREVRA_DEPLOYMENT_MODE;
  });

  it('is null with no config at all', async () => {
    expect(await resolveWorkspaceCliBackend(db, WORKSPACE_ID)).toBeNull();
  });

  it('is null with a config but no risk acceptance', async () => {
    await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: 'sonnet' });
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'cli_oauth_token', plaintext: TOKEN });
    expect(await resolveWorkspaceCliBackend(db, WORKSPACE_ID)).toBeNull();
  });

  it('is null with risk accepted but no token stored', async () => {
    await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: 'sonnet' });
    await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, true);
    expect(await resolveWorkspaceCliBackend(db, WORKSPACE_ID)).toBeNull();
  });

  it('resolves once config, risk acceptance and a token are all present', async () => {
    await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'codex', model: 'gpt-5-codex' });
    await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, true);
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'cli_oauth_token', plaintext: TOKEN });

    const backend = await resolveWorkspaceCliBackend(db, WORKSPACE_ID);
    expect(backend).toMatchObject({ kind: 'codex', bin: 'codex', model: 'gpt-5-codex', oauthToken: TOKEN, home: null });
    // The one property that matters most: nothing in the resolved shape leaks
    // into a string an operator would see, and callers downstream (driveCli,
    // childEnv) treat it exactly like the env path's backend.
    expect(JSON.stringify({ kind: backend?.kind, model: backend?.model })).not.toContain(TOKEN);
  });

  it('goes null again once risk acceptance is revoked, token stored or not', async () => {
    await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: 'sonnet' });
    await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, true);
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'cli_oauth_token', plaintext: TOKEN });
    expect(await resolveWorkspaceCliBackend(db, WORKSPACE_ID)).not.toBeNull();

    await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, false);
    expect(await resolveWorkspaceCliBackend(db, WORKSPACE_ID)).toBeNull();
  });

  it('goes null once the token is deleted, even with risk still accepted', async () => {
    await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: 'sonnet' });
    await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, true);
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'cli_oauth_token', plaintext: TOKEN });
    expect(await resolveWorkspaceCliBackend(db, WORKSPACE_ID)).not.toBeNull();

    await deleteWorkspaceSecret(db, WORKSPACE_ID, 'cli_oauth_token');
    expect(await resolveWorkspaceCliBackend(db, WORKSPACE_ID)).toBeNull();
  });

  // The regression that matters most for this function: unlike the global env
  // path (which THROWS in hosted mode), this one must resolve identically on
  // every deployment mode, because a per-workspace token is not the thing the
  // hosted refusal exists to stop.
  it('resolves identically regardless of TREVRA_DEPLOYMENT_MODE', async () => {
    await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: 'sonnet' });
    await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, true);
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'cli_oauth_token', plaintext: TOKEN });

    for (const mode of [undefined, 'local', 'hosted']) {
      if (mode === undefined) delete process.env.TREVRA_DEPLOYMENT_MODE;
      else process.env.TREVRA_DEPLOYMENT_MODE = mode;
      const backend = await resolveWorkspaceCliBackend(db, WORKSPACE_ID);
      expect(backend).toMatchObject({ kind: 'claude', model: 'sonnet', oauthToken: TOKEN });
    }
  });
});
