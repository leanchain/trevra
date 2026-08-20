import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, CircleHelp, Keyboard, Search, X } from 'lucide-react';
import { useDialog } from './dialog';
import type { Route, Section } from './route';

/* --------------------------------------------------------------------------
 * Help, and the keyboard's own documentation.
 *
 * The shell had no help entry point anywhere: no "what is this screen", no
 * glossary, no way out to anything written down. This is that entry point, and
 * it obeys one constraint -- IT DOES NOT INVENT DOCUMENTATION. Every link goes
 * to a page this server actually serves, a file that actually exists in the
 * repository, or a command the app already prints on screen. A help panel that
 * links to a page nobody wrote is worse than no help panel, because it costs
 * the reader the click before it disappoints them.
 *
 * Repository paths are rendered as text rather than links on purpose: `docs/`
 * is not served over HTTP, and a link that 404s is the failure above.
 * -------------------------------------------------------------------------- */

interface HelpTopic {
  heading: string;
  does: string;
  /** Words this screen uses that a founder has not met anywhere else. */
  vocabulary: Array<{ term: string; meaning: string }>;
  more: React.ReactNode;
}

const HELP: Record<Section, HelpTopic> = {
  loop: {
    heading: 'Loop',
    does: 'Shows the outreach loop from finding people to reaching them and handling replies. It highlights the first stage that needs action.',
    vocabulary: [
      { term: 'Stage', meaning: 'One step in the loop: Find, Reach, or Answer.' },
      { term: 'Stuck', meaning: 'The first stage that needs action.' }
    ],
    more: (
      <p>
        The loop and the vocabulary behind it are written down in{' '}
        <code>docs/gtm-shell-shape.md</code> and <code>docs/founder-skills.md</code>.
      </p>
    )
  },
  outreach: {
    heading: 'Outreach',
    does: 'Manage LinkedIn accounts, lead lists, workflows, campaigns, and replies.',
    vocabulary: [
      { term: 'HARD FACT', meaning: 'A limit published or enforced by LinkedIn.' },
      { term: 'REPORTED', meaning: 'A practitioner-reported limit not confirmed by LinkedIn.' },
      { term: 'Workflow', meaning: 'The ordered steps a lead goes through.' },
      { term: 'Campaign', meaning: 'A lead list running through a workflow on one account.' },
      { term: 'Manual message', meaning: 'A workflow step that waits for you.' },
      { term: 'Warm-up', meaning: 'Reduced volume for new accounts and campaigns.' },
      {
        term: 'Daily limits',
        meaning: 'Per-account limits for invites, messages, views, and follows.'
      },
      { term: 'Working hours', meaning: 'The days and hours an account may act.' },
      { term: 'Sending status', meaning: 'Ramping, running, slowed, or paused.' },
      { term: 'Safety check', meaning: 'A final limit check before an action runs.' },
      { term: 'Branch', meaning: 'A step that depends on an earlier outcome.' },
      {
        term: 'Lead sourcing',
        meaning: 'Builds lead lists from LinkedIn searches, posts, and keywords.'
      }
    ],
    more: (
      <p>
        The pacing policy, and where each number came from, is in{' '}
        <code>docs/linkedin-outreach-plan.md</code>. The public write-up is at{' '}
        <a href="/how-it-works">How it works</a>.
      </p>
    )
  },
  ledger: {
    heading: 'Run ledger',
    does: 'Every run this workspace has performed, newest first, with the evidence — and a way to take it with you. A job Trevra ran and a run by Trevra’s own agent are the same thing here: work that happened.',
    vocabulary: [
      { term: 'Run', meaning: 'One job from start to finish.' },
      { term: 'Step', meaning: 'One model call, tool call, or approval inside a run.' },
      { term: 'Evidence', meaning: 'The source used by a step.' },
      { term: 'What you signed', meaning: 'The fingerprint of the approved payload.' }
    ],
    more: (
      <p>
        Every run is inspectable to the node; what that guarantees is section 10 of{' '}
        <code>docs/app-spec.md</code>.
      </p>
    )
  },
  research: {
    heading: 'Research',
    does: 'One feed over discovered community threads and company research briefs, across every connected platform.',
    vocabulary: [
      { term: 'Thread', meaning: 'A community post scouted and scored for reply-worthiness.' },
      {
        term: 'Research brief',
        meaning: 'A company-level finding produced by the research-brief skill.'
      }
    ],
    more: (
      <p>
        The sources this feed combines are documented in{' '}
        <code>docs/superpowers/specs/2026-08-18-research-hub-design.md</code>.
      </p>
    )
  },
  setup: {
    heading: 'Setup',
    does: 'What can reach your workspace, what it may spend, and what it may do. Visited rarely after the first week. Agent access comes first because nothing else in Trevra works until an agent can reach the workspace.',
    vocabulary: [
      { term: 'Agent token', meaning: 'A secret used by an agent to access the workspace.' },
      { term: 'Your key', meaning: 'Your encrypted model-provider API key.' },
      { term: 'Side effect', meaning: 'What a skill can read or change outside the workspace.' },
      { term: 'Skill', meaning: 'One task an agent can run.' },
      { term: 'Hard limit', meaning: 'A rule the agent cannot override.' }
    ],
    more: (
      <>
        <p>
          Publishing a skill needs a signing key on your machine, so it lives in the terminal:{' '}
          <code>npm run module -- help</code>.
        </p>
        <p>
          Connecting an agent is one line, built for you on <strong>Setup → Agent access</strong>.
          The hosted-agent trade-off is written out in <code>docs/byok-and-hosted-agent.md</code>.
        </p>
      </>
    )
  }
};

