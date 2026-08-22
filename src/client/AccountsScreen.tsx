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
  getAccountSourceProviders,
  getRankedAccounts,
  importAccounts,
  rescoreAccounts,
  sendAccountFeedback,
  sourceAccounts,
  type AccountImportResult,
  type AccountScore,
  type AccountSource,
  type AccountSourceProvider,
  type AccountSourceRunResult,
  type RankedAccount
} from './api';
import './account-import-workbench.css';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { Select } from './ui/primitives';
import {
  collectPreparedPeople,
  prepareAccountFiles,
  reviewPreparedRows,
  serializePreparedAccountRows,
  type PreparedAccountFiles,
  type PreparedAccountRow
} from './account-file-import';

/**
 * A fold on `/outreach` ("Target accounts") -- the ranked target-company list,
 * with its evidence attached. `/outreach/accounts` and `/leads` both redirect
 * here and open the fold.
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
  const [fileSummary, setFileSummary] = useState('');
  const [preparedFiles, setPreparedFiles] = useState<PreparedAccountFiles | null>(null);
  const [sourceProviders, setSourceProviders] = useState<AccountSourceProvider[]>([]);
  const [sourceProvider, setSourceProvider] = useState('directory');
  const [sourceKeywords, setSourceKeywords] = useState('');
  const [sourceUrls, setSourceUrls] = useState('');
  const [sourcing, setSourcing] = useState(false);
  const [sourceRun, setSourceRun] = useState<AccountSourceRunResult | null>(null);

  /** The row whose reasoning is open. One at a time; the panel is long. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rescoring, setRescoring] = useState(false);
  // "Add more accounts" stays collapsed by default once there is already a
  // ranked list -- opened by the operator, or automatically by a just-run
  // import so its own result report (rejected lines and all) does not
  // vanish behind the toggle the moment the first import promotes this
  // screen out of its empty state.
  const [showAddMore, setShowAddMore] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAccounts(await getRankedAccounts({ limit: 200 }));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to load accounts. Try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void getAccountSourceProviders()
      .then((providers) => {
        const discoveryProviders = providers.filter((provider) => provider.key !== 'seed');
        setSourceProviders(discoveryProviders);
        const preferred =
          discoveryProviders.find(
            (provider) => provider.key === 'directory' && provider.availability.mode === 'ready'
          ) ??
          discoveryProviders.find(
            (provider) => provider.retention === 'default' && provider.availability.mode === 'ready'
          );
        if (preferred) setSourceProvider(preferred.key);
      })
      .catch(() => undefined);
  }, []);

  const runImport = async () => {
    const importText = preparedFiles?.rows.length
      ? serializePreparedAccountRows(preparedFiles.rows)
      : text;
    if (
      !importText.trim() ||
      (preparedFiles?.rows.length && !preparedFiles.rows.some((row) => row.included))
    ) {
      setError('Include at least one valid account before importing.');
      return;
    }
    setImporting(true);
    setError('');
    try {
      const imported = await importAccounts({
        text: importText,
        source,
        ...(preparedFiles?.rows.length ? { people: collectPreparedPeople(preparedFiles.rows) } : {})
      });
      setResult(imported);
      setShowAddMore(true);
      // The paste is cleared only when something came of it. A list that was
      // entirely rejected is the operator's data and their next edit.
      if (
        imported.created > 0 ||
        (imported.people?.created ?? 0) > 0 ||
        (imported.people?.matched ?? 0) > 0
      ) {
        setText('');
        setFileSummary('');
        setPreparedFiles(null);
      }
      setToast(
        imported.created > 0 || (imported.people?.created ?? 0) > 0
          ? `${imported.created} account(s), ${imported.people?.created ?? 0} person(s) added.`
          : 'All usable accounts and people were already imported.'
      );
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to import that list'));
    } finally {
      setImporting(false);
    }
  };

  /**
   * Files are prepared in the browser before the account-import request.
   *
   * A single file stays transparent in the textarea. A folder is reduced to
   * compact company manifests locally, so product/catalog artifacts never leave
   * the browser just because they live beside `domain_summary.json`.
   */
  const readImportFiles = async (files: readonly File[], mode: 'file' | 'folder') => {
    try {
      const prepared = await prepareAccountFiles(files, mode);
      setText(prepared.text);
      setFileSummary(prepared.summary);
      setPreparedFiles(prepared.rows.length > 0 ? prepared : null);
      setSource('csv');
      setError('');
    } catch (err) {
      setFileSummary('');
      setPreparedFiles(null);
      setError(errorMessage(err, 'Could not read that upload.'));
    }
  };

  const onDrop = async (event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    await readImportFiles(files, files.length === 1 ? 'file' : 'folder');
  };

  const runSource = async () => {
    const provider = sourceProviders.find((item) => item.key === sourceProvider);
    if (!provider) {
      setError('Choose an available source provider.');
      return;
    }
    if (provider.availability.mode !== 'ready') {
      setError(provider.availability.reason);
      return;
    }
    if (provider.retention === 'none') {
      setError(
        `${provider.name} results cannot be persisted into Trevra under this provider's retention rule.`
      );
      return;
    }
    const urls = sourceUrls
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const keywords = sourceKeywords
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (provider.key === 'directory' && urls.length === 0) {
      setError('Add at least one public directory URL.');
      return;
    }
    setSourcing(true);
    setError('');
    try {
      const sourced = await sourceAccounts({ provider: provider.key, urls, keywords, limit: 100 });
      setSourceRun(sourced);
      setToast(
        sourced.import.created > 0
          ? `${sourced.import.created} sourced account(s) added.`
          : `${sourced.found} candidate(s) found; all usable accounts were already present.`
      );
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to source accounts'));
    } finally {
      setSourcing(false);
    }
  };

  const markNotAFit = async (row: RankedAccount) => {
    setBusyId(row.account.id);
    try {
      const updated = await sendAccountFeedback(row.account.id, { verdict: 'not_a_fit' });
      setAccounts((current) =>
        current.map((entry) => (entry.account.id === row.account.id ? updated : entry))
      );
      setToast(`${row.account.name} marked as not a fit.`);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to record that verdict'));
    } finally {
      setBusyId(null);
    }
  };

  const runRescore = async () => {
    setRescoring(true);
    try {
      const { rescored } = await rescoreAccounts();
      setToast(`${rescored} account(s) rescored.`);
      await load();
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to score the accounts again'));
    } finally {
      setRescoring(false);
    }
  };

  return (
    <div className="page-stack">
      {error && <div className="error-banner">{error}</div>}

      {accounts.length > 0 && (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>{accounts.length} account(s), highest score first</h3>
              <p>Scores use the signals shown under each account. Evidence links to the source.</p>
            </div>
            <div className="acc-heading-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={rescoring}
                onClick={() => void runRescore()}
              >
                {rescoring ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{' '}
                Score again
              </button>
              <button
                className="ghost-button"
                type="button"
                disabled={loading}
                onClick={() => void load()}
              >
                {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{' '}
                Refresh
              </button>
            </div>
          </div>

          <div className="acc-list">
            {accounts.map((row) => (
              <AccountRow
                key={row.account.id}
                row={row}
                open={openId === row.account.id}
                busy={busyId === row.account.id}
                onToggle={() => setOpenId(openId === row.account.id ? null : row.account.id)}
                onNotAFit={() => void markNotAFit(row)}
              />
            ))}
          </div>
        </section>
      )}

      {accounts.length > 0 ? (
        <details
          className="mgr-inputs"
          open={showAddMore}
          onToggle={(event) => setShowAddMore(event.currentTarget.open)}
        >
          <summary>Add more accounts</summary>
          <div className="mgr-inputs-body">
            <div className="page-panel">
              <AddAccountsForm
                text={text}
                setText={(value) => {
                  setText(value);
                  setFileSummary('');
                  setPreparedFiles(null);
                }}
                importing={importing}
                source={source}
                setSource={setSource}
                onDrop={onDrop}
                onFiles={(files, mode) => void readImportFiles(files, mode)}
                fileSummary={fileSummary}
                preparedFiles={preparedFiles}
                onPreparedChange={(prepared) => {
                  setPreparedFiles(prepared);
                  setText(serializePreparedAccountRows(prepared.rows));
                }}
                runImport={runImport}
                heading="Add more accounts"
                subheading="Paste a list, choose a file, or choose a folder. Existing accounts are skipped."
              />
              {result && <ImportReport result={result} />}
            </div>
          </div>
        </details>
      ) : (
        <section className="page-panel">
          <AddAccountsForm
            text={text}
            setText={(value) => {
              setText(value);
              setFileSummary('');
              setPreparedFiles(null);
            }}
            importing={importing}
            source={source}
            setSource={setSource}
            onDrop={onDrop}
            onFiles={(files, mode) => void readImportFiles(files, mode)}
            fileSummary={fileSummary}
            preparedFiles={preparedFiles}
            onPreparedChange={(prepared) => {
              setPreparedFiles(prepared);
              setText(serializePreparedAccountRows(prepared.rows));
            }}
            runImport={runImport}
            heading="Start with the list you already have"
            subheading="Paste a list, choose a file, or choose a folder. Accounts are scored after their sites are read."
          />
          {result && <ImportReport result={result} />}
          {!loading && !result && (
            <div className="empty-state">
              <Building2 size={26} />
              <h4 aria-level={3}>No accounts yet</h4>
              <p>Imported or sourced accounts will appear here.</p>
            </div>
          )}
        </section>
      )}

      {sourceProviders.length > 0 && (
        <details className="mgr-inputs acc-source-panel">
          <summary>Find accounts from a source</summary>
          <div className="mgr-inputs-body">
            <section className="page-panel">
              <SourceAccountsForm
                providers={sourceProviders}
                providerKey={sourceProvider}
                setProviderKey={setSourceProvider}
                keywords={sourceKeywords}
                setKeywords={setSourceKeywords}
                urls={sourceUrls}
                setUrls={setSourceUrls}
                sourcing={sourcing}
                runSource={runSource}
                result={sourceRun}
              />
            </section>
          </div>
        </details>
      )}
    </div>
  );
}

function AddAccountsForm({
  text,
  setText,
  importing,
  source,
  setSource,
  onDrop,
  onFiles,
  fileSummary,
  preparedFiles,
  onPreparedChange,
  runImport,
  heading,
  subheading
}: {
  text: string;
  setText: (value: string) => void;
  importing: boolean;
  source: AccountSource;
  setSource: (value: AccountSource) => void;
  onDrop: (event: React.DragEvent<HTMLTextAreaElement>) => void;
  onFiles: (files: File[], mode: 'file' | 'folder') => void;
  fileSummary: string;
  preparedFiles: PreparedAccountFiles | null;
  onPreparedChange: (prepared: PreparedAccountFiles) => void;
  runImport: () => void;
  heading: string;
  subheading: string;
}) {
  const hasWorkbench = Boolean(preparedFiles?.rows.length);
  const included = preparedFiles?.rows.filter((row) => row.included).length ?? 0;
  return (
    <>
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>{heading}</h3>
          <p>{subheading}</p>
        </div>
        <FileUp size={20} className="li-heading-icon" />
      </div>

      {!hasWorkbench && (
        <label className="li-block-label acc-paste">
          Paste domains, CSV, or JSON — or drop a file
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
      )}

      <div className="acc-file-row">
        <label className="secondary-button acc-file-button">
          <FileUp size={14} /> Choose file
          <input
            type="file"
            accept=".csv,.json,.txt,text/csv,application/json,text/plain"
            disabled={importing}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              if (files.length > 0) onFiles(files, 'file');
              event.currentTarget.value = '';
            }}
          />
        </label>
        <label className="secondary-button acc-file-button">
          <FileUp size={14} /> Choose folder
          <input
            type="file"
            multiple
            disabled={importing}
            ref={(node) => {
              if (node) {
                node.setAttribute('webkitdirectory', '');
                node.setAttribute('directory', '');
              }
            }}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              if (files.length > 0) onFiles(files, 'folder');
              event.currentTarget.value = '';
            }}
          />
        </label>
        <span className="li-hint">
          File: CSV, JSON, TXT · Folder: company manifests are reviewed locally before import
        </span>
      </div>

      {preparedFiles?.rows.length ? (
        <ImportWorkbench
          prepared={preparedFiles}
          disabled={importing}
          onChange={onPreparedChange}
        />
      ) : (
        <>
          {fileSummary && <p className="li-hint acc-file-summary">{fileSummary}</p>}
          <p className="li-hint">
            URLs are normalized to the domain. Existing accounts are skipped.
          </p>
        </>
      )}

      <div className="li-form-grid acc-import-grid">
        <label>
          Where this list came from
          <Select
            value={source}
            disabled={importing}
            onChange={(event) => setSource(event.target.value as AccountSource)}
          >
            {SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <small className="li-hint">Saved with the account.</small>
        </label>
      </div>

      <div className="panel-footer">
        <span>
          {hasWorkbench
            ? `${included} reviewed account(s) will be imported. Nothing is contacted.`
            : !text.trim()
              ? 'Paste at least one domain to enable import.'
              : 'Import adds accounts. It does not contact anyone.'}
        </span>
        <button
          className="primary-button"
          type="button"
          disabled={importing || (hasWorkbench ? included === 0 : !text.trim())}
          onClick={() => void runImport()}
        >
          {importing ? <LoaderCircle className="spin" size={15} /> : <Building2 size={15} />} Import{' '}
          {hasWorkbench ? `${included} reviewed` : 'this list'}
        </button>
      </div>
    </>
  );
}

