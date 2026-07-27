import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  Cloud,
  Code2,
  GitBranch,
  Github,
  GitPullRequestArrow,
  KeyRound,
  Layers3,
  LockKeyhole,
  Network,
  Play,
  ScrollText,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  UsersRound,
  Workflow
} from 'lucide-react';
import moduleCatalog from '../generated/public-modules.json';
import { getPublicConfig } from './api';
import { trackEvent } from './analytics';

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

const STATIC_MODULES = moduleCatalog.modules as PublicModule[];

const AGENT_ROLES = [
  {
    name: 'Scout',
    job: 'Research and source',
    description: 'Find accounts, inspect signals, and turn raw markets into evidence-backed opportunities.',
    skills: ['visibility-audit', 'validate-host']
  },
  {
    name: 'Qualifier',
    job: 'Score and prioritize',
    description: 'Apply your wedge, lifecycle rules, and reasons to decide what deserves founder attention.',
    skills: ['score-lead', 'lead-status']
  },
  {
    name: 'Operator',
    job: 'Draft and distribute',
    description: 'Prepare outreach and channel-specific copy, then stop before consequential execution.',
    skills: ['outreach-draft', 'channel-prepare']
  },
  {
    name: 'Controller',
    job: 'Prove and govern',
    description: 'Record each run, pin approved payloads, and enforce the policy around external actions.',
    skills: ['copy-critique', 'approval-gate']
  }
] as const;

const WORKFLOW_STEPS = [
  ['01', 'Give Claude the outcome', 'Describe the market, offer, constraints, and target result in the tool you already use.'],
  ['02', 'Trevra composes the run', 'The agent selects typed modules, validates every input, and records the plan before work begins.'],
  ['03', 'Safe work runs automatically', 'Research, scoring, critique, and preparation can run without turning the system into a dashboard job.'],
  ['04', 'Consequential work stops', 'Messages, invoices, discounts, and other external writes wait behind your workspace policy.'],
  ['05', 'Approved work is pinned', 'The exact payload is hashed before execution. A changed payload is rejected instead of silently sent.'],
  ['06', 'Outcomes improve the system', 'Runs, evidence, decisions, and results become shared revenue memory for the next agent action.']
] as const;

const LEDGER_SAMPLE = [
  { id: 'run_8f2a', skill: 'gtm.visibility-audit', state: 'recorded', tone: 'done' },
  { id: 'run_8f2b', skill: 'gtm.score-lead', state: 'recorded', tone: 'done' },
  { id: 'run_8f2c', skill: 'gtm.outreach-draft', state: 'prepared', tone: 'ready' },
  { id: 'run_8f2d', skill: 'gtm.copy-critique', state: 'passed', tone: 'done' },
  { id: 'run_8f2e', skill: 'gtm.outreach-send', state: 'awaiting you', tone: 'gate' }
] as const;

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

function ModuleCard({ module }: { module: PublicModule }) {
  return (
    <article className="module-card">
      <div className="module-card-top">
        <code>{module.id}</code>
        <span>v{module.version}</span>
      </div>
      <h3>{module.name}</h3>
      <p>{module.description}</p>
      <div className="module-meta">
        <span><Network size={14} /> {module.sideEffect}</span>
        <span><Play size={14} /> {module.popularity.totalRuns.toLocaleString('en-US')} runs{module.popularity.rank ? ` · #${module.popularity.rank}` : ''}</span>
        <span className={module.requiresApproval ? 'requires-approval' : undefined}>
          {module.requiresApproval ? <LockKeyhole size={14} /> : <Check size={14} />}
          {module.requiresApproval ? 'approval declared' : 'safe to compose'}
        </span>
      </div>
    </article>
  );
}

