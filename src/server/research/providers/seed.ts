import { normalizeDomain } from '../../skills/ladder.js';
import type { CandidateCompany, ResearchProvider } from '../types.js';

/**
 * Caller-supplied domain list. No credential, no network, always available.
 *
 * This provider is why `gtm.source-leads` is never a stub. Every other source
 * depends on a vendor relationship an operator may not have, and a skill whose
 * only paths are "needs-credential" is a skill that does nothing on the day it
 * ships. An operator pasting the twenty domains they already care about gets a
 * real, scored pipeline out of the same interface a vendor would feed.
 *
 * Domains are normalized through the lead ladder's `normalizeDomain`, so a
 * pasted `https://www.Shop.Example/collections/x` and a typed `shop.example`
 * are one candidate rather than two.
 */
export const seedProvider: ResearchProvider = {
  key: 'seed',
  name: 'Seed list',
  docsUrl: 'https://github.com/trevra/trevra#seed-provider',
  credentialEnvVar: null,
  retention: 'default',
  availability() {
    return { mode: 'ready', reason: 'Sources from the domain list supplied in the request; no credential or network call involved.' };
  },
  async search(query) {
    const seen = new Set<string>();
    const candidates: CandidateCompany[] = [];
    for (const raw of query.domains) {
      const domain = normalizeDomain(raw);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      candidates.push({ domain, name: null, description: null, providerKey: 'seed', sourceUrl: null });
      if (candidates.length >= query.limit) break;
    }
    const warnings = query.domains.length === 0 ? ['No domains supplied; the seed provider sources from the request only.'] : [];
    const dropped = query.domains.length - candidates.length;
    if (dropped > 0 && query.domains.length > 0) {
      warnings.push(`${dropped} supplied entr(y/ies) were duplicates, unparseable, or past the limit of ${query.limit}.`);
    }
    return {
      providerKey: 'seed',
      candidates,
      warnings,
      evidence: [
        {
          label: 'Seed list',
          detail: `${candidates.length} candidate domain(s) accepted from the ${query.domains.length} supplied by the caller.`,
          sourceUrl: null
        }
      ]
    };
  }
};
