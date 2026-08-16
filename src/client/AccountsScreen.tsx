import { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileUp,
  LoaderCircle,
  RefreshCw,
  ThumbsDown
} from 'lucide-react';
import {
  getRankedAccounts,
  importAccounts,
  rescoreAccounts,
  sendAccountFeedback,
  type AccountImportResult,
  type AccountScore,
  type AccountSource,
  type RankedAccount
} from './api';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';

/**
 * `/outreach/accounts` -- the ranked target-company list, with its evidence attached.
 * `/leads` remains a compatibility alias and is replaced by the shell.
 *
 * THIS IS THE ONE SCREEN THAT HAS TO BE BELIEVED. Everything before it is
 * four questions, two of which have defaults (`docs/first-run.md`); this is
 * where the product finally says "these companies, in this order" -- and a
 * ranking an operator cannot audit is a ranking they will stop opening after
 * the second wrong name on it.
 *
 * So the rule this file is written under is narrow and absolute: NO NUMBER IS
 * SHOWN THAT THE DATA DID NOT PRODUCE, AND EVERY CLAIM SITS NEXT TO THE PAGE
 * IT WAS READ FROM. There is no arithmetic here, no rounding, no "about a
 * week ago" over a timestamp the scorer already turned into days, and no
 * sentence assembled from a template. `rationale.summary` is rendered
 * verbatim because the scorer wrote it against the signals it actually
 * weighed; a friendlier sentence written here would be this screen's own
 * opinion, wearing the scorer's authority.
 *
 * A MISSING SCORE IS A STATE, NOT A ZERO. An account imported a minute ago
 * has no score row, and the row says the sweep has not read it yet. Filling
 * that gap with a 0 and a 'cold' chip would be the product telling the
 * operator something about a company it has never looked at.
 *
 * THE EMPTY STATE IS THE IMPORT. There is no screen here with nothing on it
 * and no obvious next click: with no accounts, the whole page is one textarea
 * and one button, and the list appears under it the moment it has rows.
 *
 * WHAT IS DELIBERATELY NOT HERE: "Draft the opener". It is step 5 of the
 * build order and the wiring does not exist, so neither does the button. A
 * control that opens a toast saying "coming soon" is a worse answer than the
 * absence of the control.
 */

/** The tier as an operator would say it, not as the column spells it. */
const TIER_LABELS: Record<AccountScore['tier'], string> = {
  hot: 'Act now',
  warm: 'Worth watching',
  cold: 'Nothing has moved'
};

/**
 * The signal vocabulary in plain words.
 *
 * Descriptions of WHAT WAS READ, never of what it means: "Hiring went up" is
 * a fact about a careers page, "they're scaling" is a story about a company.
 * A kind with no label here renders its own name rather than being dropped --
 * an unknown signal must never silently vanish (accounts/types.ts).
 */
const KIND_LABELS: Record<string, string> = {
  'first-capture': 'First read of the site',
  'hiring-up': 'More roles on the careers page',
  'hiring-down': 'Fewer roles on the careers page',
  'pricing-changed': 'The pricing page changed',
  'headline-changed': 'The homepage pitch changed',
  'tech-added': 'A technology appeared on the site',
  'tech-removed': 'A technology went off the site',
  'thread-mention': 'Mentioned in a public thread'
};

const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/**
 * The two doors a PERSON can come through, and only those two.
 *
 * `sourced` and `linkedin` are provenance written by the sourcing pass and the
 * LinkedIn importer respectively. Offering them in a paste box would let this
 * screen file a false origin for a list somebody typed -- and 039 keeps the
 * first door forever, so it would be false a year later too.
 */
const SOURCE_OPTIONS: Array<{ value: AccountSource; label: string }> = [
  { value: 'csv', label: 'A list I already had' },
  { value: 'manual', label: 'Typed in by hand' }
];

/** `+4.5` / `-2`. Sign carried explicitly, because a bare number reads as a total. */
const signed = (points: number) => (points > 0 ? `+${points}` : String(points));

const ageCopy = (ageDays: number) => (ageDays === 0 ? 'today' : `${ageDays} day(s) old`);

