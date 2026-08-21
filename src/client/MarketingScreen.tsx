import { useEffect, useState } from 'react';
import { BrandMark } from './ui/BrandMark';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Cloud,
  Eye,
  FileCheck2,
  Github,
  LockKeyhole,
  Menu,
  Puzzle,
  Server,
  ShieldCheck,
  Telescope,
  UsersRound,
  Zap
} from 'lucide-react';
import moduleCatalog from '../generated/public-modules.json';
import { getPublicConfig } from './api';
import { trackEvent } from './analytics';
import { FAQ_ITEMS } from '../shared/site-metadata';

const REPO_URL = 'https://github.com/leanchain/trevra';
const FOUNDER_FALLBACK = 'founder@usetrevra.com';

/** The page's own anchors, in one place: the nav, the burger menu, and the footer all read this. */
const NAV_LINKS = [
  { href: '#approval', label: 'The gate' },
  { href: '#deploy', label: 'Deploy' }
] as const;

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
  'gtm.linkedin-pace':
    'Schedules LinkedIn actions within warm-up, daily limits, and working hours.',
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

const byName = (left: PublicModule, right: PublicModule) => left.id.localeCompare(right.id);

const STATIC_MODULES = (moduleCatalog.modules as PublicModule[]).slice().sort(byName);

const POLICY_CHECKS = [
  { policy: 'max_recipients: 5', run: '1 recipient', verdict: 'within', stop: false },
  { policy: 'confidence_min: 0.84', run: '0.91', verdict: 'above', stop: false },
  { policy: 'delay_minutes: 30', run: '+30 min', verdict: 'set', stop: false },
  { policy: 'default: require_approval', run: 'you', verdict: 'waiting', stop: true }
] as const;

function ThemeToggle() {
  return (
    <button type="button" className="theme-toggle" data-theme-toggle aria-label="Switch theme">
      <svg
        className="icon-light"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      <svg
        className="icon-dark"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    </button>
  );
}

function normalizeRegistryModule(
  current: Record<string, unknown> | undefined,
  fallback: PublicModule | null
): PublicModule {
  const popularity =
    typeof current?.popularity === 'object' && current.popularity !== null
      ? (current.popularity as Record<string, unknown>)
      : {};
  const publisher =
    typeof current?.publisher === 'object' && current.publisher !== null
      ? (current.publisher as Record<string, unknown>)
      : {};
  const trust =
    typeof current?.trust === 'object' && current.trust !== null
      ? (current.trust as Record<string, unknown>)
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
      name: String(
        publisher.name ?? fallback?.publisher.name ?? publisher.slug ?? 'Community publisher'
      ),
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
      successRate:
        typeof popularity.successRate === 'number'
          ? popularity.successRate
          : (fallback?.popularity.successRate ?? null),
      uniqueWorkspaces: Number(
        popularity.uniqueWorkspaces ?? fallback?.popularity.uniqueWorkspaces ?? 0
      ),
      activeInstallations: Number(
        popularity.activeInstallations ?? fallback?.popularity.activeInstallations ?? 0
      ),
      lastRunAt:
        typeof popularity.lastRunAt === 'string'
          ? popularity.lastRunAt
          : (fallback?.popularity.lastRunAt ?? null),
      rank:
        typeof popularity.rank === 'number' ? popularity.rank : (fallback?.popularity.rank ?? null)
    }
  };
}

function ModuleRow({ module }: { module: PublicModule }) {
  const file = SOURCE_FILES[module.id];
  const href = file ? `${REPO_URL}/blob/main/${file}` : '/catalog/modules.json';
  return (
    <li>
      <a className="module-row" href={href}>
        <span className="row-id">
          <code>{module.id}</code>
          <span className="row-v">v{module.version}</span>
        </span>
        <span className="row-name">{module.name}</span>
        <span className="row-sum">{SUMMARIES[module.id] ?? module.description}</span>
        <span className="row-chips">
          <span className="chip">
            {module.sideEffect === 'none' ? 'no external calls' : 'reads public pages'}
          </span>
          <span className={module.requiresApproval ? 'chip chip-approval' : 'chip'}>
            {module.requiresApproval ? 'needs your approval' : 'runs unattended'}
          </span>
        </span>
      </a>
    </li>
  );
}

