import { useEffect, useState } from 'react';
import { BrandMark } from './ui/BrandMark';
import {
  ArrowRight,
  Check,
  Cloud,
  Github,
  KeyRound,
  LockKeyhole,
  Menu,
  Play,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  UsersRound
} from 'lucide-react';
import moduleCatalog from '../generated/public-modules.json';
import { getPublicConfig } from './api';
import { trackEvent } from './analytics';

const REPO_URL = 'https://github.com/leanchain/trevra';
const FOUNDER_FALLBACK = 'founder@usetrevra.com';

type MarketingScreenProps = {
  onGetStarted: () => void;
  hostedAppUrl?: string;
  githubUrl?: string;
};

type PublicModule = {
  id: string;
  name: string;
  version: string;
  description: string;
  sideEffect: string;
  requiresApproval: boolean;
  runtime: string;
  sourceType: string;
  source: string;
  publisher: { slug: string; name: string; verified: boolean };
  trust: { signed: boolean; sbom: boolean; verifiedRelease: boolean };
  popularity: {
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    successRate: number | null;
    uniqueWorkspaces: number;
    activeInstallations: number;
    lastRunAt: string | null;
    rank: number | null;
  };
};

/**
 * The catalog has no visibility field.
 *
 * `scripts/build-public-catalog.ts` copies id, name, version, description,
 * sideEffect and requiresApproval off the skill manifest and hard-codes the
 * rest -- nothing anywhere says "public" or "private". Until the manifest
 * schema grows one, the split below is derived from the id namespace: `gtm.*`
 * is what a person composes, anything else (`net.*` today) is called by other
 * modules. A real field belongs in the manifest; this is a stand-in.
 */
const SHOW_SYSTEM_MODULES = true;

const MODULE_GROUPS = [
  {
    key: 'linkedin',
    label: 'LinkedIn outreach',
    blurb: 'Sequences, pacing, and account limits.',
    system: false,
    match: (id: string) => id.startsWith('gtm.linkedin-')
  },
  {
    key: 'gtm',
    label: 'Go-to-market skills',
    blurb: 'Sourcing, qualification, research, and drafting.',
    system: false,
    match: (id: string) => id.startsWith('gtm.')
  },
  {
    key: 'system',
    label: 'System-facing',
    blurb: 'Modules used by other modules.',
    system: true,
    match: () => true
  }
] as const;

/**
 * Where each module actually lives, so a card is a link to the file that
 * implements it rather than a rectangle that lifts on hover and does nothing.
 * The catalog's own `source` field is the directory, which is the same string
 * for eighteen of the twenty; these come from src/server/skills/registry.ts.
 */
const SOURCE_FILES: Record<string, string> = {
  'gtm.channel-plan': 'src/server/channels/plan.ts',
  'gtm.channel-prepare': 'src/server/channels/prepare.ts',
  'gtm.copy-critique': 'src/server/skills/voice.ts',
  'gtm.draft-reply': 'src/server/outreach/reply.ts',
  'gtm.enrich-company': 'src/server/skills/enrich.ts',
  'gtm.find-contact': 'src/server/skills/contact.ts',
  'gtm.lead-status': 'src/server/skills/ladder.ts',
  'gtm.linkedin-guard': 'src/server/linkedin/guard.ts',
  'gtm.linkedin-pace': 'src/server/linkedin/pacing.ts',
  'gtm.linkedin-sequence': 'src/server/linkedin/sequence.ts',
  'gtm.outreach-draft': 'src/server/skills/draft.ts',
  'gtm.outreach-guard': 'src/server/outreach/safety.ts',
  'gtm.research-brief': 'src/server/skills/brief.ts',
  'gtm.score-lead': 'src/server/skills/score.ts',
  'gtm.score-threads': 'src/server/outreach/scorer.ts',
  'gtm.scout-threads': 'src/server/outreach/scout.ts',
  'gtm.source-leads': 'src/server/research/source.ts',
  'gtm.visibility-audit': 'src/server/skills/audit.ts',
  'gtm.watch-signal': 'src/server/skills/signal.ts',
  'net.validate-host': 'src/server/skills/guard.ts'
};