/** `https://kestrel.dev` for a stored `kestrel.dev`. The domain IS the identity of the row. */
const siteUrl = (domain: string) => `https://${domain}`;

export function AccountsScreen({ setToast }: { setToast: (message: string) => void }) {
  const [accounts, setAccounts] = useState<RankedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [text, setText] = useState('');
  const [source, setSource] = useState<AccountSource>('csv');
  const [importing, setImporting] = useState(false);
  /** The last import, kept on screen until the next one replaces it. */
  const [result, setResult] = useState<AccountImportResult | null>(null);

  /** The row whose reasoning is open. One at a time; the panel is long. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rescoring, setRescoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAccounts(await getRankedAccounts({ limit: 200 }));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the account list. Nothing was changed — try again.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runImport = async () => {
    if (!text.trim()) { setError('Paste at least one domain, one per line.'); return; }
    setImporting(true);
    setError('');
    try {
      const imported = await importAccounts({ text, source });
      setResult(imported);
      // The paste is cleared only when something came of it. A list that was
      // entirely rejected is the operator's data and their next edit.
      if (imported.created > 0) setText('');
      setToast(imported.created > 0
        ? `${imported.created} account(s) added. They are in the sweep; scores arrive as their sites are read.`
        : 'Nothing new was written — every usable line was already here.');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to import that list'));
    } finally { setImporting(false); }
  };

  /**
   * A dropped file is read HERE and lands in the textarea, unparsed.
   *
   * The operator sees the exact text that is about to be sent, which is the
   * same contract the paste has -- a file that silently became 500 rows the
   * moment it touched the page would be the one import nobody could check.
   */
  const onDrop = async (event: React.DragEvent<HTMLTextAreaElement>) => {
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    event.preventDefault();
    try {
      setText(await file.text());
      setSource('csv');
    } catch {
      setError('That file could not be read here. Open it and paste its contents instead.');
    }
  };

  const markNotAFit = async (row: RankedAccount) => {
    setBusyId(row.account.id);
    try {
      const updated = await sendAccountFeedback(row.account.id, { verdict: 'not_a_fit' });
      setAccounts((current) => current.map((entry) => entry.account.id === row.account.id ? updated : entry));
      setToast(`${row.account.name} is out of the sweep, and what its signals looked like was kept. It is not deleted — the next import would only bring it back.`);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to record that verdict'));
    } finally { setBusyId(null); }
  };

  const runRescore = async () => {
    setRescoring(true);
    try {
      const { rescored } = await rescoreAccounts();
      setToast(`${rescored} account(s) scored again against the signals as they stand now.`);
      await load();
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to score the accounts again'));
    } finally { setRescoring(false); }
  };

  return <div className="page-stack">
    {error && <div className="error-banner">{error}</div>}

    {accounts.length > 0 && <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>{accounts.length} account(s), hottest first</h3>
          <p>
            The order is the scorer’s, computed over the signals below it. Every line in “why this score” links to the
            page it was read from — nothing here is asserted without one.
          </p>
        </div>
        <div className="acc-heading-actions">
          <button className="secondary-button" type="button" disabled={rescoring} onClick={() => void runRescore()}>
            {rescoring ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Score again
          </button>
          <button className="ghost-button" type="button" disabled={loading} onClick={() => void load()}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      <div className="acc-list">
        {accounts.map((row) => <AccountRow
          key={row.account.id}
          row={row}
          open={openId === row.account.id}
          busy={busyId === row.account.id}
          onToggle={() => setOpenId(openId === row.account.id ? null : row.account.id)}
          onNotAFit={() => void markNotAFit(row)}
        />)}
      </div>
    </section>}

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>{accounts.length > 0 ? 'Add more accounts' : 'Start with the list you already have'}</h3>
          <p>
            {accounts.length > 0
              ? 'Same list, same rules: one domain per line, and a domain already here is left alone rather than duplicated.'
              : 'One domain per line. Nothing is fetched by this screen — the sweep reads each site on the worker’s own tick, at paced gaps, and the scores appear here as they land.'}
          </p>
        </div>
        <FileUp size={20} className="li-heading-icon" />
      </div>

      <label className="li-block-label acc-paste">
        Paste domains, one per line — or drop a CSV
        <textarea
          rows={7}
          value={text}
          disabled={importing}
          onChange={(event) => setText(event.target.value)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => void onDrop(event)}
          placeholder={'kestrel.dev\nacme.io\nhttps://www.northwind.co.uk/pricing'}
        />
      </label>
      <p className="li-hint">
        A URL is fine — the scheme, the <code>www</code> and the path are dropped, and what is kept is the domain, which
        is what makes two spellings of the same company one account instead of two that each score half.
      </p>

      <div className="li-form-grid acc-import-grid">
        <label>Where this list came from
          <select value={source} disabled={importing} onChange={(event) => setSource(event.target.value as AccountSource)}>
            {SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <small className="li-hint">Kept with the row for good. Provenance survives a merge: the first door wins.</small>
        </label>
      </div>

      <div className="panel-footer">
        <span>Importing writes rows and contacts nobody.</span>
        <button className="primary-button" type="button" disabled={importing || !text.trim()} onClick={() => void runImport()}>
          {importing ? <LoaderCircle className="spin" size={15} /> : <Building2 size={15} />} Import this list
        </button>
      </div>

      {result && <ImportReport result={result} />}

      {accounts.length === 0 && !loading && !result && <div className="empty-state">
        <Building2 size={26} />
        <h4 aria-level={3}>No accounts yet</h4>
        <p>The ranked list appears here as soon as this workspace has companies in it.</p>
      </div>}
    </section>
  </div>;
}

/**
 * What an import did, counted three ways.
 *
 * THE REJECTED LINES ARE SHOWN WITH THEIR REASON. A parser that quietly drops
 * what it could not read is how a list of 500 becomes a list of 480 and
 * nobody finds out until the twentieth company never gets a message.
 */
function ImportReport({ result }: { result: AccountImportResult }) {
  return <div className="acc-import-report">
    <p className="acc-import-counts">
      <strong>{result.created}</strong> written · <strong>{result.duplicate}</strong> already here ·{' '}
      <strong>{result.rejected.length}</strong> not usable
    </p>
    {result.rejected.length > 0 && <>
      <p className="li-hint">These lines produced no domain, so nothing was written for them:</p>
      <ul className="acc-rejected">
        {result.rejected.map((entry, index) => <li key={`${entry.line}-${index}`}>
          <code>{entry.line}</code>
          <span>{entry.reason}</span>
        </li>)}
      </ul>
    </>}
  </div>;
}

/** One account, as a sentence: who they are, how hot, and the scorer’s own line about why. */
function AccountRow({ row, open, busy, onToggle, onNotAFit }: {
  row: RankedAccount;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onNotAFit: () => void;
}) {
  const { account, score, signals } = row;
  const rejected = account.status === 'not_a_fit';
  // The expansion is the evidence, and there are two kinds of it: a score's
  // reasoning, or -- before the scorer has run -- the raw signals the sweep
  // has stored so far. With neither, there is nothing to expand into.
  const expandable = Boolean(score) || signals.length > 0;

  return <article className={`acc-row${rejected ? ' is-rejected' : ''}`}>
    <div className="acc-row-head">
      <h4 aria-level={3}>{account.name}</h4>
      {score && <span className={`li-chip acc-tier-${score.tier}`}>{TIER_LABELS[score.tier]}</span>}
      {score && <span className="acc-score">score {score.score}</span>}
      {rejected && <span className="li-chip acc-tier-rejected">Not a fit</span>}
    </div>

    <p className="acc-sentence">
      {score
        ? score.rationale.summary
        : signals.length > 0
          ? `The sweep has stored ${signals.length} signal(s) for this account and has not scored it yet.`
          : 'The sweep has not read this account yet, so there is no score and nothing to explain.'}
    </p>

    <div className="acc-row-actions">
      {expandable && <button className="ghost-button" type="button" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {score ? 'Why this score' : 'What has been read'}
      </button>}
      <a className="li-link acc-site" href={siteUrl(account.domain)} target="_blank" rel="noreferrer">
        {account.domain} <ExternalLink size={11} />
      </a>
      {account.linkedinUrl && <a className="li-link" href={account.linkedinUrl} target="_blank" rel="noreferrer">
        LinkedIn <ExternalLink size={11} />
      </a>}
      <button className="ghost-button acc-reject" type="button" disabled={busy || rejected} onClick={onNotAFit}>
        {busy ? <LoaderCircle className="spin" size={14} /> : <ThumbsDown size={14} />} Not a fit
      </button>
    </div>

    {open && (score ? <ScorePanel score={score} /> : <SignalPanel row={row} />)}
  </article>;
}

/**
 * The arithmetic, line by line, with a link on every line.
 *
 * THIS PANEL IS THE PRODUCT'S CREDIBILITY, so it is laid out as reading
 * matter rather than dumped as the JSON it arrived in: one row per signal,
 * the signal's own sentence, how old it was when it was weighed, what it was
 * worth, and the page it was read from. The arithmetic is shown as the scorer
 * did it -- weight, decay, points -- because "87" with no working is the same
 * unfalsifiable number every other tool in this category ships.
 */
function ScorePanel({ score }: { score: AccountScore }) {
  const { rationale } = score;
  return <div className="acc-why">
    <p className="acc-why-window">
      Scored over {rationale.windowDays} day(s). {score.distinctKinds} distinct signal kind(s) landed inside that
      window{score.newestSignalAt ? `, the newest of them ${relativeTime(score.newestSignalAt)}` : ''}. Computed{' '}
      {relativeTime(score.computedAt)}.
    </p>

    {rationale.components.length === 0
      ? <p className="empty-copy">No signal inside the window carried any weight.</p>
      : <ul className="acc-components">
        {rationale.components.map((component, index) => <li key={`${component.kind}-${component.observedAt}-${index}`}>
          <div className="acc-component-head">
            <span className="li-chip">{kindLabel(component.kind)}</span>
            <span className="acc-points">{signed(component.points)}</span>
          </div>
          <p className="acc-component-detail">{component.detail}</p>
          <p className="acc-component-meta">
            {ageCopy(component.ageDays)} · weight {component.base} × recency {component.decay} ={' '}
            {component.points}
          </p>
          <a className="li-link acc-evidence" href={component.evidenceUrl} target="_blank" rel="noreferrer">
            Read what this came from <ExternalLink size={11} />
          </a>
        </li>)}
      </ul>}

    {rationale.combinations.length > 0 && <div className="acc-why-block">
      <h5 aria-level={4}>Because they happened together</h5>
      <ul className="acc-combinations">
        {rationale.combinations.map((combination, index) => <li key={`${combination.kinds.join('+')}-${index}`}>
          <span className="acc-points">{signed(combination.bonus)}</span>
          <span>{combination.why}</span>
        </li>)}
      </ul>
    </div>}

    {rationale.penalties.length > 0 && <div className="acc-why-block">
      <h5 aria-level={4}>Taken off</h5>
      <ul className="acc-penalties">
        {rationale.penalties.map((penalty, index) => <li key={`${penalty.reason}-${index}`}>
          <span className="acc-points">{penalty.points}</span>
          <span>{penalty.reason}</span>
        </li>)}
      </ul>
    </div>}
  </div>;
}

/**
 * What has been read, before there is a score to explain.
 *
 * The same evidence, without any arithmetic over it -- because there is none
 * yet, and inventing a provisional number here would be the one thing this
 * screen promises not to do.
 */
function SignalPanel({ row }: { row: RankedAccount }) {
  return <div className="acc-why">
    <p className="acc-why-window">
      No score has been computed for this account yet. These are the signals the sweep has stored, newest first.
    </p>
    <ul className="acc-components">
      {row.signals.map((signal) => <li key={signal.id}>
        <div className="acc-component-head">
          <span className="li-chip">{kindLabel(signal.kind)}</span>
        </div>
        <p className="acc-component-detail">{signal.detail}</p>
        <p className="acc-component-meta">Observed {relativeTime(signal.observedAt)}</p>
        <a className="li-link acc-evidence" href={signal.evidenceUrl} target="_blank" rel="noreferrer">
          Read what this came from <ExternalLink size={11} />
        </a>
      </li>)}
    </ul>
  </div>;
}
