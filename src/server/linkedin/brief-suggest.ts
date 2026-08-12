import { spawn } from 'node:child_process';
import { generateText } from 'ai';
import type { Db } from '../db.js';
import { resolveCliBackend, type CliBackend } from '../agent/cli.js';
import { resolveWorkspaceModel } from '../agent/provider.js';
import type { CompanyProfile } from '../skills/enrich.js';

/**
 * The four brief fields a homepage cannot state, PROPOSED rather than read.
 *
 * WHY THIS IS A SEPARATE FILE FROM `brief.ts`, AND MUST STAY ONE. `brief.ts`
 * projects evidence onto a form: every value it returns was READ off the
 * operator's site, and the fields nothing could fill come back empty and named
 * in `degraded`. That rule is what makes its output safe to send. This file
 * does the opposite thing on purpose -- it asks a model what the ICP and the
 * mechanism probably are -- and the two must never be confused for one another,
 * so nothing here writes into `CampaignBrief` and the caller keeps them in
 * separate fields all the way to the screen.
 *
 * A SUGGESTION IS NOT EVIDENCE, so:
 *   - `degraded` still names every field this produced. The draft response says
 *     "nothing determined these" whether or not a model then guessed at them,
 *     because a guess does not turn an unknown into a known.
 *   - proof numbers are NOT suggestible. `offer.proof` is the one field a
 *     recipient can check, so it stays bound to what enrichment COUNTED. There
 *     is no branch here that can produce one.
 *   - the operator sees these marked as suggestions and can clear them. They
 *     reach a payload only after a human left them in the form.
 *
 * TWO BACKENDS, IN THIS ORDER: the workspace's own BYOK model, else the
 * subscription CLI this deployment configured (`TREVRA_AGENT_CLI`). Neither
 * configured means no suggestion at all -- an empty result, never an error,
 * because a draft that worked before a model existed must keep working.
 */

export interface SuggestedBriefFields {
  role: string;
  segment: string;
  pain: string;
  mechanism: string;
}

export interface BriefSuggestion {
  fields: SuggestedBriefFields;
  /** Which backend produced it, for the sentence the screen shows. */
  source: 'model' | 'cli';
}