/**
 * Marketing summaries, authored for a reader who has not met the category.
 *
 * The manifest descriptions are written for an operator composing a run and
 * ship terms a first-time visitor cannot parse -- "SSRF pre-flight" reached
 * the landing page verbatim. They stay in the catalog JSON, which is linked
 * from this section; what renders here is one sentence, in the product's own
 * plain language, and nothing is clamped mid-word. A module that appears from
 * the live registry and is not in this map falls back to its own description.
 */
const SUMMARIES: Record<string, string> = {
  'gtm.linkedin-sequence': 'Drafts and checks multi-step LinkedIn sequences.',
  'gtm.linkedin-pace': 'Schedules LinkedIn actions within warm-up, daily limits, and working hours.',
  'gtm.linkedin-guard': 'Checks LinkedIn actions against account limits and duplicate targets.',
  'gtm.channel-plan': 'Ranks channels for a draft and explains the score.',
  'gtm.channel-prepare': 'Adapts an approved draft to a channel.',
  'gtm.copy-critique': 'Checks copy for weak, generic, or machine-like writing.',
  'gtm.draft-reply': 'Drafts and checks a reply for a public thread.',
  'gtm.enrich-company': 'Reads public company pages for firmographic and technology data.',
  'gtm.find-contact': 'Finds published contact details on a company domain.',
  'gtm.lead-status': 'Checks whether a lead can move to the next stage.',
  'gtm.outreach-draft': 'Drafts an outreach email from a specific finding.',
  'gtm.outreach-guard': 'Checks outreach against limits, cooldowns, and blacklists.',
  'gtm.research-brief': 'Combines research into one sourced brief.',
  'gtm.score-lead': 'Scores lead fit and shows the factors behind it.',
  'gtm.score-threads': 'Ranks public threads by relevance and freshness.',
  'gtm.scout-threads': 'Finds relevant public threads and keeps the source.',
  'gtm.source-leads': 'Builds lead lists from public sources.',
  'gtm.visibility-audit': 'Checks how a domain appears to AI assistants and answer engines.',
  'gtm.watch-signal': 'Finds changes in hiring, pricing, positioning, and stack.',
  'net.validate-host': 'Blocks requests to private, internal, and loopback addresses.'
};

function groupIndexOf(module: PublicModule): number {
  const index = MODULE_GROUPS.findIndex((group) => group.match(module.id));
  return index === -1 ? MODULE_GROUPS.length - 1 : index;
}

/**
 * Group, then name. Every module in the catalog has totalRuns: 0, so the old
 * popularity sort was alphabetical-by-id wearing a leaderboard's clothes.
 */
function byGroupThenName(left: PublicModule, right: PublicModule): number {
  return (groupIndexOf(left) - groupIndexOf(right))
    || left.id.localeCompare(right.id);
}

const STATIC_MODULES = (moduleCatalog.modules as PublicModule[]).slice().sort(byGroupThenName);

/**
 * The example run is a real playbook.
 *
 * `gtm.audit-led-outreach` is defined in src/server/playbooks/registry.ts with
 * exactly these five steps, in this order, and its fourth step really is of
 * type `approval` while the fifth is the `email.send` action that names it as
 * a prerequisite. The run id and the states are an example; the shape is not.
 */
const LEDGER_SAMPLE = [
  { step: 'score', runs: 'gtm.score-lead', mono: true, state: 'recorded', tone: 'done' },
  { step: 'audit', runs: 'gtm.visibility-audit', mono: true, state: 'recorded', tone: 'done' },
  { step: 'draft', runs: 'gtm.outreach-draft', mono: true, state: 'prepared', tone: 'ready' },
  { step: 'approve-outreach', runs: 'a decision, by you', mono: false, state: 'awaiting you', tone: 'gate' },
  { step: 'send-outreach', runs: 'email.send', mono: true, state: 'blocked', tone: 'blocked' }
] as const;

const POLICY_CHECKS = [
  { policy: 'max_recipients: 5', run: '5 recipients', verdict: 'within', stop: false },
  { policy: 'confidence_min: 0.84', run: '0.91', verdict: 'above', stop: false },
  { policy: 'delay_minutes: 30', run: '+30 min', verdict: 'set', stop: false },
  { policy: 'default: require_approval', run: 'you', verdict: 'waiting', stop: true }
] as const;

