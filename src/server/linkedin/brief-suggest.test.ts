import { describe, expect, it } from 'vitest';
import { parseFields, suggestBriefFields } from './brief-suggest.js';
import type { CompanyProfile } from '../skills/enrich.js';

const profile = (): CompanyProfile => ({
  domain: 'example.com',
  name: 'Example',
  legalName: null,
  description: 'A runtime for coding agents.',
  url: 'https://example.com/',
  logoUrl: null,
  telephone: null,
  address: null,
  country: null,
  emails: [],
  sameAs: [],
  platform: null,
  tech: [],
  pages: [],
  catalogSize: null,
  catalogCapped: false,
  evidence: [{ label: 'Description', detail: 'og:description', sourceUrl: 'https://example.com/' }],
  degraded: []
} as unknown as CompanyProfile);

/** No db is touched: every case here stops before the model lookup. */
const db = { prepare: () => ({ get: async () => undefined, run: async () => undefined, all: async () => [] }) } as never;

describe('parseFields', () => {
  it('reads the four fields out of a fenced answer', () => {
    expect(parseFields('Sure!\n```json\n{"role":"Head of Eng","segment":"dev tools","pain":"slow","mechanism":"graph"}\n```'))
      .toEqual({ role: 'Head of Eng', segment: 'dev tools', pain: 'slow', mechanism: 'graph' });
  });

  it('keeps an empty field empty rather than inventing one', () => {
    expect(parseFields('{"role":"CTO","segment":"","pain":"","mechanism":""}'))
      .toEqual({ role: 'CTO', segment: '', pain: '', mechanism: '' });
  });

  it('drops a field long enough to be an essay', () => {
    const long = 'x'.repeat(400);
    expect(parseFields(`{"role":"CTO","pain":"${long}"}`)?.pain).toBe('');
  });

  it('returns null when nothing usable came back', () => {
    expect(parseFields('I cannot help with that.')).toBeNull();
    expect(parseFields('{}')).toBeNull();
    expect(parseFields('{"role":42}')).toBeNull();
  });
});

describe('suggestBriefFields', () => {
  it('is a no-op when no model and no CLI are configured', async () => {
    expect(await suggestBriefFields(db, 'ws_1', profile(), { env: {}, runCli: async () => '{}' })).toBeNull();
  });

  it('asks the configured CLI and labels the answer as a suggestion', async () => {
    const seen: string[] = [];
    const result = await suggestBriefFields(db, 'ws_1', profile(), {
      env: { TREVRA_AGENT_CLI: 'claude' },
      runCli: async (_backend, prompt) => {
        seen.push(prompt);
        return '{"role":"Head of Engineering","segment":"dev tools","pain":"context churn","mechanism":"ranked graph"}';
      }
    });
    expect(result).toEqual({
      fields: { role: 'Head of Engineering', segment: 'dev tools', pain: 'context churn', mechanism: 'ranked graph' },
      source: 'cli'
    });
    // The site's own words are what it was shown -- nothing else is known.
    expect(seen[0]).toContain('A runtime for coding agents.');
    expect(seen[0]).toContain('Never invent proof.');
  });

  it('returns null rather than failing the draft when the CLI errors', async () => {
    expect(await suggestBriefFields(db, 'ws_1', profile(), {
      env: { TREVRA_AGENT_CLI: 'claude' },
      runCli: async () => { throw new Error('exit 1'); }
    })).toBeNull();
  });
});
