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
    does: 'One question: what is the loop doing, and where is it stuck. The six cells across the top are the whole loop from finding someone to being paid by them, and exactly one of them is ever marked stuck. The sentence under them names that stage and the single action that clears it.',
    vocabulary: [
      { term: 'Stage', meaning: 'One of the six things that happen between a stranger and a paid invoice: Find, Reach, Answer, Deliver, Bill, Paid.' },
      { term: 'Stuck', meaning: 'The one stage that is holding up the others. Never more than one at a time — if two are stuck, the earlier one is the one you can do something about.' },
      { term: 'Not built yet', meaning: 'That stage has nothing behind it in this build. It is drawn so the loop is whole, and it will never show you a zero it cannot stand behind.' }
    ],
    more: <p>The loop and the vocabulary behind it are written down in <code>docs/gtm-shell-shape.md</code> and <code>docs/founder-skills.md</code>.</p>
  },
  outreach: {
    heading: 'Outreach',
    does: 'Run your LinkedIn accounts: build a lead list, build a workflow, start a campaign, and answer what comes back. What may go out today and why that number is on the account screen. Nothing sends from a Trevra server — what reaches LinkedIn goes through the worker driving a browser you signed into yourself, or through a file you download and run in your own tool.',
    vocabulary: [
      { term: 'HARD FACT', meaning: 'LinkedIn published the number, or refuses the action past it.' },
      { term: 'REPORTED', meaning: 'Practitioners measured it and LinkedIn has never confirmed it. Directionally right, never a guarantee.' },
      { term: 'Workflow', meaning: 'The steps a lead goes through — profile view, connection request, message, follow, a manual message you write yourself — with a wait between each one.' },
      { term: 'Campaign', meaning: 'One lead list running through one workflow on one LinkedIn account. Start it and it advances by itself; a lead can only be in one at a time.' },
      { term: 'Manual message', meaning: 'A step that stops and waits for you. It shows up in the inbox, and the lead moves on once you mark it done.' },
      { term: 'Warm-up', meaning: 'Two ramps, and the stricter one applies: a new account builds up over its first weeks, and a new campaign starts at 20% of your daily limits and reaches full on day five.' },
      { term: 'Daily limits', meaning: 'Your own ceilings per account — connection requests, messages, profile views, follows. Trevra also has its own safety ceiling; whichever is smaller is the one that applies.' },
      { term: 'Working hours', meaning: 'The days and hours this account is allowed to act. Nothing is scheduled or performed outside them, in that account’s own timezone.' },
      { term: 'Sending status', meaning: 'What an account is doing right now: ramping up, running, slowed down, or paused.' },
      { term: 'Safety check', meaning: 'Every action is re-checked against every limit immediately before it is performed. A queued message is not a sent one.' },
      { term: 'Branch', meaning: 'A step that waits on an earlier step’s outcome — accepted, replied, or neither. The default is “always”, which is what every unbranched sequence already is.' },
      { term: 'Lead sourcing', meaning: 'Reading profiles out of a search page, a post, or the posts and comments matching your keywords. A separate opt-in from sending, because it is scraping under LinkedIn’s User Agreement 8.2 and the exposure is not the same.' }
    ],
    more: <p>The pacing policy, and where each number came from, is in <code>docs/linkedin-outreach-plan.md</code>. The public write-up is at <a href="/how-it-works">How it works</a>.</p>
  },
  money: {
    heading: 'Money',
    does: 'What was agreed, delivered, billed and paid — and what wasn’t, and why. Trevra prepares each of these; you approve or reject. Nothing leaves your business on its own.',
    vocabulary: [
      { term: 'Prepared action', meaning: 'A draft Trevra wrote and is holding. It has not been sent and will not be until you approve it.' },
      { term: 'Exact-payload approval', meaning: 'Your approval is pinned to the exact wording you read. If one character changes afterwards, Trevra rejects it rather than sending it.' },
      { term: 'Proof pack', meaning: 'The agreement, the request and the delivery a suggestion was derived from. Open it before you decide.' }
    ],
    more: <p>The promise this screen keeps — no agent approves its own work — is section 11 of <code>docs/app-spec.md</code>, and the public version is at <a href="/security">Security</a>.</p>
  },
  ledger: {
    heading: 'Run ledger',
    does: 'Every run this workspace has performed, newest first, with the evidence — and a way to take it with you. A job Trevra ran and a run by Trevra’s own agent are the same thing here: work that happened.',
    vocabulary: [
      { term: 'Run', meaning: 'One piece of work from start to finish, with every step it took inside it.' },
      { term: 'Step', meaning: 'One thing inside a run: a model call, a tool call, a decision you were asked for.' },
      { term: 'Evidence', meaning: 'The source a step read to reach its conclusion, kept so the conclusion can be checked.' },
      { term: 'What you signed', meaning: 'The fingerprint of the exact wording your approval was bound to.' }
    ],
    more: <p>Every run is inspectable to the node; what that guarantees is section 10 of <code>docs/app-spec.md</code>.</p>
  },
  setup: {
    heading: 'Setup',
    does: 'What can reach your workspace, what it may spend, and what it may do. Visited rarely after the first week. Agent access comes first because nothing else in Trevra works until an agent can reach the workspace.',
    vocabulary: [
      { term: 'Agent token', meaning: 'The secret one line of terminal setup puts in your agent’s config. Shown once, stored hashed.' },
      { term: 'Your key', meaning: 'A model provider key Trevra holds encrypted so its own agent can work with your laptop closed. Optional, and never the safer default.' },
      { term: 'Side effect', meaning: 'What a skill can do: send or change something outside your business, read something from outside, or think only.' },
      { term: 'Skill', meaning: 'One typed thing your agent knows how to do. A playbook is several of them in a line, with your approval in the middle.' },
      { term: 'Hard limit', meaning: 'A rule your agent cannot break whatever else it is told to do.' }
    ],
    more: <>
      <p>Publishing a skill needs a signing key on your machine, so it lives in the terminal: <code>npm run module -- help</code>.</p>
      <p>Connecting an agent is one line, built for you on <strong>Setup → Agent access</strong>. The hosted-agent trade-off is written out in <code>docs/byok-and-hosted-agent.md</code>.</p>
    </>
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
            <span className="drawer-kicker"><CircleHelp size={14} /> Help</span>
            <h3 id={titleId}>{topic.heading}</h3>
          </div>
          <button className="icon-button" aria-label="Close help" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="drawer-body">
          <section className="run-section">
            <h5>What this screen does</h5>
            <p>{topic.does}</p>
          </section>
          <section className="run-section">
            <h5>The words on it</h5>
            <dl className="field-list">
              {topic.vocabulary.map((entry) => <div className="field-row" key={entry.term}>
                <dt>{entry.term}</dt>
                <dd>{entry.meaning}</dd>
              </div>)}
            </dl>
          </section>
          <section className="run-section">
            <h5>Where it is written down</h5>
            {topic.more}
            <p className="panel-note">Press <kbd>?</kbd> for every keyboard shortcut, or <kbd>Ctrl</kbd>+<kbd>K</kbd> to jump to another screen.</p>
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
  { keys: ['j'], does: 'Next item', where: 'The list on Loop and Money' },
  { keys: ['k'], does: 'Previous item', where: 'The list on Loop and Money' },
  { keys: ['Ctrl', 'Enter'], does: 'Open the last check before it goes out', where: 'The approval drawer' },
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
            <span className="drawer-kicker"><Keyboard size={14} /> Keyboard</span>
            <h3 id={titleId}>Every shortcut there is</h3>
          </div>
          <button className="icon-button" aria-label="Close the shortcut list" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="drawer-body">
          <p>On a Mac, <kbd>Ctrl</kbd> is <kbd>⌘</kbd>. Nothing here is bound to a bare letter while the caret is in a text field — in a field, a letter is a letter.</p>
          <dl className="field-list">
            {SHORTCUTS.map((entry) => <div className="field-row" key={entry.does}>
              <dt>{entry.keys.map((key, index) => <span key={key}>{index > 0 ? ' + ' : ''}<kbd>{key}</kbd></span>)}</dt>
              <dd>{entry.does} <small>— {entry.where}</small></dd>
            </div>)}
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
  { path: '/outreach', label: 'Outreach · LinkedIn accounts', hint: 'The accounts you send from, and what may go out today' },
  { path: '/outreach/accounts', label: 'Outreach · Target accounts', hint: 'Rank companies by the buying signals Trevra can prove' },
  { path: '/outreach/manager', label: 'Outreach · Campaigns', hint: 'Lead lists, workflows, and running campaigns' },
  { path: '/outreach/inbox', label: 'Outreach · Inbox', hint: 'Replies, and the messages waiting for you to write' },
  { path: '/outreach/leads', label: 'Outreach · Find people', hint: 'Turn a search, a post or keywords into a list of people' },
  { path: '/outreach/campaigns', label: 'Outreach · Approve & export', hint: 'Write a sequence, approve the wording, export it' },
  { path: '/outreach/plan', label: 'Outreach · Plan preview', hint: 'A dry run. Writes nothing' },
  { path: '/money', label: 'Money', hint: 'Agreed, delivered, billed, paid — and what wasn’t' },
  { path: '/ledger', label: 'Run ledger', hint: 'Every run, with the evidence' },
  { path: '/setup/agent', label: 'Setup · Agent access', hint: 'Connect Claude Code or Codex' },
  { path: '/setup/spend', label: 'Setup · The spending cap', hint: 'The monthly cap and the switch, inside Agent access' },
  { path: '/setup/data', label: 'Setup · Connections', hint: 'Where your data comes from' },
  { path: '/setup/seat', label: 'Setup · LinkedIn settings', hint: 'Detailed sign-in, worker and safety settings for the active account' },
  { path: '/setup/skills', label: 'Setup · Skills', hint: 'What your agent can do, and running one by hand' },
  { path: '/setup/limits', label: 'Setup · Limits', hint: 'Automation rules, hard limits, never-contact list' }
];