function ImportWorkbench({
  prepared,
  disabled,
  onChange
}: {
  prepared: PreparedAccountFiles;
  disabled: boolean;
  onChange: (prepared: PreparedAccountFiles) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'issues' | 'excluded'>('all');
  const rows = prepared.rows;
  const issueCount = rows.filter((row) => row.issues.length > 0).length;
  const excludedCount = rows.filter((row) => !row.included).length;
  const includedCount = rows.length - excludedCount;
  const contactRows = rows.filter(
    (row) =>
      row.contactEvidence.names.length +
        row.contactEvidence.emails.length +
        row.contactEvidence.phones.length >
      0
  ).length;
  const visibleRows = rows.filter((row) => {
    if (filter === 'issues') return row.issues.length > 0;
    if (filter === 'excluded') return !row.included;
    return true;
  });

  const commitRows = (nextRows: PreparedAccountRow[]) => {
    const reviewed = reviewPreparedRows(nextRows);
    onChange({
      ...prepared,
      rows: reviewed,
      accountCount: reviewed.filter((row) => row.included).length,
      text: serializePreparedAccountRows(reviewed)
    });
  };

  const editRow = (
    row: PreparedAccountRow,
    field: 'domain' | 'name' | 'platform' | 'linkedinUrl' | 'tags',
    value: string
  ) => {
    const nextRows = rows.map((current) => {
      if (current.id !== row.id) return current;
      const editedFields = current.editedFields.includes(field)
        ? current.editedFields
        : [...current.editedFields, field];
      const patch =
        field === 'tags'
          ? {
              tags: value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean)
            }
          : { [field]: value };
      return {
        ...current,
        ...patch,
        editedFields,
        ...(field === 'domain' && current.issues.length > 0 ? { included: true } : {})
      } as PreparedAccountRow;
    });
    commitRows(nextRows);
  };

  const resetRow = (row: PreparedAccountRow) => {
    commitRows(
      rows.map((current) =>
        current.id === row.id
          ? {
              ...current,
              ...current.original,
              tags: [...current.original.tags],
              included: true,
              editedFields: []
            }
          : current
      )
    );
  };

  const setVisibleIncluded = (included: boolean) => {
    const visible = new Set(visibleRows.map((row) => row.id));
    commitRows(rows.map((row) => (visible.has(row.id) ? { ...row, included } : row)));
  };

  return (
    <section className="acc-import-workbench" aria-label="Import review">
      <div className="acc-import-workbench-head">
        <div>
          <h4>Review import</h4>
          <p className="li-hint">{prepared.summary}</p>
        </div>
        <div className="acc-import-stats" aria-label="Import counts">
          <span>
            <strong>{includedCount}</strong> included
          </span>
          <span>
            <strong>{issueCount}</strong> need review
          </span>
          <span>
            <strong>{excludedCount}</strong> excluded
          </span>
        </div>
      </div>

      {contactRows > 0 && (
        <div className="acc-import-notice">
          <strong>Contact evidence detected in {contactRows} row(s).</strong> Names, emails, and
          phones are shown with their source, but this account import does not write contacts yet.
        </div>
      )}

      <div className="acc-import-toolbar">
        <div className="acc-import-filters" role="group" aria-label="Review filter">
          <button
            type="button"
            className={filter === 'all' ? 'is-active' : ''}
            onClick={() => setFilter('all')}
          >
            All {rows.length}
          </button>
          <button
            type="button"
            className={filter === 'issues' ? 'is-active' : ''}
            onClick={() => setFilter('issues')}
          >
            Needs review {issueCount}
          </button>
          <button
            type="button"
            className={filter === 'excluded' ? 'is-active' : ''}
            onClick={() => setFilter('excluded')}
          >
            Excluded {excludedCount}
          </button>
        </div>
        <div className="acc-import-bulk">
          <button
            type="button"
            className="ghost-button"
            disabled={disabled || visibleRows.length === 0}
            onClick={() => setVisibleIncluded(true)}
          >
            Include shown
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={disabled || visibleRows.length === 0}
            onClick={() => setVisibleIncluded(false)}
          >
            Exclude shown
          </button>
        </div>
      </div>

      <div className="acc-import-table" role="table" aria-label="Detected accounts">
        <div className="acc-import-table-head" role="row">
          <span>Use</span>
          <span>Domain</span>
          <span>Name</span>
          <span>Platform / tags</span>
          <span>Evidence</span>
        </div>
        {visibleRows.map((row) => {
          const contactBits = [
            row.contactEvidence.names.length ? `${row.contactEvidence.names.length} name(s)` : '',
            row.contactEvidence.emails.length
              ? `${row.contactEvidence.emails.length} email(s)`
              : '',
            row.contactEvidence.phones.length ? `${row.contactEvidence.phones.length} phone(s)` : ''
          ].filter(Boolean);
          return (
            <div
              className={`acc-import-review-row${row.issues.length ? ' has-issue' : ''}`}
              role="row"
              key={row.id}
            >
              <label className="acc-import-check">
                <input
                  type="checkbox"
                  checked={row.included}
                  disabled={disabled}
                  onChange={(event) =>
                    commitRows(
                      rows.map((current) =>
                        current.id === row.id
                          ? { ...current, included: event.target.checked }
                          : current
                      )
                    )
                  }
                />
                <span>{row.included ? 'Include' : 'Skip'}</span>
              </label>
              <label>
                <span className="acc-import-field-meta">
                  Domain ·{' '}
                  {row.editedFields.includes('domain')
                    ? `Edited · was ${row.original.domain}`
                    : `Exact: ${row.sourceFields.domain}`}
                </span>
                <input
                  value={row.domain}
                  disabled={disabled}
                  onChange={(event) => editRow(row, 'domain', event.target.value)}
                />
                {row.issues.map((issue) => (
                  <small className="acc-import-issue" key={issue}>
                    {issue}
                  </small>
                ))}
              </label>
              <label>
                <span className="acc-import-field-meta">
                  Name ·{' '}
                  {row.editedFields.includes('name')
                    ? `Edited · was ${row.original.name || 'empty'}`
                    : row.sourceFields.name
                      ? `Exact: ${row.sourceFields.name}`
                      : 'Optional'}
                </span>
                <input
                  value={row.name}
                  disabled={disabled}
                  placeholder="Optional"
                  onChange={(event) => editRow(row, 'name', event.target.value)}
                />
              </label>
              <div className="acc-import-stack-fields">
                <label>
                  <span className="acc-import-field-meta">
                    Platform ·{' '}
                    {row.editedFields.includes('platform')
                      ? `Edited · was ${row.original.platform || 'empty'}`
                      : row.sourceFields.platform
                        ? `Exact: ${row.sourceFields.platform}`
                        : 'Optional'}
                  </span>
                  <input
                    value={row.platform}
                    disabled={disabled}
                    placeholder="Optional"
                    onChange={(event) => editRow(row, 'platform', event.target.value)}
                  />
                </label>
                <label>
                  <span className="acc-import-field-meta">
                    Tags ·{' '}
                    {row.editedFields.includes('tags')
                      ? `Edited · was ${row.original.tags.join(', ') || 'empty'}`
                      : row.sourceFields.tags
                        ? `Exact: ${row.sourceFields.tags}`
                        : 'Optional'}
                  </span>
                  <input
                    value={row.tags.join(', ')}
                    disabled={disabled}
                    placeholder="comma, separated"
                    onChange={(event) => editRow(row, 'tags', event.target.value)}
                  />
                </label>
              </div>
              <div className="acc-import-evidence">
                <code title={row.sourcePath}>{row.sourcePath}</code>
                {(row.linkedinUrl || row.sourceFields.linkedinUrl) && (
                  <label>
                    <span className="acc-import-field-meta">
                      LinkedIn ·{' '}
                      {row.editedFields.includes('linkedinUrl')
                        ? `Edited · was ${row.original.linkedinUrl || 'empty'}`
                        : `Exact: ${row.sourceFields.linkedinUrl}`}
                    </span>
                    <input
                      value={row.linkedinUrl}
                      disabled={disabled}
                      onChange={(event) => editRow(row, 'linkedinUrl', event.target.value)}
                    />
                  </label>
                )}
                {contactBits.length > 0 && (
                  <details>
                    <summary>{contactBits.join(' · ')}</summary>
                    {row.contactEvidence.names.length > 0 && (
                      <p>
                        <strong>Names:</strong> {row.contactEvidence.names.join(', ')}
                      </p>
                    )}
                    {row.contactEvidence.emails.length > 0 && (
                      <p>
                        <strong>Emails:</strong> {row.contactEvidence.emails.join(', ')}
                      </p>
                    )}
                    {row.contactEvidence.phones.length > 0 && (
                      <p>
                        <strong>Phones:</strong> {row.contactEvidence.phones.join(', ')}
                      </p>
                    )}
                  </details>
                )}
                {row.editedFields.length > 0 && (
                  <button
                    type="button"
                    className="li-link"
                    disabled={disabled}
                    onClick={() => resetRow(row)}
                  >
                    Reset row
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <details className="acc-import-raw">
        <summary>View exact import payload</summary>
        <textarea readOnly rows={10} value={serializePreparedAccountRows(rows)} />
      </details>
    </section>
  );
}

function SourceAccountsForm({
  providers,
  providerKey,
  setProviderKey,
  keywords,
  setKeywords,
  urls,
  setUrls,
  sourcing,
  runSource,
  result
}: {
  providers: AccountSourceProvider[];
  providerKey: string;
  setProviderKey: (value: string) => void;
  keywords: string;
  setKeywords: (value: string) => void;
  urls: string;
  setUrls: (value: string) => void;
  sourcing: boolean;
  runSource: () => void;
  result: AccountSourceRunResult | null;
}) {
  const selected = providers.find((provider) => provider.key === providerKey) ?? providers[0];
  const canPersist = Boolean(
    selected && selected.availability.mode === 'ready' && selected.retention === 'default'
  );
  return (
    <>
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Source candidate companies</h3>
          <p>
            Every provider returns the same company shape. Nothing downstream knows which source
            found it.
          </p>
        </div>
      </div>

      <div className="li-form-grid acc-source-grid">
        <label>
          Provider
          <Select
            value={providerKey}
            disabled={sourcing}
            onChange={(event) => setProviderKey(event.target.value)}
          >
            {providers.map((provider) => (
              <option key={provider.key} value={provider.key}>
                {provider.name}
                {provider.retention === 'none' ? ' · memory only' : ''}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Keywords
          <input
            value={keywords}
            disabled={sourcing}
            onChange={(event) => setKeywords(event.target.value)}
            placeholder="AI visibility, ecommerce, Switzerland"
          />
          <small className="li-hint">
            Comma or newline separated. Providers may ignore fields they do not need.
          </small>
        </label>
      </div>

      <label className="li-block-label acc-paste">
        Public source URLs{' '}
        {selected?.key === 'directory' ? '(required for directory crawl)' : '(optional)'}
        <textarea
          rows={4}
          value={urls}
          disabled={sourcing}
          onChange={(event) => setUrls(event.target.value)}
          placeholder={'https://example.com/best-companies\nhttps://example.org/directory'}
        />
      </label>

      {selected && (
        <p className={`li-hint${canPersist ? '' : ' acc-source-warning'}`}>
          {selected.availability.reason}
          {selected.retention === 'none'
            ? ' Trevra will not persist candidates from this provider.'
            : ''}
        </p>
      )}

      {result && (
        <div className="acc-source-result">
          <p className="li-hint">
            Run <code>{result.runId}</code> found {result.found} candidate(s) through{' '}
            {result.providerKey}.
          </p>
          {result.warnings.map((warning, index) => (
            <p className="li-hint" key={`${warning}-${index}`}>
              {warning}
            </p>
          ))}
          <ImportReport result={result.import} />
        </div>
      )}

      <div className="panel-footer">
        <span>
          Source reads public/provider data and adds accounts. It never contacts a prospect.
        </span>
        <button
          className="primary-button"
          type="button"
          disabled={sourcing || !canPersist}
          onClick={() => void runSource()}
        >
          {sourcing ? <LoaderCircle className="spin" size={15} /> : <Building2 size={15} />} Find
          accounts
        </button>
      </div>
    </>
  );
}

/**
 * What an import did, counted three ways.
 *
 * THE REJECTED LINES ARE SHOWN WITH THEIR REASON. A parser that quietly drops
 * what it could not read is how a list of 500 becomes a list of 480 and
 * nobody finds out until the twentieth company never gets a message.
 */
function ImportReport({ result }: { result: AccountImportResult }) {
  return (
    <div className="acc-import-report">
      <p className="acc-import-counts">
        <strong>{result.created}</strong> written · <strong>{result.duplicate}</strong> already here
        · <strong>{result.rejected.length}</strong> not usable
      </p>
      {result.rejected.length > 0 && (
        <>
          <p className="li-hint">
            These lines produced no domain, so nothing was written for them:
          </p>
          <ul className="acc-rejected">
            {result.rejected.map((entry, index) => (
              <li key={`${entry.line}-${index}`}>
                <code>{entry.line}</code>
                <span>{entry.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One account, as a sentence: who they are, how hot, and the scorer’s own line about why. */
function AccountRow({
  row,
  open,
  busy,
  onToggle,
  onNotAFit
}: {
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

  return (
    <article className={`acc-row${rejected ? ' is-rejected' : ''}`}>
      <div className="acc-row-head">
        <h4 aria-level={3}>{account.name}</h4>
        {score && (
          <span className={`li-chip acc-tier-${score.tier}`}>{TIER_LABELS[score.tier]}</span>
        )}
        {score && <span className="acc-score">score {score.score}</span>}
        {rejected && <span className="li-chip acc-tier-rejected">Not a fit</span>}
      </div>

      <p className="acc-sentence">
        {score
          ? score.rationale.summary
          : signals.length > 0
            ? `${signals.length} signal(s) found. Waiting for a score.`
            : 'Not read yet.'}
      </p>

      <div className="acc-row-actions">
        {expandable && (
          <button className="ghost-button" type="button" onClick={onToggle} aria-expanded={open}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {score ? 'Why this score' : 'What has been read'}
          </button>
        )}
        <a
          className="li-link acc-site"
          href={siteUrl(account.domain)}
          target="_blank"
          rel="noreferrer"
        >
          {account.domain} <ExternalLink size={11} />
        </a>
        {account.linkedinUrl && (
          <a className="li-link" href={account.linkedinUrl} target="_blank" rel="noreferrer">
            LinkedIn <ExternalLink size={11} />
          </a>
        )}
        <button
          className="ghost-button acc-reject"
          type="button"
          disabled={busy || rejected}
          onClick={onNotAFit}
        >
          {busy ? <LoaderCircle className="spin" size={14} /> : <ThumbsDown size={14} />} Not a fit
        </button>
      </div>

      {open && (score ? <ScorePanel score={score} /> : <SignalPanel row={row} />)}
    </article>
  );
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
  return (
    <div className="acc-why">
      <p className="acc-why-window">
        {score.distinctKinds} signal type(s) over {rationale.windowDays} days. Scored{' '}
        {relativeTime(score.computedAt)}.
      </p>

      {rationale.components.length === 0 ? (
        <p className="empty-copy">No signal inside the window carried any weight.</p>
      ) : (
        <ul className="acc-components">
          {rationale.components.map((component, index) => (
            <li key={`${component.kind}-${component.observedAt}-${index}`}>
              <div className="acc-component-head">
                <span className="li-chip">{kindLabel(component.kind)}</span>
                <span className="acc-points">{signed(component.points)}</span>
              </div>
              <p className="acc-component-detail">{component.detail}</p>
              <p className="acc-component-meta">
                {ageCopy(component.ageDays)} · weight {component.base} × recency {component.decay} ={' '}
                {component.points}
              </p>
              <a
                className="li-link acc-evidence"
                href={component.evidenceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Source <ExternalLink size={11} />
              </a>
            </li>
          ))}
        </ul>
      )}

      {rationale.combinations.length > 0 && (
        <div className="acc-why-block">
          <h5 aria-level={4}>Combined signals</h5>
          <ul className="acc-combinations">
            {rationale.combinations.map((combination, index) => (
              <li key={`${combination.kinds.join('+')}-${index}`}>
                <span className="acc-points">{signed(combination.bonus)}</span>
                <span>{combination.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rationale.penalties.length > 0 && (
        <div className="acc-why-block">
          <h5 aria-level={4}>Taken off</h5>
          <ul className="acc-penalties">
            {rationale.penalties.map((penalty, index) => (
              <li key={`${penalty.reason}-${index}`}>
                <span className="acc-points">{penalty.points}</span>
                <span>{penalty.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * What has been read, before there is a score to explain.
 *
 * The same evidence, without any arithmetic over it -- because there is none
 * yet, and inventing a provisional number here would be the one thing this
 * screen promises not to do.
 */
function SignalPanel({ row }: { row: RankedAccount }) {
  return (
    <div className="acc-why">
      <p className="acc-why-window">Not scored yet. Signals are newest first.</p>
      <ul className="acc-components">
        {row.signals.map((signal) => (
          <li key={signal.id}>
            <div className="acc-component-head">
              <span className="li-chip">{kindLabel(signal.kind)}</span>
            </div>
            <p className="acc-component-detail">{signal.detail}</p>
            <p className="acc-component-meta">Observed {relativeTime(signal.observedAt)}</p>
            <a
              className="li-link acc-evidence"
              href={signal.evidenceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Source <ExternalLink size={11} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
