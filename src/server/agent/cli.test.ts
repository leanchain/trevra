import { describe, expect, it } from 'vitest';
import { buildCliArgs, resolveCliBackend, type CliAgentRunInput } from './cli.js';

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