export function HelpPanel({ route, onClose }: { route: Route; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialog(dialog, onClose);
  const topic = HELP[route.section];

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialog}
        className="drawer help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="drawer-kicker">
              <CircleHelp size={14} /> Help
            </span>
            <h3 id={titleId}>{topic.heading}</h3>
          </div>
          <button className="icon-button" aria-label="Close help" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="drawer-body">
          <section className="run-section">
            <h5>What this screen does</h5>
            <p>{topic.does}</p>
          </section>
          <section className="run-section">
            <h5>Terms</h5>
            <dl className="field-list">
              {topic.vocabulary.map((entry) => (
                <div className="field-row" key={entry.term}>
                  <dt>{entry.term}</dt>
                  <dd>{entry.meaning}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="run-section">
            <h5>More</h5>
            {topic.more}
            <p className="panel-note">
              <kbd>?</kbd> shortcuts · <kbd>Ctrl</kbd>+<kbd>K</kbd> jump
            </p>
          </section>
        </div>
      </section>
    </div>,
    document.body
  );
}

/* -------------------------------------------------------------------------- */

const SHORTCUTS: Array<{ keys: string[]; does: string; where: string }> = [
  { keys: ['Ctrl', 'K'], does: 'Jump to any screen', where: 'Anywhere' },
  { keys: ['?'], does: 'This list', where: 'Anywhere, outside a text field' },
  { keys: ['j'], does: 'Next item', where: 'A focused list' },
  { keys: ['k'], does: 'Previous item', where: 'A focused list' },
  {
    keys: ['Ctrl', 'Enter'],
    does: 'Open the last check before it goes out',
    where: 'The approval drawer'
  },
  { keys: ['Esc'], does: 'Close without changing anything', where: 'Any drawer' },
  { keys: ['Tab'], does: 'Move through the screen; the caret is always visible', where: 'Anywhere' }
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialog(dialog, onClose);

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialog}
        className="drawer shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="drawer-kicker">
              <Keyboard size={14} /> Keyboard
            </span>
            <h3 id={titleId}>Keyboard shortcuts</h3>
          </div>
          <button className="icon-button" aria-label="Close the shortcut list" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="drawer-body">
          <p>
            On a Mac, <kbd>Ctrl</kbd> is <kbd>⌘</kbd>. Nothing here is bound to a bare letter while
            the caret is in a text field — in a field, a letter is a letter.
          </p>
          <dl className="field-list">
            {SHORTCUTS.map((entry) => (
              <div className="field-row" key={entry.does}>
                <dt>
                  {entry.keys.map((key, index) => (
                    <span key={key}>
                      {index > 0 ? ' + ' : ''}
                      <kbd>{key}</kbd>
                    </span>
                  ))}
                </dt>
                <dd>
                  {entry.does} <small>— {entry.where}</small>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>,
    document.body
  );
}

/* -------------------------------------------------------------------------- */

const DESTINATIONS: Array<{ path: string; label: string; hint: string }> = [
  { path: '/loop', label: 'Loop', hint: 'What the loop is doing, and where it is stuck' },
  { path: '/loop/cost', label: 'What this cost', hint: 'Spent, sent, produced — one period' },
  { path: '/outreach', label: 'Outreach · Campaigns', hint: 'Campaigns, people and companies' },
  { path: '/outreach/new', label: 'Outreach · New campaign', hint: 'Build and start one' },
  {
    path: '/outreach/inbox',
    label: 'Outreach · Messages',
    hint: 'Replies and conversations with campaign contacts'
  },
  { path: '/ledger', label: 'Run ledger', hint: 'Every run, with the evidence' },
  {
    path: '/research',
    label: 'Research',
    hint: 'Discovered threads and company research, across every platform'
  },
  { path: '/setup/agent', label: 'Setup · Agent access', hint: 'Connect Claude Code or Codex' },
  {
    path: '/setup',
    label: 'Setup · The spending cap',
    hint: 'The monthly cap and the switch, inside Agent access'
  },
  { path: '/setup/data', label: 'Setup · Connections', hint: 'Where your data comes from' },
  { path: '/setup/limits', label: 'Setup · Limits', hint: 'Hard limits and never-contact list' }
];

/**
 * Ctrl+K.
 *
 * A jumper rather than a command runner: everything it offers is a place, and
 * going to a place is the one thing that is safe to do without confirming it.
 * Nothing here acts.
 */
export function JumpPalette({
  onGo,
  onClose
}: {
  onGo: (path: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  useDialog(dialog, onClose);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return DESTINATIONS;
    return DESTINATIONS.filter(
      (entry) =>
        entry.label.toLowerCase().includes(needle) || entry.hint.toLowerCase().includes(needle)
    );
  }, [query]);

  useEffect(() => {
    field.current?.focus();
  }, []);
  useEffect(() => {
    setCursor(0);
  }, [query]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((index) => {
        const next = index + (event.key === 'ArrowDown' ? 1 : -1);
        return Math.min(matches.length - 1, Math.max(0, next));
      });
      return;
    }
    if (event.key === 'Enter' && matches[cursor]) {
      event.preventDefault();
      onGo(matches[cursor].path);
      onClose();
    }
  };

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialog}
        className="drawer help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header>
          <div>
            <span className="drawer-kicker">
              <Search size={14} /> Jump
            </span>
            <h3 id={titleId}>Go to a screen</h3>
          </div>
          <button
            className="icon-button"
            aria-label="Close without going anywhere"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="drawer-body">
          <label>
            Which screen?
            <input
              ref={field}
              value={query}
              placeholder="ledger, seat, spending…"
              aria-describedby={`${titleId}-count`}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p className="panel-note" id={`${titleId}-count`} role="status">
            {matches.length === 0
              ? 'No screen by that name. Clear the box to see all of them.'
              : `${matches.length} of ${DESTINATIONS.length} screens. Arrow keys move, Enter goes.`}
          </p>
          <nav aria-label="Screens">
            {matches.map((entry, index) => (
              <button
                key={entry.path}
                type="button"
                className={`nav-item ${index === cursor ? 'active' : ''}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => {
                  onGo(entry.path);
                  onClose();
                }}
              >
                <span>
                  {entry.label}
                  <small style={{ display: 'block' }}>{entry.hint}</small>
                </span>
                <ChevronRight size={15} style={{ marginLeft: 'auto' }} />
              </button>
            ))}
          </nav>
        </div>
      </section>
    </div>,
    document.body
  );
}