export function MarketingScreen({
  onGetStarted,
  hostedAppUrl = '',
  githubUrl = ''
}: MarketingScreenProps) {
  // `?.` on `import.meta.env` itself: see MarketingApp.tsx, which the build-time
  // prerender script also imports outside of Vite.
  const [supportEmail, setSupportEmail] = useState(
    import.meta.env?.VITE_SUPPORT_EMAIL?.trim() ?? ''
  );
  const [registryApiUrl, setRegistryApiUrl] = useState(
    import.meta.env?.VITE_CATALOG_API_URL?.trim() ?? ''
  );
  const [liveModules, setLiveModules] = useState<PublicModule[]>(STATIC_MODULES);
  const primaryHref = hostedAppUrl || '#hosted';
  const primaryLabel = hostedAppUrl ? 'Open workspace' : 'Request hosted access';
  const navLabel = hostedAppUrl ? 'Workspace' : 'Request access';
  const sourceHref = githubUrl || REPO_URL;

  useEffect(() => {
    if (supportEmail && registryApiUrl) return;
    void getPublicConfig()
      .then((config) => {
        if (!supportEmail) setSupportEmail(config.supportEmail);
        if (!registryApiUrl && config.catalogApiUrl) setRegistryApiUrl(config.catalogApiUrl);
      })
      .catch(() => undefined);
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
        const merged = STATIC_MODULES.map((module) =>
          normalizeRegistryModule(live.get(module.id), module)
        );
        const known = new Set(merged.map((module) => module.id));
        for (const current of payload.modules) {
          const id = String(current.id ?? '');
          if (!id || known.has(id)) continue;
          merged.push(normalizeRegistryModule(current, null));
        }
        setLiveModules(merged.sort(byName));
      })
      .catch(() => undefined);
  }, [registryApiUrl]);

  const handlePrimary = (event: React.MouseEvent<HTMLAnchorElement>) => {
    trackEvent('marketing_primary_cta', {
      destination: hostedAppUrl ? 'hosted_app' : 'hosted_access'
    });
    if (hostedAppUrl) return;
    event.preventDefault();
    onGetStarted();
  };

  const founderHref = `mailto:${supportEmail || FOUNDER_FALLBACK}`;
  const hostedHref = `${founderHref}?subject=${encodeURIComponent('Hosted workspace')}`;
  const conversionHref = hostedAppUrl || hostedHref;

  return (
    <main className="static-launch" id="main" tabIndex={-1}>
      <header className="launch-nav">
        <a className="launch-logo" href="/" aria-label="Trevra home">
          <span>
            <BrandMark />
          </span>
          <strong>Trevra</strong>
        </a>
        <nav aria-label="Primary navigation">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="launch-nav-actions">
          {/* The nav above is hidden below 1050px. This is its replacement, not a
              duplicate: it also carries Source, which drops out at 760px. */}
          <details className="launch-nav-menu">
            <summary aria-label="Open section navigation">
              <Menu size={18} aria-hidden="true" />
            </summary>
            <nav aria-label="Sections">
              {NAV_LINKS.map((link) => (
                <a key={link.href} href={link.href}>
                  {link.label}
                </a>
              ))}
              <a href={sourceHref} target="_blank" rel="noreferrer">
                Source on GitHub
              </a>
            </nav>
          </details>
          <ThemeToggle />
          <a
            className="nav-source"
            href={sourceHref}
            target="_blank"
            rel="noreferrer"
            onClick={() => trackEvent('marketing_source_cta')}
          >
            <Github size={16} /> Source
          </a>
          <a className="launch-nav-cta" data-hosted-cta href={primaryHref} onClick={handlePrimary}>
            {navLabel} <ArrowRight size={16} />
          </a>
        </div>
      </header>

      <section className="launch-hero" id="top">
        <div className="hero-copy">
          <h1>The Agentic GTM Engine for Claude Code and Codex.</h1>
          <p className="hero-lede">
            Trevra combines public signals into sourced findings, scores leads, and drafts
            multichannel outreach—operating as your standalone GTM workspace or an overlay on your
            existing CRM, behind exact human approval.
          </p>
          <div className="launch-actions">
            <a className="launch-button" data-hosted-cta href={primaryHref} onClick={handlePrimary}>
              {primaryLabel} <ArrowRight size={17} />
            </a>
            <a className="launch-secondary" href="#approval">
              <ShieldCheck size={17} /> See the approval boundary
            </a>
          </div>
          <p className="hero-facts" aria-label="Product facts">
            <span>Open source</span>
            <span aria-hidden="true">·</span>
            <span>Standalone or CRM Overlay</span>
            <span aria-hidden="true">·</span>
            <span>Operated via MCP</span>
            <span aria-hidden="true">·</span>
            <span>{liveModules.length} public GTM modules</span>
          </p>
        </div>
      </section>

      {/* WHY: The problem this solves */}
      <section className="launch-section" id="why" aria-labelledby="why-title">
        <div className="split-heading">
          <h2 id="why-title">Your GTM agent is already running. Who controls it?</h2>
          <p>
            Agents are commoditised. The gap is governance: what signals justify action, what the
            exact payload is, who approved it, and whether the result was logged. Without that, your
            agent is a liability, not an asset.
          </p>
        </div>
        <div className="gate-points">
          <div>
            <Telescope aria-hidden="true" />
            <span>
              <strong>No audit trail, no accountability</strong>
              <small>
                When your agent fires outreach, can you replay exactly which signals triggered it,
                what was sent, and who reviewed it? Trevra logs every run with its full evidence
                chain and policy verdict—immutably, in order.
              </small>
            </span>
          </div>
          <div>
            <Zap aria-hidden="true" />
            <span>
              <strong>Unreviewed sends compound fast</strong>
              <small>
                One wrong send is a mistake. A sequence of unreviewed agent actions at scale is a
                brand problem. Trevra holds every external action at an exact-payload gate before
                anything leaves your workspace.
              </small>
            </span>
          </div>
          <div>
            <Puzzle aria-hidden="true" />
            <span>
              <strong>Your CRM records state. It doesn't govern execution.</strong>
              <small>
                HubSpot, Salesforce, and Attio know what happened after the fact. Trevra is the
                control plane that decides what the agent is allowed to do, enforces it, and proves
                it.
              </small>
            </span>
          </div>
        </div>
      </section>

      {/* HOW: The approval gate mechanism */}
      <section className="gate" id="approval" aria-labelledby="gate-title">
        <div className="gate-inner">
          <div className="gate-head" id="security">
            <h2 id="gate-title">How it works: agent runs, you approve.</h2>
            <p>
              Point Claude Code at Trevra over MCP. The agent researches, scores leads, and drafts
              outreach. Every external action stops at the workspace policy gate—nothing is sent
              until you review the exact payload and sign off.
            </p>
          </div>

          <div className="gate-body">
            <figure className="gate-run">
              <figcaption>
                <span>Step 1 — Agent finds intent signal</span>
                <em>research</em>
              </figcaption>
              <p className="gate-what">
                Composite: 3 AI roles posted · LLM SDK added to stack · CTO discussion on agent
                safety
              </p>
              <figcaption style={{ marginTop: '1rem' }}>
                <span>Step 2 — Draft prepared, policy checked</span>
                <em>prepared · not sent</em>
              </figcaption>
              <p className="gate-what">
                1 personalized email · 1 recipient · scheduled +30 min after approval
              </p>
              <table className="gate-checks">
                <caption>Policy verdict before anything can leave your workspace.</caption>
                <thead>
                  <tr>
                    <th scope="col">rule</th>
                    <th scope="col">this run</th>
                    <th scope="col">result</th>
                  </tr>
                </thead>
                <tbody>
                  {POLICY_CHECKS.map((check) => (
                    <tr key={check.policy} className={check.stop ? 'check-row-stop' : undefined}>
                      <th scope="row">
                        <code>{check.policy}</code>
                      </th>
                      <td>{check.run}</td>
                      <td className={check.stop ? 'check-stop' : 'check-pass'}>{check.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="gate-hash">
                <code>sha256:4f21b8…c7e0</code>{' '}
                <span>
                  Step 3 — Payload locked. You approve this exact draft. Edits after approval are
                  rejected.
                </span>
              </p>
            </figure>

            <div className="gate-decide">
              <p className="gate-line">
                <span>Prepared, not sent</span>
              </p>
              <p className="gate-brief">
                The agent prepares the work. You keep the decision. Nothing in this example can
                approve or send it.
              </p>
              <p className="gate-demo-note" id="gate-demo-note">
                Interactive example. Revealing the exact payload cannot trigger an external action.
              </p>
              <details className="gate-decision" aria-describedby="gate-demo-note">
                <summary className="gate-summary">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span className="when-closed">See the exact payload</span>
                  <span className="when-open">Hide the exact payload</span>
                </summary>
                <div className="gate-release">
                  <div className="release-mail">
                    <p className="release-meta">
                      Subject: agentic execution safety and GTM governance
                    </p>
                    <p>
                      I saw you're hiring 3 AI Engineers and added LLM orchestration SDKs to your
                      stack this week. Your CTO's discussion on agent safety caught my attention—are
                      you putting a hard approval boundary around agentic GTM actions?
                    </p>
                    <p>
                      Worth fifteen minutes? I can show you the exact-payload approval model we use
                      so you can evaluate the boundary directly.
                    </p>
                  </div>
                  <p className="release-ledger">
                    <code>run_8f2e</code> payload preview revealed · hash unchanged · no action
                    executed
                  </p>
                  <p className="release-note">
                    In a workspace, your approval releases this exact action. Here, this control
                    only opens and closes the prepared draft.
                  </p>
                </div>
              </details>
            </div>
          </div>

          {/* WHAT: Product capability summary */}
          <div className="gate-points">
            <div>
              <Telescope aria-hidden="true" />
              <span>
                <strong>Research & Signal Detection</strong>
                <small>
                  Watch target account lists for composite intent signals—hiring, tech stack
                  changes, and site diffs—sourced and timestamped, never a black-box score.
                </small>
              </span>
            </div>
            <div>
              <Eye aria-hidden="true" />
              <span>
                <strong>Outreach & LinkedIn Execution</strong>
                <small>
                  Draft email and LinkedIn sequences from real findings. Enforce daily limits,
                  warm-up ramps, cooldowns, and seat pacing via a local browser worker.
                </small>
              </span>
            </div>
            <div>
              <FileCheck2 aria-hidden="true" />
              <span>
                <strong>Evidence Ledger & Approval Gate</strong>
                <small>
                  Every run is logged with its inputs, evidence, and result. External actions are
                  sha256-locked—modified drafts cannot reuse an old approval.
                </small>
              </span>
            </div>
            <div>
              <LockKeyhole aria-hidden="true" />
              <span>
                <strong>Workspace Policy Controls</strong>
                <small>
                  Set hard limits on recipient volume, confidence thresholds, send pacing, and
                  action types per workspace. Claude Code operates only within what you permit.
                </small>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="launch-section deploy-section" id="deploy">
        <div className="split-heading">
          <h2>Start hosted. Keep the option to self-host.</h2>
          <p>One product and one approval boundary. Choose who runs the infrastructure.</p>
        </div>

        <article className="hosted-path" id="hosted">
          <div className="hosted-copy">
            <div className="deploy-title-row">
              <h3>
                {hostedAppUrl ? 'Open your managed workspace.' : 'Request a managed workspace.'}
              </h3>
              <span className="deploy-status">Recommended start</span>
            </div>
            <p>
              Trevra runs PostgreSQL, authentication, integrations, backups, the ledger, and the
              approval queue. You bring Claude Code or Codex.
            </p>
            <ul className="hosted-benefits">
              <li>
                <Check aria-hidden="true" /> Managed database, secrets, and updates
              </li>
              <li>
                <Check aria-hidden="true" /> Evidence and prepared actions stay in one ledger
              </li>
              <li>
                <Check aria-hidden="true" /> External actions keep the exact approval boundary
              </li>
            </ul>
          </div>
          <div className="hosted-action">
            <p className="deploy-price">
              {hostedAppUrl
                ? 'Your hosted workspace is ready.'
                : 'Hosted access is opening in batches.'}
            </p>
            <a
              className="launch-button"
              data-hosted-cta
              href={conversionHref}
              onClick={() =>
                trackEvent(hostedAppUrl ? 'marketing_hosted_cta' : 'marketing_founder_cta')
              }
            >
              {hostedAppUrl ? (
                <Cloud size={17} aria-hidden="true" />
              ) : (
                <UsersRound size={17} aria-hidden="true" />
              )}
              {primaryLabel}
            </a>
            <p className="hosted-action-note">
              {hostedAppUrl
                ? 'Opens your hosted Trevra workspace.'
                : 'Opens an email to the founder with the request subject filled in.'}
            </p>
          </div>
        </article>

        <p className="hosted-trust">
          Hosted and self-hosted deployments enforce the same exact-payload approval boundary. Read
          the <a href="/privacy">privacy policy</a> and <a href="/security">security overview</a>.
        </p>

        <details className="self-host-disclosure">
          <summary>
            <span>
              <Server size={19} aria-hidden="true" /> Run Trevra in your own infrastructure
            </span>
            <small>PostgreSQL · your providers · full source</small>
            <ChevronDown className="disclosure-chevron" size={18} aria-hidden="true" />
          </summary>
          <div className="self-host-body">
            <div className="self-host-copy">
              <p>
                Use your own PostgreSQL and providers. Keep the ledger in your environment and
                retain the same approval model.
              </p>
              <a
                className="launch-secondary"
                href={`${sourceHref}#readme`}
                target="_blank"
                rel="noreferrer"
                onClick={() => trackEvent('marketing_self_host_cta')}
              >
                <Github size={17} /> Read the deployment guide
              </a>
            </div>
            <div>
              <pre className="deploy-code">
                <code>{`git clone https://github.com/leanchain/trevra
cd trevra
cp .env.example .env.dev
docker compose --env-file .env.dev \\
  -f compose.dev.yml up --build`}</code>
              </pre>
              <p className="deploy-code-note">
                Runs on <code>localhost:43173</code> with PostgreSQL.
              </p>
            </div>
          </div>
        </details>

        <details className="deploy-modules">
          <summary>
            <span>See all {liveModules.length} public modules</span>
            <ChevronDown className="disclosure-chevron" size={18} aria-hidden="true" />
          </summary>
          <ul className="module-list">
            {liveModules.map((module) => (
              <ModuleRow module={module} key={module.id} />
            ))}
          </ul>
        </details>

        <details className="deploy-faq">
          <summary>
            <span>Answers about access, data, and deployment</span>
            <ChevronDown className="disclosure-chevron" size={18} aria-hidden="true" />
          </summary>
          <div className="deploy-faq-list">
            {FAQ_ITEMS.map(({ question, answer }) => (
              <div className="deploy-faq-item" key={question}>
                <h4>{question}</h4>
                <p>{answer}</p>
              </div>
            ))}
          </div>
        </details>

        <div className="deploy-close">
          <h3>Your agent prepares the work. You keep the decision.</h3>
          <p>
            Start with a managed workspace, or inspect the source and run the same approval model
            yourself.
          </p>
          <a
            className="launch-button"
            data-hosted-cta
            href={conversionHref}
            onClick={() =>
              trackEvent(hostedAppUrl ? 'marketing_hosted_cta' : 'marketing_founder_cta')
            }
          >
            {primaryLabel} <ArrowRight size={17} />
          </a>
        </div>
      </section>

      <footer className="launch-footer">
        <div className="footer-brand">
          <a className="launch-logo" href="/">
            <span>
              <BrandMark />
            </span>
            <strong>Trevra</strong>
          </a>
          <p>Evidence-backed pure GTM OS. Exact approval before external action.</p>
        </div>
        <div>
          <strong>Product</strong>
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </div>
        <div>
          <strong>Source</strong>
          <a href={sourceHref} target="_blank" rel="noreferrer">
            GitHub repository
          </a>
          <a href="/catalog/modules.json">Catalog JSON</a>
          <a href="/catalog/trevra.sbom.cdx.json">SBOM (CycloneDX)</a>
          <a href="/llms.txt">Context for language models</a>
        </div>
        <div>
          <strong>Company</strong>
          <a href="/how-it-works">How it works</a>
          <a href="/privacy">Privacy</a>
          <a href="/security">Security</a>
          <a href="/terms">Terms</a>
          <a href={founderHref} onClick={() => trackEvent('marketing_founder_cta')}>
            Talk to the founder
          </a>
        </div>
        <p className="footer-note">© {new Date().getFullYear()} Trevra. Built in the open.</p>
      </footer>
    </main>
  );
}
