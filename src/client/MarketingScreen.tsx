import { ArrowRight, ChevronDown, Github, Menu, Server, ShieldCheck } from 'lucide-react';
import { FAQ_ITEMS } from '../shared/site-metadata';
import { trackEvent } from './analytics';
import { BrandMark } from './ui/BrandMark';

const REPO_URL = 'https://github.com/leanchain/trevra';
const FOUNDER_EMAIL = 'pankaj@usetrevra.com';

const NAV_LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#faq', label: 'FAQ' }
] as const;

type MarketingScreenProps = {
  onGetStarted: () => void;
  hostedAppUrl?: string;
  githubUrl?: string;
};

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

export function MarketingScreen({
  onGetStarted,
  hostedAppUrl = '',
  githubUrl = ''
}: MarketingScreenProps) {
  const primaryHref = hostedAppUrl || '#hosted';
  const primaryLabel = hostedAppUrl ? 'Open workspace' : 'Request hosted access';
  const navLabel = hostedAppUrl ? 'Workspace' : 'Request access';
  const sourceHref = githubUrl || REPO_URL;

  const handlePrimary = (event: React.MouseEvent<HTMLAnchorElement>) => {
    trackEvent('marketing_primary_cta', {
      destination: hostedAppUrl ? 'hosted_app' : 'hosted_access'
    });
    if (hostedAppUrl) return;
    event.preventDefault();
    onGetStarted();
  };

  const founderHref = `mailto:${FOUNDER_EMAIL}`;
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
          <a
            className="nav-source"
            href={sourceHref}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            title="GitHub"
            onClick={() => trackEvent('marketing_source_cta')}
          >
            <Github size={17} aria-hidden="true" />
          </a>
          <ThemeToggle />
          <a className="launch-nav-cta" data-hosted-cta href={primaryHref} onClick={handlePrimary}>
            {navLabel} <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </header>

      <section className="launch-hero" id="top">
        <div className="hero-copy">
          <h1>Know who’s worth selling to before you reach out.</h1>
          <p className="hero-lede">
            Trevra researches companies, people, and buying signals to show you where the real
            opportunities are, so you focus on a few high-potential customers instead of blasting
            hundreds of cold emails.
          </p>
          <div className="launch-actions">
            <a className="launch-button" data-hosted-cta href={primaryHref} onClick={handlePrimary}>
              {primaryLabel} <ArrowRight size={17} aria-hidden="true" />
            </a>
            <a className="launch-secondary" href="#how">
              See how it works
            </a>
          </div>
        </div>

        <figure className="hero-evidence">
          <div className="evidence-card">
            <div className="evidence-head">
              <span>Customer Research</span>
              <em>continuous · evidence backed</em>
            </div>
            <ol className="evidence-list">
              <li className="evidence-signal">
                <span className="evidence-kind">FOUND</span>
                <span>
                  <strong>Research found three signals that make this company matter now</strong>
                  <span className="evidence-source">
                    <span>HARD FACT ×2 · REPORTED ×1</span>
                    <span>3 source links</span>
                  </span>
                </span>
              </li>
              <li className="evidence-signal">
                <span className="evidence-kind">SCORED</span>
                <span>
                  <strong>This company stands out from the rest</strong>
                  <span className="evidence-source">
                    <span>why-now signal matched</span>
                    <span>priority 9.1 / 10</span>
                  </span>
                </span>
              </li>
              <li className="evidence-signal">
                <span className="evidence-kind">READY</span>
                <span>
                  <strong>One researched opportunity is ready for action</strong>
                  <span className="evidence-source">
                    <span>1 recipient</span>
                    <span>not sent</span>
                  </span>
                </span>
              </li>
              <li className="evidence-signal">
                <span className="evidence-kind evidence-kind-reported">WAITING</span>
                <span>
                  <strong>Your approval is required</strong>
                  <span className="evidence-source">
                    <span>exact action locked</span>
                    <code>sha256:4f21b8…c7e0</code>
                  </span>
                </span>
              </li>
            </ol>
            <dl className="control-receipt">
              <div>
                <dt>action</dt>
                <dd>
                  <code>email.send</code>
                </dd>
              </div>
              <div>
                <dt>approval</dt>
                <dd>this exact draft only</dd>
              </div>
              <div className="receipt-state">
                <dt>state</dt>
                <dd>prepared · not sent</dd>
              </div>
            </dl>
          </div>
        </figure>
      </section>

      <section className="launch-section workspace-section" id="how" aria-labelledby="how-title">
        <div className="split-heading">
          <h2 id="how-title">Research first. Act with conviction.</h2>
          <p>
            The goal is not more activity. Trevra keeps research fresh, verifies why a company
            matters now, and ranks the opportunities where focused attention can create the most
            value.
          </p>
        </div>

        <ol className="simple-loop" aria-label="Trevra research workflow">
          <li>
            <strong>1. Research</strong>
            <span>Continuously scan companies, communities, conversations, and sources.</span>
          </li>
          <li>
            <strong>2. Verify</strong>
            <span>Connect evidence so every why-now signal has a source behind it.</span>
          </li>
          <li>
            <strong>3. Rank</strong>
            <span>Surface the few companies where fit, timing, and evidence are strongest.</span>
          </li>
          <li>
            <strong>4. Act</strong>
            <span>Prepare a specific next move for the opportunities worth your attention.</span>
          </li>
          <li>
            <strong>5. Learn</strong>
            <span>Replies and outcomes sharpen the next round of research and prioritization.</span>
          </li>
        </ol>

        <figure className="workspace-preview">
          <aside className="workspace-rail" aria-label="Illustrative Trevra workspace navigation">
            <div className="workspace-wordmark">
              <span>
                <BrandMark />
              </span>
              <strong>Trevra</strong>
            </div>
            <ul>
              <li className="is-active">Loop</li>
              <li>Outreach</li>
              <li>Ledger</li>
              <li>Research</li>
              <li>Setup</li>
            </ul>
            <span className="workspace-agent-state">
              <span aria-hidden="true" />
              Agent connected
            </span>
          </aside>

          <div className="workspace-canvas">
            <header className="workspace-canvas-head">
              <div>
                <span>Research / opportunity queue</span>
                <h3>Research found the company worth your attention.</h3>
              </div>
              <span className="workspace-status">Needs approval</span>
            </header>
            <div className="workspace-case">
              <div className="workspace-case-copy">
                <span className="workspace-case-type">Why now</span>
                <h4>Three linked signals explain why this company matters now.</h4>
                <p>The evidence, sources, priority, and next action stay connected in one place.</p>
                <div className="workspace-proof-tags" aria-label="Evidence types">
                  <span>HARD FACT ×2</span>
                  <span>REPORTED ×1</span>
                  <span>3 source links</span>
                </div>
              </div>
              <div className="workspace-decision">
                <dl className="workspace-case-state">
                  <div>
                    <dt>Agent prepared</dt>
                    <dd>
                      <code>email.send</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Policy</dt>
                    <dd>your approval required</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>prepared · not sent</dd>
                  </div>
                  <div>
                    <dt>Payload</dt>
                    <dd>
                      <code>sha256:4f21b8…c7e0</code>
                    </dd>
                  </div>
                </dl>
                <details className="workspace-payload">
                  <summary>
                    <ShieldCheck size={17} aria-hidden="true" />
                    <span className="payload-summary-closed">Reveal the exact payload</span>
                    <span className="payload-summary-open">Hide the exact payload</span>
                    <ChevronDown size={16} aria-hidden="true" />
                  </summary>
                  <div className="workspace-payload-body">
                    <p>
                      <strong>To:</strong> one approved recipient
                    </p>
                    <p>
                      <strong>Subject:</strong> approval boundaries for agent-run outreach
                    </p>
                    <p>
                      I saw your team is building agent infrastructure. Are you putting a hard
                      approval boundary around external sales actions?
                    </p>
                  </div>
                </details>
              </div>
            </div>
          </div>
        </figure>
      </section>

      <section className="launch-section deploy-section" id="deploy">
        <div className="split-heading">
          <h2>Start hosted. Self-host if you prefer.</h2>
          <p>Same product. Same approval gate. Choose who runs the infrastructure.</p>
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
              We run the database, integrations, backups, and updates. You connect Claude Code or
              Codex.
            </p>
          </div>
          <div className="hosted-action">
            <p className="deploy-price">
              {hostedAppUrl ? 'Your workspace is ready.' : 'Hosted access is opening in batches.'}
            </p>
            <a
              className="launch-button"
              data-hosted-cta
              href={conversionHref}
              onClick={() =>
                trackEvent(hostedAppUrl ? 'marketing_hosted_cta' : 'marketing_founder_cta')
              }
            >
              {primaryLabel} <ArrowRight size={17} aria-hidden="true" />
            </a>
            <p className="hosted-action-note">
              {hostedAppUrl
                ? 'Opens your Trevra workspace.'
                : 'Opens an email with the request subject filled in.'}
            </p>
          </div>
        </article>

        <div className="self-host-line">
          <div>
            <Server size={20} aria-hidden="true" />
            <span>
              <strong>Prefer your own infrastructure?</strong>
              <small>Trevra is open source and PostgreSQL-only.</small>
            </span>
          </div>
          <a
            className="launch-secondary"
            href={`${sourceHref}#readme`}
            target="_blank"
            rel="noreferrer"
            onClick={() => trackEvent('marketing_self_host_cta')}
          >
            <Github size={17} aria-hidden="true" /> Read the self-host guide
          </a>
        </div>

        <section className="landing-faq" id="faq" aria-labelledby="faq-title">
          <div className="split-heading">
            <h2 id="faq-title">Questions, answered.</h2>
            <p>The short version, without hiding the important parts.</p>
          </div>
          <div className="landing-faq-list">
            {FAQ_ITEMS.map(({ question, answer }) => (
              <article className="landing-faq-item" key={question}>
                <h3>{question}</h3>
                <p>{answer}</p>
              </article>
            ))}
          </div>
        </section>

        <div className="deploy-close">
          <h3>Let the agent work. Keep the final say.</h3>
          <a
            className="launch-button"
            data-hosted-cta
            href={conversionHref}
            onClick={() =>
              trackEvent(hostedAppUrl ? 'marketing_hosted_cta' : 'marketing_founder_cta')
            }
          >
            {primaryLabel} <ArrowRight size={17} aria-hidden="true" />
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
          <p>Continuous research. Focused outreach. Human approval.</p>
        </div>
        <div>
          <strong>Product</strong>
          <a href="#how">How it works</a>
          <a href="#faq">FAQ</a>
          <a href="#deploy">Deploy</a>
        </div>
        <div>
          <strong>Open source</strong>
          <a href={sourceHref} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="/catalog/modules.json">Module catalog</a>
          <a href="/security">Security</a>
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