/**
 * Ctrl+K.
 *
 * A jumper rather than a command runner: everything it offers is a place, and
 * going to a place is the one thing that is safe to do without confirming it.
 * Nothing here acts.
 */
export function JumpPalette({ onGo, onClose }: { onGo: (path: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  useDialog(dialog, onClose);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return DESTINATIONS;
    return DESTINATIONS.filter((entry) =>
      entry.label.toLowerCase().includes(needle) || entry.hint.toLowerCase().includes(needle));
  }, [query]);

  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => { setCursor(0); }, [query]);

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
            <span className="drawer-kicker"><Search size={14} /> Jump</span>
            <h3 id={titleId}>Go to a screen</h3>
          </div>
          <button className="icon-button" aria-label="Close without going anywhere" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="drawer-body">
          <label>Which screen?<input
            ref={field}
            value={query}
            placeholder="ledger, seat, spending…"
            aria-describedby={`${titleId}-count`}
            onChange={(event) => setQuery(event.target.value)}
          /></label>
          <p className="panel-note" id={`${titleId}-count`} role="status">
            {matches.length === 0
              ? 'No screen by that name. Clear the box to see all of them.'
              : `${matches.length} of ${DESTINATIONS.length} screens. Arrow keys move, Enter goes.`}
          </p>
          <nav aria-label="Screens">
            {matches.map((entry, index) => <button
              key={entry.path}
              type="button"
              className={`nav-item ${index === cursor ? 'active' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => { onGo(entry.path); onClose(); }}
            >
              <span>{entry.label}<small style={{ display: 'block' }}>{entry.hint}</small></span>
              <ChevronRight size={15} style={{ marginLeft: 'auto' }} />
            </button>)}
          </nav>
        </div>
      </section>
    </div>,
    document.body
  );
}