export function MarketingScreen({ onGetStarted, hostedAppUrl = '', githubUrl = '' }: MarketingScreenProps) {
  const [supportEmail, setSupportEmail] = useState(import.meta.env.VITE_SUPPORT_EMAIL?.trim() ?? '');
  const [registryApiUrl, setRegistryApiUrl] = useState(import.meta.env.VITE_CATALOG_API_URL?.trim() ?? '');
  const [liveModules, setLiveModules] = useState<PublicModule[]>(STATIC_MODULES);
  const primaryHref = hostedAppUrl || '#hosted';
  const sourceHref = githubUrl || '#modules';

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
        setLiveModules(merged.sort((left, right) =>
          (right.popularity.totalRuns - left.popularity.totalRuns) || left.id.localeCompare(right.id)
        ));
      })
      .catch(() => undefined);
  }, [registryApiUrl]);

  const handlePrimary = (event: React.MouseEvent<HTMLAnchorElement>) => {
    trackEvent('marketing_primary_cta', { destination: hostedAppUrl ? 'hosted_app' : 'workspace_auth' });
    if (hostedAppUrl) return;
    event.preventDefault();
    onGetStarted();
  };

  const founderHref = supportEmail
    ? `mailto:${supportEmail}?subject=${encodeURIComponent('Trevra founder conversation')}`
    : '#hosted';

  return (
    <main className="static-launch">
      <header className="launch-nav">
        <a className="launch-logo" href="/" aria-label="Trevra home"><span>T</span><strong>Trevra</strong></a>
        <nav aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#modules">Modules</a>
          <a href="#security">Security</a>
          <a href="#deploy">Deploy</a>
        </nav>
        <div className="launch-nav-actions">
          <ThemeToggle />
          <a className="nav-source" href={sourceHref} onClick={() => trackEvent('marketing_source_cta')}><Github size={16} /> Source</a>
          <a className="launch-nav-cta" href={primaryHref} onClick={handlePrimary}>Launch Trevra <ArrowRight size={16} /></a>
        </div>
      </header>

      <section className="launch-hero" id="top">
        <div className="hero-copy">
          <div className="launch-eyebrow"><span className="live-dot" /> Open-source operating system for agent-run GTM</div>
          <h1>Spawn the GTM team your company needs.</h1>
          <p className="hero-lede">Give Claude or Codex a revenue outcome. Trevra composes modular skills to research, qualify, prepare outreach, follow up, invoice, and collect—while evidence, approvals, and every run stay under your control.</p>
          <div className="launch-actions">
            <a className="launch-button" href={primaryHref} onClick={handlePrimary}><Play size={17} fill="currentColor" /> Launch hosted workspace</a>
            <a className="launch-secondary" href="#modules"><Boxes size={17} /> Explore the modules</a>
          </div>
          <div className="hero-proof">
            <span><CheckCircle2 size={15} /> Operate from Claude Code or Codex</span>
            <span><CheckCircle2 size={15} /> Self-host on PostgreSQL</span>
            <span><CheckCircle2 size={15} /> Update modules through GitHub</span>
          </div>
        </div>

        <div className="agent-console" aria-label="Example Trevra agent run">
          <div className="console-bar">
            <span><i /><i /><i /></span>
            <code>trevra / founder-led-growth</code>
            <span className="console-status">live</span>
          </div>
          <div className="console-command"><span>$</span><code>spawn gtm --goal "book qualified founder calls"</code></div>
          <div className="console-team">
            <div><Bot size={18} /><span><strong>Scout</strong><small>market research</small></span><em>running</em></div>
            <div><Sparkles size={18} /><span><strong>Qualifier</strong><small>fit scoring</small></span><em>running</em></div>
            <div><Workflow size={18} /><span><strong>Operator</strong><small>message preparation</small></span><em>ready</em></div>
          </div>
          <div className="console-ledger">
            <div className="ledger-head"><span>run</span><span>module</span><span>state</span></div>
            {LEDGER_SAMPLE.map((entry) => (
              <div className={`ledger-row ledger-${entry.tone}`} key={entry.id}>
                <code>{entry.id}</code><span>{entry.skill}</span><strong>{entry.state}</strong>
              </div>
            ))}
          </div>
          <div className="approval-card">
            <div><ShieldCheck size={18} /><span><strong>Approval required</strong><small>5 personalized emails · send delay 30 min</small></span></div>
            <code>sha256:4f21b8…c7e0</code>
          </div>
        </div>
      </section>

      <section className="trust-strip" aria-label="Trevra operating principles">
        <span>Typed modules</span><i />
        <span>Evidence on every run</span><i />
        <span>Payload hashing</span><i />
        <span>Workspace approval policy</span><i />
        <span>Open-source and self-hostable</span>
      </section>

      <section className="launch-section problem-section">
        <div className="section-kicker">A team without more dashboards</div>
        <div className="split-heading">
          <h2>Agents do the work. Trevra makes the work governable.</h2>
          <p>Most agent products give you another interface to operate. Trevra gives your coding agent a small, testable GTM runtime—and gives you the memory and control layer around it.</p>
        </div>
        <div className="agent-role-grid">
          {AGENT_ROLES.map((role, index) => (
            <article className="agent-role" key={role.name}>
              <span className="role-index">0{index + 1}</span>
              <div className="role-icon">{index === 0 ? <TerminalSquare /> : index === 1 ? <Layers3 /> : index === 2 ? <GitBranch /> : <ShieldCheck />}</div>
              <p>{role.job}</p>
              <h3>{role.name}</h3>
              <div>{role.description}</div>
              <ul>{role.skills.map((skill) => <li key={skill}>{skill}</li>)}</ul>
            </article>
          ))}
        </div>
      </section>

      <section className="launch-section workflow-section" id="how-it-works">
        <div className="section-kicker">One revenue loop</div>
        <div className="split-heading">
          <h2>From founder instruction to approved execution.</h2>
          <p>Use Claude Code, Codex, or another capable agent as the operator. Trevra supplies the contracts, runtime, ledger, evidence, and approval boundary.</p>
        </div>
        <div className="workflow-grid">
          {WORKFLOW_STEPS.map(([number, title, description]) => (
            <article key={number}>
              <span>{number}</span><div><h3>{title}</h3><p>{description}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="launch-section modules-section" id="modules">
        <div className="section-kicker">Community module registry</div>
        <div className="split-heading">
          <h2>Install the judgement. Fork the parts you disagree with.</h2>
          <p>Every module declares its inputs, outputs, side-effect class, approval requirement, and version. The public catalog is generated from the same registry the runner executes.</p>
        </div>
        <div className="catalog-toolbar">
          <div><span className="catalog-count">{liveModules.length}</span><span>modules · {liveModules.reduce((sum, module) => sum + module.popularity.totalRuns, 0).toLocaleString('en-US')} recorded runs</span></div>
          <div className="catalog-path"><GitPullRequestArrow size={16} /><code>GitHub → validation → catalog → hosted runtime</code></div>
        </div>
        <div className="module-grid">
          {liveModules.map((module) => <ModuleCard module={module} key={module.id} />)}
        </div>
        <div className="catalog-contract">
          <div><Code2 size={22} /><span><strong>One contract, any implementation</strong><small>TypeScript today; HTTP + JSON Schema keeps the ecosystem polyglot.</small></span></div>
          <a href="/catalog/modules.json" onClick={() => trackEvent('marketing_catalog_json')}>Open catalog JSON <ArrowRight size={16} /></a>
        </div>
      </section>

      <section className="launch-section security-section" id="security">
        <div className="security-copy">
          <div className="section-kicker">Control plane, not black box</div>
          <h2>Give agents capability without giving away control.</h2>
          <p>Trevra draws a hard line between interpretation and execution. Models can interpret commercial context. Deterministic software controls permissions, state transitions, money, approvals, and external writes.</p>
          <div className="security-points">
            <div><ScrollText /><span><strong>Complete run ledger</strong><small>Inputs, outputs, evidence, failures, and outcomes are written per workspace.</small></span></div>
            <div><KeyRound /><span><strong>Cryptographically pinned approvals</strong><small>The exact approved payload is hashed. Mutated work cannot reuse the approval.</small></span></div>
            <div><LockKeyhole /><span><strong>Scoped delegation</strong><small>Limit action type, confidence, amount, volume, and delay. Scope changes remain manual.</small></span></div>
          </div>
        </div>
        <div className="policy-card">
          <div className="policy-head"><ShieldCheck size={20} /><span>workspace.policy.yaml</span><em>enforced</em></div>
          <pre><code>{`external_writes:
  default: require_approval

outreach.send:
  max_recipients: 5
  confidence_min: 0.84
  delay_minutes: 30

invoice.create:
  approval_required: true
  amount_ceiling: 2500

scope.change:
  delegation: forbidden`}</code></pre>
          <div className="policy-foot"><CheckCircle2 size={16} /> Evaluated before every consequential run</div>
        </div>
      </section>

      <section className="launch-section deploy-section" id="deploy">
        <div className="section-kicker">Run it your way</div>
        <div className="split-heading">
          <h2>Hosted convenience. Self-hosted ownership. The same modules.</h2>
          <p>The public site and catalog deploy at Cloudflare’s edge. The product runtime stays portable: managed by Trevra or deployed into infrastructure you control.</p>
        </div>
        <div className="deploy-grid">
          <article className="deploy-card featured" id="hosted">
            <div className="deploy-icon"><Cloud /></div>
            <span className="deploy-label">Trevra hosted</span>
            <h3>Start with the managed control plane.</h3>
            <p>Use managed updates, workspace authentication, integrations, backups, and a shared module catalog without operating the infrastructure.</p>
            <ul>
              <li><Check /> Automatic application and module updates</li>
              <li><Check /> Managed PostgreSQL and encrypted secrets</li>
              <li><Check /> GitHub-synced catalog releases</li>
              <li><Check /> Bring Claude Code or Codex as the operator</li>
            </ul>
            <a className="launch-button" href={primaryHref} onClick={handlePrimary}>Launch hosted workspace <ArrowRight size={16} /></a>
          </article>
          <article className="deploy-card">
            <div className="deploy-icon"><Server /></div>
            <span className="deploy-label">Self-hosted</span>
            <h3>Own the runtime and every record.</h3>
            <p>Fork the repository, deploy the Express service and PostgreSQL, connect your own providers, and keep the ledger inside your environment.</p>
            <ul>
              <li><Check /> Open code and forward-only migrations</li>
              <li><Check /> Exportable workspace ledger and evidence</li>
              <li><Check /> Operator-controlled module configuration</li>
              <li><Check /> No cloud-only approval or audit layer</li>
            </ul>
            <a className="launch-secondary" href={sourceHref} onClick={() => trackEvent('marketing_self_host_cta')}><Github size={17} /> View self-host source</a>
          </article>
        </div>
        <div className="deploy-flow">
          <div><Github /><span><strong>Merge to main</strong><small>Code and module manifests live in GitHub.</small></span></div>
          <ArrowRight />
          <div><CheckCircle2 /><span><strong>Validate and build</strong><small>Types, tests, catalog generation, and production build.</small></span></div>
          <ArrowRight />
          <div><Cloud /><span><strong>Deploy to Cloudflare</strong><small>The landing page and public catalog publish globally.</small></span></div>
        </div>
      </section>

      <section className="launch-section integrations-section">
        <div className="section-kicker">Existing stack, shared memory</div>
        <div className="split-heading">
          <h2>Connect the tools where the revenue loop already runs.</h2>
          <p>Trevra does not replace your mailbox, calendar, accounting system, or payment provider. It gives agents a governed way to work across them.</p>
        </div>
        <div className="integration-list">
          {['Gmail', 'Microsoft 365', 'Google Calendar', 'Stripe', 'QuickBooks', 'Xero', 'HoneyBook', 'Bonsai', 'CSV imports'].map((name) => <span key={name}>{name}</span>)}
        </div>
      </section>

      <section className="launch-section faq-section">
        <div className="section-kicker">Questions founders ask</div>
        <div className="faq-layout">
          <div><h2>Clear boundaries before you delegate revenue work.</h2><p>Hosted and self-hosted deployments use the same module contracts and approval model.</p></div>
          <div className="launch-faq">
            <details><summary>How do I actually use Trevra?</summary><p>You give Claude Code, Codex, or another agent a GTM outcome. The agent calls Trevra modules for research, scoring, preparation, governance, and execution. Trevra records the run and stops at the approval boundary when the work could change an external system.</p></details>
            <details><summary>Can an agent send messages or create invoices by itself?</summary><p>Only inside the policy you set. Consequential actions can require manual approval, and the exact approved payload is hashed before execution. Changed payloads and out-of-scope actions are rejected.</p></details>
            <details><summary>How are community modules shared safely?</summary><p>Modules are versioned through GitHub and declare their schemas, side effects, and approval requirements. Validation and tests run before a catalog release. Installing a module does not automatically grant it external-write permission.</p></details>
            <details><summary>Can I self-host Trevra and keep my data?</summary><p>Yes. The application uses PostgreSQL, the module runner is part of the open codebase, and the ledger, evidence, configuration, and exports can remain in infrastructure you control.</p></details>
          </div>
        </div>
      </section>

      <section className="launch-final">
        <div>
          <span className="section-kicker">Start with one loop</span>
          <h2>Stop being the bottleneck in your own GTM system.</h2>
          <p>Connect a workspace, install the first modules, and let your agent prepare the next revenue action—with receipts.</p>
        </div>
        <div className="launch-actions">
          <a className="launch-button light" href={primaryHref} onClick={handlePrimary}>Launch Trevra <ArrowRight size={17} /></a>
          <a className="launch-secondary light" href={founderHref} onClick={() => trackEvent('marketing_founder_cta')}><UsersRound size={17} /> Talk to the founder</a>
        </div>
      </section>

      <footer className="launch-footer">
        <div className="footer-brand"><a className="launch-logo" href="/"><span>T</span><strong>Trevra</strong></a><p>The open-source operating system and control plane for agent-run GTM.</p></div>
        <div><strong>Product</strong><a href="#how-it-works">How it works</a><a href="#modules">Modules</a><a href="#security">Security</a><a href="#deploy">Deploy</a></div>
        <div><strong>Resources</strong><a href="/catalog/modules.json">Catalog JSON</a><a href={sourceHref}>GitHub source</a><a href="/llms.txt">LLM context</a><a href="/agents.md">Agent guidance</a></div>
        <div><strong>Company</strong><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href={founderHref}>Talk to founder</a></div>
        <p className="footer-note">© {new Date().getFullYear()} Trevra. Built in the open.</p>
      </footer>
    </main>
  );
}