export interface SuggestDeps {
  /** Injection seam for tests. Defaults to spawning the configured CLI. */
  runCli?: (backend: CliBackend, prompt: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/** Long enough for four sentences, short enough not to hold a draft open. */
const CLI_TIMEOUT_MS = 90_000;
const FIELD_MAX_CHARS = 240;

const SYSTEM_PROMPT = [
  'You are helping a founder fill four fields of an outreach brief about their own company.',
  'You are given what that company publishes on its own site. Nothing else is known.',
  '',
  'Answer with JSON only, exactly this shape and no prose around it:',
  '{"role":"","segment":"","pain":"","mechanism":""}',
  '',
  'role      the job title most likely to buy this, singular, e.g. "Head of Engineering"',
  'segment   the kind of company they work at, e.g. "Series A dev-tools startups"',
  'pain      the problem this product removes, in the buyer\'s words, one sentence',
  'mechanism why the product actually works, one sentence, from what the site says',
  '',
  'Rules: no metrics, no percentages, no customer names, no claims the site does not',
  'support. Never invent proof. A field you cannot answer from the text is an empty',
  'string -- an empty field is a correct answer and a fabricated one is not.'
].join('\n');

/** What the model is shown: the site's own words, nothing inferred. */
function promptFor(profile: CompanyProfile): string {
  const lines = [
    `Domain: ${profile.domain}`,
    profile.name ? `Company name: ${profile.name}` : null,
    profile.description ? `What the site says it does: ${profile.description}` : null,
    profile.platform ? `Platform detected: ${profile.platform}` : null,
    profile.catalogSize === null ? null : `Products listed: ${profile.catalogSize}`,
    profile.evidence.length > 0
      ? `Evidence read from the site:\n${profile.evidence.map((row) => `- ${row.label}: ${row.detail}`).join('\n')}`
      : null
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Ask for the four fields. Null when no backend is configured, or when what
 * came back was not usable -- both of which leave the brief exactly as
 * `briefFromProfile` produced it.
 */
export async function suggestBriefFields(
  db: Db,
  workspaceId: string,
  profile: CompanyProfile,
  deps: SuggestDeps = {}
): Promise<BriefSuggestion | null> {
  const log = deps.log ?? (() => {});
  const prompt = promptFor(profile);

  // BYOK FIRST. It is the workspace's own key and its own bill; the CLI is one
  // human's personal subscription and is the fallback precisely because of that.
  try {
    const resolved = await resolveWorkspaceModel(db, workspaceId);
    if (resolved) {
      const result = await generateText({
        model: resolved.model,
        system: SYSTEM_PROMPT,
        prompt,
        maxRetries: 1
      });
      const fields = parseFields(result.text);
      return fields ? { fields, source: 'model' } : null;
    }
  } catch (cause) {
    // A model that refused is not a failed draft. The fields stay empty, which
    // is the same answer the operator got before this file existed.
    log(`Brief suggestion via the workspace model failed: ${describe(cause)}`);
  }

  let backend: CliBackend | null = null;
  try {
    backend = resolveCliBackend(deps.env ?? process.env);
  } catch (cause) {
    log(`Brief suggestion skipped: ${describe(cause)}`);
    return null;
  }
  if (!backend) return null;

  try {
    const runner = deps.runCli ?? runCliOnce;
    const fields = parseFields(await runner(backend, `${SYSTEM_PROMPT}\n\n---\n\n${prompt}`));
    return fields ? { fields, source: 'cli' } : null;
  } catch (cause) {
    log(`Brief suggestion via ${backend.kind} failed: ${describe(cause)}`);
    return null;
  }
}

/**
 * One prompt, one answer, NO TOOLS.
 *
 * Deliberately not `runHostedAgentViaCli`: that mints a scoped token, starts an
 * MCP bridge and writes a run row, because it exists to let an agent ACT. This
 * asks a question about a paragraph of text. Giving it the workspace tool
 * surface would be handing an unnecessary capability to a prompt built from a
 * page somebody else controls.
 */
async function runCliOnce(backend: CliBackend, prompt: string): Promise<string> {
  const args = backend.kind === 'claude'
    ? ['-p', prompt, '--output-format', 'text', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disallowedTools', 'Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task',
      '--disable-slash-commands', '--no-session-persistence']
    : ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', prompt];
  if (backend.model) args.push('--model', backend.model);

  const env: NodeJS.ProcessEnv = { ...process.env };
  // The same scrub the agent backend does, for the same reason: this child is
  // reading text off somebody else's website.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'DATABASE_URL', 'TREVRA_SECRETS_KEY', 'TREVRA_AGENT_TOKEN', 'TREVRA_AGENT_CLI_OAUTH_TOKEN']) {
    delete env[key];
  }
  if (backend.home) env.HOME = backend.home;
  if (backend.kind === 'claude' && backend.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = backend.oauthToken;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(backend.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${backend.bin} did not answer within ${CLI_TIMEOUT_MS}ms`)); }, CLI_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.once('error', (cause) => { clearTimeout(timer); reject(cause); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${backend.bin} exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/**
 * The four strings, or null.
 *
 * TOLERANT OF THE WRAPPER, STRICT ABOUT THE CONTENT. Models fence JSON in
 * markdown and add a sentence in front of it, and refusing that would be
 * refusing an answer we have. What is NOT tolerated is a field that is not a
 * string, a field long enough to be an essay, or an object with none of the
 * four keys -- those are the shapes that mean the model answered a different
 * question, and an empty result is better than a plausible wrong one.
 */
export function parseFields(raw: string): SuggestedBriefFields | null {
  const text = raw.trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const read = (key: keyof SuggestedBriefFields): string => {
    const value = record[key];
    if (typeof value !== 'string') return '';
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return collapsed.length > FIELD_MAX_CHARS ? '' : collapsed;
  };

  const fields = { role: read('role'), segment: read('segment'), pain: read('pain'), mechanism: read('mechanism') };
  return fields.role || fields.segment || fields.pain || fields.mechanism ? fields : null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