const POLICY_FILE = `external_writes:
  default: require_approval

outreach.send:
  max_recipients: 5
  confidence_min: 0.84
  delay_minutes: 30

invoice.create:
  approval_required: true
  amount_ceiling: 2500

scope.change:
  delegation: forbidden`;

function ThemeToggle() {
  return (
    <button type="button" className="theme-toggle" data-theme-toggle aria-label="Switch theme">
      <svg className="icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      <svg className="icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    </button>
  );
}

function normalizeRegistryModule(current: Record<string, unknown> | undefined, fallback: PublicModule | null): PublicModule {
  const popularity = typeof current?.popularity === 'object' && current.popularity !== null
    ? current.popularity as Record<string, unknown>
    : {};
  const publisher = typeof current?.publisher === 'object' && current.publisher !== null
    ? current.publisher as Record<string, unknown>
    : {};
  const trust = typeof current?.trust === 'object' && current.trust !== null
    ? current.trust as Record<string, unknown>
    : {};
  return {
    id: String(current?.id ?? fallback?.id ?? ''),
    name: String(current?.name ?? fallback?.name ?? ''),
    version: String(current?.version ?? fallback?.version ?? '0.0.0'),
    description: String(current?.description ?? fallback?.description ?? ''),
    sideEffect: String(current?.sideEffect ?? fallback?.sideEffect ?? 'none'),
    requiresApproval: Boolean(current?.requiresApproval ?? fallback?.requiresApproval ?? false),
    runtime: String(current?.runtime ?? fallback?.runtime ?? 'remote'),
    sourceType: String(current?.sourceType ?? fallback?.sourceType ?? 'community'),
    source: fallback?.source ?? 'hosted registry',
    publisher: {
      slug: String(publisher.slug ?? fallback?.publisher.slug ?? 'community'),
      name: String(publisher.name ?? fallback?.publisher.name ?? publisher.slug ?? 'Community publisher'),
      verified: Boolean(publisher.verified ?? fallback?.publisher.verified ?? false)
    },
    trust: {
      signed: Boolean(trust.signed ?? fallback?.trust.signed ?? false),
      sbom: Boolean(trust.sbom ?? fallback?.trust.sbom ?? false),
      verifiedRelease: Boolean(trust.verifiedRelease ?? fallback?.trust.verifiedRelease ?? false)
    },
    popularity: {
      totalRuns: Number(popularity.totalRuns ?? fallback?.popularity.totalRuns ?? 0),
      successfulRuns: Number(popularity.successfulRuns ?? fallback?.popularity.successfulRuns ?? 0),
      failedRuns: Number(popularity.failedRuns ?? fallback?.popularity.failedRuns ?? 0),
      successRate: typeof popularity.successRate === 'number' ? popularity.successRate : fallback?.popularity.successRate ?? null,
      uniqueWorkspaces: Number(popularity.uniqueWorkspaces ?? fallback?.popularity.uniqueWorkspaces ?? 0),
      activeInstallations: Number(popularity.activeInstallations ?? fallback?.popularity.activeInstallations ?? 0),
      lastRunAt: typeof popularity.lastRunAt === 'string' ? popularity.lastRunAt : fallback?.popularity.lastRunAt ?? null,
      rank: typeof popularity.rank === 'number' ? popularity.rank : fallback?.popularity.rank ?? null
    }
  };
}

function ModuleRow({ module }: { module: PublicModule }) {
  const file = SOURCE_FILES[module.id];
  const href = file ? `${REPO_URL}/blob/main/${file}` : '/catalog/modules.json';
  return (
    <li>
      <a className="module-row" href={href}>
        <span className="row-id"><code>{module.id}</code><span className="row-v">v{module.version}</span></span>
        <span className="row-name">{module.name}</span>
        <span className="row-sum">{SUMMARIES[module.id] ?? module.description}</span>
        <span className="row-chips">
          <span className="chip">{module.sideEffect === 'none' ? 'no external calls' : 'reads public pages'}</span>
          <span className={module.requiresApproval ? 'chip chip-approval' : 'chip'}>
            {module.requiresApproval ? 'needs your approval' : 'runs unattended'}
          </span>
        </span>
      </a>
    </li>
  );
}

