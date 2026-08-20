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
  Server,
  ShieldCheck,
  UsersRound
} from 'lucide-react';
import moduleCatalog from '../generated/public-modules.json';
import { getPublicConfig } from './api';
import { trackEvent } from './analytics';

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
      destination: hostedAppUrl ? 'hosted_app' : 'workspace_auth'
    });
    if (hostedAppUrl) return;
    event.preventDefault();
    onGetStarted();
  };

  const founderHref = `mailto:${supportEmail || FOUNDER_FALLBACK}`;
  const hostedHref = `${founderHref}?subject=${encodeURIComponent('Hosted workspace')}`;

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
          {/* The nav button says Login and its fallback is the ADDRESS of the
              login screen, not `#hosted` -- mirroring index.html's pre-JS copy
              of this bar exactly, so the button does not change meaning at the
              moment React replaces the static markup. `handlePrimary` still
              decides: a configured hosted workspace wins, and on the
              marketing-only build it scrolls to the deploy card. */}
          <a
            className="launch-nav-cta"
            data-hosted-cta
            href={hostedAppUrl ? `${hostedAppUrl}/login` : '/login'}
            onClick={handlePrimary}
          >
            Login <ArrowRight size={16} />
          </a>
        </div>
      </header>

      <section className="launch-hero" id="top">
        <div className="hero-copy">
          <h1>Run GTM with Claude Code or Codex.</h1>
          <p className="hero-lede">
            Trevra gives agents tools for research, scoring, outreach, and revenue work. External
            actions wait for your approval. Every run is logged. The runtime is open source.
          </p>
          <div className="launch-actions">
            <a className="launch-button" data-hosted-cta href={primaryHref} onClick={handlePrimary}>
              <Play size={17} fill="currentColor" /> Open Trevra
            </a>
            <a className="launch-secondary" href="#approval">
              <ShieldCheck size={17} /> See approvals
            </a>
          </div>
          <p className="hero-facts">
            <a href="/catalog/modules.json" onClick={() => trackEvent('marketing_catalog_json')}>
              {liveModules.length} modules in the catalog
            </a>
            <span aria-hidden="true">·</span>
            <a href="/catalog/trevra.sbom.cdx.json">Software bill of materials</a>
          </p>
        </div>

        {/* The hero artifact is the policy file, not a terminal mock: it is the
            one object on this page a competitor cannot ship by Friday. */}
        <figure className="hero-policy">
          <div className="policy-card">
            <div className="policy-head">
              <ShieldCheck size={20} />
              <span>workspace.policy.yaml</span>
              <em>enforced</em>
            </div>
            <pre>
              <code>{POLICY_FILE}</code>
            </pre>
            <div className="policy-foot">
              <Check size={16} /> Checked before external actions
            </div>
          </div>
          <figcaption>This file controls what agents can do without approval.</figcaption>
        </figure>
      </section>

      {/* The gate. A native disclosure: in the DOM for a crawler, announced as a
          disclosure to a screen reader, operable from the keyboard, and it works
          with the script tag removed. */}
      <section className="gate" id="approval" aria-labelledby="gate-title">
        <div className="gate-inner">
          <div className="gate-head" id="security">
            <h2 id="gate-title">External actions require approval.</h2>
            <p>
              Trevra checks <code>workspace.policy.yaml</code> before acting. This run is prepared
              and waiting for approval.
            </p>
            <p>
              Research, scoring, sequencing, and drafting can run automatically. Trevra records each
              run, its inputs, evidence, and result.
            </p>
          </div>

          <div className="gate-body">
            <figure className="gate-run">
              <figcaption>
                <span>
                  <code>run_8f2e</code> · approve-outreach
                </span>
                <em>prepared</em>
              </figcaption>
              <p className="gate-what">
                5 personalized emails · one recipient each · scheduled +30 min after approval
              </p>
              <table className="gate-checks">
                <caption>What the policy file said about this run.</caption>
                <thead>
                  <tr>
                    <th scope="col">policy</th>
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
                <span>pins this exact payload. Edited work cannot reuse the approval.</span>
              </p>
            </figure>

            <div className="gate-decide">
              <p className="gate-line">
                <span>Nothing past this line has been sent</span>
              </p>
              <p className="gate-brief">The draft is stored in the ledger and has not been sent.</p>
              <details className="gate-decision">
                <summary className="gate-summary">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span className="when-closed">Approve this run</span>
                  <span className="when-open">Approved — released to you</span>
                </summary>
                <div className="gate-release">
                  <p className="release-label">
                    Released: 1 of 5 drafts, as <code>gtm.outreach-draft</code> wrote it.
                  </p>
                  <div className="release-mail">
                    <p className="release-meta">
                      Subject: the tier table your docs are still serving
                    </p>
                    <p>
                      You moved Standard to usage-based pricing on the 28th. The old tier table is
                      still in your docs sitemap, so that is the version the answer engines are
                      quoting back.
                    </p>
                    <p>
                      Worth fifteen minutes? I will bring what four assistants currently say your
                      pricing is.
                    </p>
                  </div>
                  <p className="release-ledger">
                    <code>run_8f2e</code> approved · <code>send-outreach</code> released · hash
                    verified · written to the ledger
                  </p>
                  <p className="release-note">
                    In a workspace, approval releases the send. This demo only reveals the draft.
                  </p>
                </div>
              </details>
            </div>
          </div>

          <div className="gate-points">
            <div>
              <ScrollText />
              <span>
                <strong>Full run ledger</strong>
                <small>Inputs, outputs, evidence, failures, and results.</small>
              </span>
            </div>
            <div>
              <KeyRound />
              <span>
                <strong>Exact-payload approval</strong>
                <small>Changes after approval are rejected.</small>
              </span>
            </div>
            <div>
              <LockKeyhole />
              <span>
                <strong>Set hard limits</strong>
                <small>Control action types, confidence, amounts, volume, and timing.</small>
              </span>
            </div>
          </div>
        </div>
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
            <div className="deploy-icon">
              <Cloud />
            </div>
            <span className="deploy-label">Trevra hosted</span>
            <h3>Managed Trevra.</h3>
            <p>
              We run PostgreSQL, authentication, integrations, backups, the ledger, and the approval
              queue.
            </p>
            <ul>
              <li>
                <Check /> Managed PostgreSQL, secrets and updates
              </li>
              <li>
                <Check /> Catalog releases synced from GitHub
              </li>
              <li>
                <Check /> Bring Claude Code or Codex as the operator
              </li>
            </ul>
            <p className="deploy-price">
              {hostedAppUrl
                ? 'Self-serve. Sign in or create a workspace.'
                : 'Hosted access is opening in batches.'}
            </p>
            {hostedAppUrl ? (
              <a
                className="launch-button"
                href={`${hostedAppUrl}/login`}
                onClick={() => trackEvent('marketing_hosted_cta')}
              >
                <Play size={17} fill="currentColor" /> Launch managed workspace
              </a>
            ) : (
              <a
                className="launch-button"
                href={hostedHref}
                onClick={() => trackEvent('marketing_founder_cta')}
              >
                <UsersRound size={17} /> Ask the founder for a workspace
              </a>
            )}
          </article>
          <article className="deploy-card">
            <div className="deploy-icon">
              <Server />
            </div>
            <span className="deploy-label">Self-hosted</span>
            <h3>Run Trevra yourself.</h3>
            <p>Use your own PostgreSQL and providers. Keep the ledger in your environment.</p>
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
            <a
              className="launch-secondary"
              href={`${sourceHref}#readme`}
              target="_blank"
              rel="noreferrer"
              onClick={() => trackEvent('marketing_self_host_cta')}
            >
              <Github size={17} /> Read the deployment guide
            </a>
          </article>
        </div>
        <details className="deploy-modules">
          <summary>See the {liveModules.length} modules</summary>
          <ul className="module-list">
            {liveModules.map((module) => (
              <ModuleRow module={module} key={module.id} />
            ))}
          </ul>
        </details>
        <div className="deploy-close">
          <div className="launch-actions">
            <a
              className="launch-button light"
              data-hosted-cta
              href={primaryHref}
              onClick={handlePrimary}
            >
              Open Trevra <ArrowRight size={17} />
            </a>
            <a
              className="launch-secondary light"
              href={sourceHref}
              target="_blank"
              rel="noreferrer"
              onClick={() => trackEvent('marketing_source_cta')}
            >
              <Github size={17} /> View source
            </a>
          </div>
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
          <p>Open-source GTM infrastructure for AI agents.</p>
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
          <a href="/privacy">Privacy</a>
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