export function MarketingScreen({ onGetStarted, hostedAppUrl = '', githubUrl = '' }: MarketingScreenProps) {
  const [supportEmail, setSupportEmail] = useState(import.meta.env.VITE_SUPPORT_EMAIL?.trim() ?? '');
  const [registryApiUrl, setRegistryApiUrl] = useState(import.meta.env.VITE_CATALOG_API_URL?.trim() ?? '');
  const [liveModules, setLiveModules] = useState<PublicModule[]>(STATIC_MODULES);
  const [moduleQuery, setModuleQuery] = useState('');
  const primaryHref = hostedAppUrl || '#hosted';
  const sourceHref = githubUrl || REPO_URL;

  useEffect(() => {
    if (supportEmail && registryApiUrl) return;
    void getPublicConfig().then((config) => {
      if (!supportEmail) setSupportEmail(config.supportEmail);
      if (!registryApiUrl && config.catalogApiUrl) setRegistryApiUrl(config.catalogApiUrl);
    }).catch(() => undefined);
  }, [supportEmail, registryApiUrl]);

  useEffect(() => {
    if (!registryApiUrl) return;
    const endpoint = `${registryApiUrl.replace(/\/$/, '')}/api/public/modules`;
    void fetch(endpoint, { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Registry returned ${response.status}`);
        return response.json() as Promise<{ modules?: Array<Record<string, unknown>> }>;
      })
      .then((payload) => {
        if (!Array.isArray(payload.modules)) return;
        const live = new Map(payload.modules.map((module) => [String(module.id), module]));
        const merged = STATIC_MODULES.map((module) => normalizeRegistryModule(live.get(module.id), module));
        const known = new Set(merged.map((module) => module.id));
        for (const current of payload.modules) {
          const id = String(current.id ?? '');
          if (!id || known.has(id)) continue;
          merged.push(normalizeRegistryModule(current, null));
        }
        setLiveModules(merged.sort(byGroupThenName));
      })
      .catch(() => undefined);
  }, [registryApiUrl]);

  const handlePrimary = (event: React.MouseEvent<HTMLAnchorElement>) => {
    trackEvent('marketing_primary_cta', { destination: hostedAppUrl ? 'hosted_app' : 'workspace_auth' });
    if (hostedAppUrl) return;
    event.preventDefault();
    onGetStarted();
  };

  const founderHref = `mailto:${supportEmail || FOUNDER_FALLBACK}`;
  const hostedHref = `${founderHref}?subject=${encodeURIComponent('Hosted workspace')}`;

  const query = moduleQuery.trim().toLowerCase();
  const installable = liveModules.filter((module) => SHOW_SYSTEM_MODULES || !MODULE_GROUPS[groupIndexOf(module)].system);
  const catalogModules = installable.filter((module) => {
    if (!query) return true;
    return `${module.id} ${module.name} ${SUMMARIES[module.id] ?? module.description}`.toLowerCase().includes(query);
  });
  const moduleGroups = MODULE_GROUPS.map((group) => ({
    group,
    modules: catalogModules.filter((module) => MODULE_GROUPS[groupIndexOf(module)].key === group.key)
  })).filter((entry) => entry.modules.length > 0);

  return (
    <main className="static-launch" id="main" tabIndex={-1}>
      <header className="launch-nav">
        <a className="launch-logo" href="/" aria-label="Trevra home"><span><BrandMark /></span><strong>Trevra</strong></a>
        <nav aria-label="Primary navigation">
          <a href="#how-it-works">How it runs</a>
          <a href="#approval">The gate</a>
          <a href="#modules">Catalog</a>
          <a href="#deploy">Deploy</a>
        </nav>
        <div className="launch-nav-actions">
          {/* The nav above is hidden below 1050px. This is its replacement, not a
              duplicate: it also carries Source, which drops out at 760px. */}
          <details className="launch-nav-menu">
            <summary aria-label="Open section navigation"><Menu size={18} aria-hidden="true" /></summary>
            <nav aria-label="Sections">
              <a href="#how-it-works">How it runs</a>
              <a href="#approval">The gate</a>
              <a href="#modules">Catalog</a>
              <a href="#deploy">Deploy</a>
              <a href={sourceHref} target="_blank" rel="noreferrer">Source on GitHub</a>
            </nav>
          </details>
          <ThemeToggle />
          <a className="nav-source" href={sourceHref} target="_blank" rel="noreferrer" onClick={() => trackEvent('marketing_source_cta')}><Github size={16} /> Source</a>
          {/* The nav button says Login and its fallback is the ADDRESS of the
              login screen, not `#hosted` -- mirroring index.html's pre-JS copy
              of this bar exactly, so the button does not change meaning at the
              moment React replaces the static markup. `handlePrimary` still
              decides: a configured hosted workspace wins, and on the
              marketing-only build it scrolls to the deploy card. */}
          <a className="launch-nav-cta" data-hosted-cta href={hostedAppUrl || '/login'} onClick={handlePrimary}>Login <ArrowRight size={16} /></a>
        </div>
      </header>

      <section className="launch-hero" id="top">
        <div className="hero-copy">
          <h1>Run GTM with Claude Code or Codex.</h1>
          <p className="hero-lede">Trevra gives agents tools for research, scoring, outreach, and revenue work. External actions wait for your approval. Every run is logged. The runtime is open source.</p>
          <div className="launch-actions">
            <a className="launch-button" data-hosted-cta href={primaryHref} onClick={handlePrimary}><Play size={17} fill="currentColor" /> Open Trevra</a>
            <a className="launch-secondary" href="#approval"><ShieldCheck size={17} /> See approvals</a>
          </div>
          <p className="hero-facts">
            <a href={sourceHref} target="_blank" rel="noreferrer" onClick={() => trackEvent('marketing_source_cta')}>Read the source</a>
            <span aria-hidden="true">·</span>
            <a href="/catalog/modules.json" onClick={() => trackEvent('marketing_catalog_json')}>{installable.length} modules in the catalog</a>
            <span aria-hidden="true">·</span>
            <a href="/catalog/trevra.sbom.cdx.json">Software bill of materials</a>
          </p>
        </div>

        {/* The hero artifact is the policy file, not a terminal mock: it is the
            one object on this page a competitor cannot ship by Friday. */}
        <figure className="hero-policy">
          <div className="policy-card">
            <div className="policy-head"><ShieldCheck size={20} /><span>workspace.policy.yaml</span><em>enforced</em></div>
            <pre><code>{POLICY_FILE}</code></pre>
            <div className="policy-foot"><Check size={16} /> Checked before external actions</div>
          </div>
          <figcaption>This file controls what agents can do without approval.</figcaption>
        </figure>
      </section>

      <section className="launch-section run-section" id="how-it-works">
        <div className="split-heading">
          <h2>Agents do the work. You approve external actions.</h2>
          <p>Research, scoring, sequencing, and drafting can run automatically. Trevra records each run, its inputs, evidence, and result.</p>
        </div>
        <figure className="ledger">
          <figcaption className="ledger-cap">
            <span><strong>gtm.audit-led-outreach</strong> · workspace <code>founder-led-growth</code></span>
            <span className="ledger-cap-note">Example run, not a live feed</span>
          </figcaption>
          <table className="ledger-table">
            <caption>Five steps of the audit-led outreach playbook, in the order it defines them.</caption>
            <thead><tr><th scope="col">step</th><th scope="col">runs</th><th scope="col">state</th></tr></thead>
            <tbody>
              {LEDGER_SAMPLE.map((entry) => (
                <tr key={entry.step} className={entry.tone === 'gate' ? 'row-gate' : entry.tone === 'blocked' ? 'row-blocked' : undefined}>
                  <th scope="row">{entry.step}</th>
                  <td>{entry.mono ? <code>{entry.runs}</code> : entry.runs}</td>
                  <td className={`state-${entry.tone}`}>{entry.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ledger-note">The playbook and modules are real. Run IDs and timings are examples.</p>
        </figure>
      </section>

      {/* The gate. A native disclosure: in the DOM for a crawler, announced as a
          disclosure to a screen reader, operable from the keyboard, and it works
          with the script tag removed. */}
      <section className="gate" id="approval" aria-labelledby="gate-title">
        <div className="gate-inner">
          <div className="gate-head" id="security">
            <h2 id="gate-title">External actions require approval.</h2>
            <p>Trevra checks <code>workspace.policy.yaml</code> before acting. This run is prepared and waiting for approval.</p>
          </div>

          <div className="gate-body">
            <figure className="gate-run">
              <figcaption><span><code>run_8f2e</code> · approve-outreach</span><em>prepared</em></figcaption>
              <p className="gate-what">5 personalized emails · one recipient each · scheduled +30 min after approval</p>
              <table className="gate-checks">
                <caption>What the policy file said about this run.</caption>
                <thead><tr><th scope="col">policy</th><th scope="col">this run</th><th scope="col">result</th></tr></thead>
                <tbody>
                  {POLICY_CHECKS.map((check) => (
                    <tr key={check.policy} className={check.stop ? 'check-row-stop' : undefined}>
                      <th scope="row"><code>{check.policy}</code></th>
                      <td>{check.run}</td>
                      <td className={check.stop ? 'check-stop' : 'check-pass'}>{check.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="gate-hash"><code>sha256:4f21b8…c7e0</code> <span>pins this exact payload. Edited work cannot reuse the approval.</span></p>
            </figure>

            <div className="gate-decide">
              <p className="gate-line"><span>Nothing past this line has been sent</span></p>
              <p className="gate-brief">The draft is stored in the ledger and has not been sent.</p>
              <details className="gate-decision">
                <summary className="gate-summary">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span className="when-closed">Approve this run</span>
                  <span className="when-open">Approved — released to you</span>
                </summary>
                <div className="gate-release">
                  <p className="release-label">Released: 1 of 5 drafts, as <code>gtm.outreach-draft</code> wrote it.</p>
                  <div className="release-mail">
                    <p className="release-meta">Subject: the tier table your docs are still serving</p>
                    <p>You moved Standard to usage-based pricing on the 28th. The old tier table is still in your docs sitemap, so that is the version the answer engines are quoting back.</p>
                    <p>Worth fifteen minutes? I will bring what four assistants currently say your pricing is.</p>
                  </div>
                  <p className="release-ledger"><code>run_8f2e</code> approved · <code>send-outreach</code> released · hash verified · written to the ledger</p>
                  <p className="release-note">In a workspace, approval releases the send. This demo only reveals the draft.</p>
                </div>
              </details>
            </div>
          </div>

          <div className="gate-points">
            <div><ScrollText /><span><strong>Full run ledger</strong><small>Inputs, outputs, evidence, failures, and results.</small></span></div>
            <div><KeyRound /><span><strong>Exact-payload approval</strong><small>Changes after approval are rejected.</small></span></div>
            <div><LockKeyhole /><span><strong>Set hard limits</strong><small>Control action types, confidence, amounts, volume, and timing.</small></span></div>
          </div>
        </div>
      </section>

      <section className="launch-section catalog-section" id="modules">
        <div className="split-heading">
          <h2>{installable.length} modules with clear permissions.</h2>
          <p>Each module states what it reads, what it writes, and whether it needs approval.</p>
        </div>
        <div className="catalog-bar">
          <p className="catalog-links">
            <a href="/catalog/modules.json" onClick={() => trackEvent('marketing_catalog_json')}>Open the catalog as JSON</a>
            <span aria-hidden="true">·</span>
            <a href="/catalog/trevra.sbom.cdx.json">Software bill of materials</a>
            <span aria-hidden="true">·</span>
            <a href="/llms.txt">Context file for language models</a>
          </p>
          <label className="catalog-filter">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={moduleQuery}
              onChange={(event) => setModuleQuery(event.target.value)}
              placeholder="Filter modules"
              aria-label="Filter modules by name, id, or summary"
            />
          </label>
        </div>
        {moduleGroups.length === 0
          ? <p className="catalog-empty">No modules match “{moduleQuery.trim()}”. <a href="/catalog/modules.json">Open the full catalog</a>.</p>
          : moduleGroups.map(({ group, modules }) => (
            <section className="module-group" key={group.key} aria-labelledby={`module-group-${group.key}`}>
              <h3 id={`module-group-${group.key}`}>{group.label}</h3>
              <p>{group.blurb}</p>
              <ul className="module-list">
                {modules.map((module) => <ModuleRow module={module} key={module.id} />)}
              </ul>
            </section>
          ))}
      </section>

      <section className="launch-section deploy-section" id="deploy">
        <div className="split-heading">
          <h2>Hosted or self-hosted.</h2>
          <p>Same product. Different infrastructure.</p>
        </div>
        <div className="deploy-grid">
          {/* This card is where every degraded #hosted CTA lands, so its own action
              is a real one rather than a fourth copy of the button that sent the
              reader here. */}
          <article className="deploy-card featured" id="hosted">
            <div className="deploy-icon"><Cloud /></div>
            <span className="deploy-label">Trevra hosted</span>
            <h3>Managed Trevra.</h3>
            <p>We run PostgreSQL, authentication, integrations, backups, the ledger, and the approval queue.</p>
            <ul>
              <li><Check /> Managed PostgreSQL, secrets and updates</li>
              <li><Check /> Catalog releases synced from GitHub</li>
              <li><Check /> Bring Claude Code or Codex as the operator</li>
            </ul>
            <p className="deploy-price">Hosted access is opening in batches.</p>
            <a className="launch-button" href={hostedHref} onClick={() => trackEvent('marketing_founder_cta')}><UsersRound size={17} /> Ask the founder for a workspace</a>
          </article>
          <article className="deploy-card">
            <div className="deploy-icon"><Server /></div>
            <span className="deploy-label">Self-hosted</span>
            <h3>Run Trevra yourself.</h3>
            <p>Use your own PostgreSQL and providers. Keep the ledger in your environment.</p>
            <pre className="deploy-code"><code>{`git clone https://github.com/leanchain/trevra
cd trevra
cp .env.example .env.dev
docker compose --env-file .env.dev \\
  -f compose.dev.yml up --build`}</code></pre>
            <p className="deploy-code-note">Runs on <code>localhost:43173</code> with PostgreSQL.</p>
            <a className="launch-secondary" href={`${sourceHref}#readme`} target="_blank" rel="noreferrer" onClick={() => trackEvent('marketing_self_host_cta')}><Github size={17} /> Read the deployment guide</a>
          </article>
        </div>
      </section>

      <section className="launch-final">
        <div>
          <h2>Run the work. Approve the actions.</h2>
          <p>Connect a workspace, choose modules, and let your agent prepare the next action.</p>
        </div>
        <div className="launch-actions">
          <a className="launch-button light" data-hosted-cta href={primaryHref} onClick={handlePrimary}>Open Trevra <ArrowRight size={17} /></a>
          <a className="launch-secondary light" href={sourceHref} target="_blank" rel="noreferrer" onClick={() => trackEvent('marketing_source_cta')}><Github size={17} /> View source</a>
        </div>
      </section>

      <footer className="launch-footer">
        <div className="footer-brand"><a className="launch-logo" href="/"><span><BrandMark /></span><strong>Trevra</strong></a><p>Open-source GTM infrastructure for AI agents.</p></div>
        <div><strong>Product</strong><a href="#how-it-works">How it runs</a><a href="#approval">The approval gate</a><a href="#modules">Module catalog</a><a href="#deploy">Deploy</a></div>
        <div><strong>Source</strong><a href={sourceHref} target="_blank" rel="noreferrer">GitHub repository</a><a href="/catalog/modules.json">Catalog JSON</a><a href="/catalog/trevra.sbom.cdx.json">SBOM (CycloneDX)</a><a href="/llms.txt">Context for language models</a></div>
        <div><strong>Company</strong><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href={founderHref} onClick={() => trackEvent('marketing_founder_cta')}>Talk to the founder</a></div>
        <p className="footer-note">© {new Date().getFullYear()} Trevra. Built in the open.</p>
      </footer>
    </main>
  );
}
