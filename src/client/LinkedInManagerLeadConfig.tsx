import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CircleAlert,
  FileUp,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  X
} from 'lucide-react';
import {
  createLinkedInManagerLeadList,
  deleteLinkedInManagerLeadContact,
  getLinkedInManagerLeadContacts,
  getLinkedInManagerLeadLists,
  importLinkedInManagerLeadCsv,
  previewLinkedInManagerLeadCsv,
  updateLinkedInManagerLeadContact,
  type LinkedInLeadCsvPreview
} from './api';
import type {
  LeadListSourceKind,
  LinkedInLeadContact,
  LinkedInLeadList
} from '../server/linkedin/lead-lists';
import { useActiveSeatKey } from './LinkedInAccounts';
import { errorMessage } from './LinkedInSafety';

/**
 * Building a lead list, and living with one afterwards.
 *
 * A CSV lands here in three moves -- read it, confirm which column is which,
 * put it in a list -- and the file is never stored until the last one. The
 * middle move is the point: the automatch is a guess at somebody else's export
 * format, and the operator is the only person who can see that "Account" meant
 * the company and "Name" meant both names at once.
 *
 * THE SECOND PANEL IS NOT AN AFTERTHOUGHT. A list is something people come
 * back to -- one bad row, one person who left, one company spelled two ways --
 * so the leads in it are editable here rather than only re-uploadable.
 */

/** Matches the server's own upload ceiling; a bigger file is refused before it is sent. */
const MAX_CSV_BYTES = 2 * 1024 * 1024;
/** How many data rows are read locally, for the header list and the name examples. */
const SAMPLE_ROWS = 8;
/** Rows of a list shown before "show more". */
const PAGE = 50;

type FieldMapping = LinkedInLeadCsvPreview['mapping'];
type LeadField = keyof FieldMapping;

/** What one import did. `reused` is on the wire; the client type predates it. */
type ImportReport = Awaited<ReturnType<typeof importLinkedInManagerLeadCsv>> & { reused?: number };

const FIELDS: ReadonlyArray<{ field: LeadField; label: string; required: boolean }> = [
  { field: 'firstName', label: 'First name', required: true },
  { field: 'lastName', label: 'Last name', required: true },
  { field: 'company', label: 'Company', required: true },
  { field: 'email', label: 'Email', required: false },
  { field: 'phone', label: 'Phone', required: false },
  { field: 'country', label: 'Country', required: false },
  { field: 'profileUrl', label: 'LinkedIn profile URL', required: false }
];

const REQUIRED_FIELDS: readonly LeadField[] = ['firstName', 'lastName', 'company'];

const SOURCE_LABELS: Record<LeadListSourceKind, string> = {
  csv: 'CSV',
  linkedin_search: 'LinkedIn people search',
  sales_navigator: 'Sales Navigator',
  post_keyword: 'Post and comment keywords'
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Enough CSV to read a header row and the first few lines, here in the page.
 *
 * The server is the parser of record -- this reads only what the screen has to
 * show before the server has answered: the column names, so the mapper can be
 * used even when the automatch missed a required field and the preview was
 * refused, and a handful of raw names, so the cleaned ones have something to
 * be compared against.
 */
function parseCsvRows(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      cell = '';
      row = [];
      if (rows.length >= maxRows) return rows;
      continue;
    }
    cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function readCsvHead(
  file: File
): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  const slice = file.slice(0, 256 * 1024);
  const text = await slice.text();
  const raw = parseCsvRows(text, SAMPLE_ROWS + 2);
  if (raw.length === 0) return { headers: [], rows: [] };
  // A sliced file can end mid-row, so the last row of a truncated read is dropped.
  const complete = slice.size < file.size && raw.length > 1 ? raw.slice(0, -1) : raw;
  const headers = (complete[0] ?? []).map((header) => header.replace(/^﻿/, ''));
  const rows = complete
    .slice(1)
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .slice(0, SAMPLE_ROWS)
    .map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] ?? '';
      });
      return record;
    });
  return { headers, rows };
}

function fileProblem(file: File): string {
  if (!/\.csv$/i.test(file.name))
    return `“${file.name}” is not a .csv file. Export your list as CSV and drop it here again.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_CSV_BYTES)
    return `“${file.name}” is ${formatSize(file.size)}, and 2 MB is the most one upload takes. Split it and import the parts one after another.`;
  return '';
}

interface ContactDraft {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  phone: string;
  country: string;
  profileUrl: string;
}

export function LinkedInManagerLeadConfig({
  onChanged,
  setToast
}: {
  onChanged: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const [activeSeatKey] = useActiveSeatKey();
  const [lists, setLists] = useState<LinkedInLeadList[]>([]);
  const [listsLoading, setListsLoading] = useState(true);

  /* -- the CSV half ------------------------------------------------------ */
  const [destination, setDestination] = useState('new');
  const [newName, setNewName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sample, setSample] = useState<{
    headers: string[];
    rows: Array<Record<string, string>>;
  } | null>(null);
  const [preview, setPreview] = useState<LinkedInLeadCsvPreview | null>(null);
  /** What the automatch chose on its own, kept so a change can be named as one. */
  const [autoMapping, setAutoMapping] = useState<FieldMapping>({});
  const [overrides, setOverrides] = useState<FieldMapping>({});
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<'' | 'preview' | 'import'>('');
  const [report, setReport] = useState<{
    listName: string;
    listId: string;
    counts: ImportReport;
  } | null>(null);
  const [error, setError] = useState('');
  /** Last preview wins: changing two columns quickly must not race. */
  const previewToken = useRef(0);

  /* -- the list half ----------------------------------------------------- */
  const [openListId, setOpenListId] = useState('');
  const [contacts, setContacts] = useState<LinkedInLeadContact[]>([]);
  /**
   * How many people are in the open list, counted by the server.
   *
   * NOT `contacts.length`, which is the size of one page. The read clamps at
   * 5000 whatever it is asked for, so the page length answers "how many came
   * back" and never "how many there are" -- which is how this screen came to
   * announce "the first 1,000 are shown" about a list nobody had measured,
   * true for no list at all: a 1,500-lead list showed every one of them under
   * that notice, and a 6,000-lead list lost 1,000 people in silence.
   */
  const [contactTotal, setContactTotal] = useState(0);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [visible, setVisible] = useState(PAGE);
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [armed, setArmed] = useState('');
  const [rowBusy, setRowBusy] = useState('');
  const [listError, setListError] = useState('');
  const editorRef = useRef<HTMLDivElement | null>(null);
  /** The confirmation is brought to the operator for the same reason the editor is. */
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const loadLists = useCallback(async (): Promise<LinkedInLeadList[]> => {
    setListsLoading(true);
    try {
      const next = await getLinkedInManagerLeadLists(activeSeatKey);
      setLists(next);
      return next;
    } catch (err) {
      setListError(errorMessage(err, 'Unable to read your lead lists.'));
      return [];
    } finally {
      setListsLoading(false);
    }
  }, [activeSeatKey]);

  const openList = useCallback(
    async (listId: string) => {
      setOpenListId(listId);
      setContacts([]);
      setContactTotal(0);
      setDraft(null);
      setArmed('');
      setFilter('');
      setVisible(PAGE);
      if (!listId) return;
      setContactsLoading(true);
      try {
        const result = await getLinkedInManagerLeadContacts(listId, activeSeatKey);
        setContacts(result.contacts);
        setContactTotal(result.total);
        setListError('');
      } catch (err) {
        setListError(errorMessage(err, 'Unable to read the leads in that list.'));
      } finally {
        setContactsLoading(false);
      }
    },
    [activeSeatKey]
  );

  useEffect(() => {
    void (async () => {
      const next = await loadLists();
      if (next.length > 0) await openList(next[0].id);
    })();
  }, [loadLists, openList]);

  const headers = preview?.headers ?? sample?.headers ?? [];

  /** The column each field is on right now: the operator's choice, else the server's. */
  const chosenHeader = useCallback(
    (field: LeadField): string =>
      overrides[field] ?? preview?.mapping?.[field] ?? autoMapping[field] ?? '',
    [overrides, preview, autoMapping]
  );

  const mappingToSend = useCallback(
    (next: FieldMapping): FieldMapping => {
      const mapping: FieldMapping = {};
      for (const { field } of FIELDS) {
        const header = next[field] ?? preview?.mapping?.[field] ?? autoMapping[field] ?? '';
        if (header) mapping[field] = header;
      }
      return mapping;
    },
    [preview, autoMapping]
  );

  const missingRequired = useMemo(
    () => FIELDS.filter((entry) => entry.required && !chosenHeader(entry.field)),
    [chosenHeader]
  );

  const runPreview = useCallback(async (target: File, mapping: FieldMapping, first: boolean) => {
    const token = previewToken.current + 1;
    previewToken.current = token;
    setBusy('preview');
    try {
      const result = await previewLinkedInManagerLeadCsv(
        target,
        Object.keys(mapping).length > 0 ? mapping : undefined
      );
      if (previewToken.current !== token) return;
      setPreview(result);
      if (first) setAutoMapping(result.mapping);
      setError('');
    } catch (err) {
      if (previewToken.current !== token) return;
      setPreview(null);
      const message = errorMessage(err, 'Unable to read that CSV.');
      // "Could not map required field" is not a fault to report twice: the
      // mapper below already shows which three columns are still unanswered.
      setError(/Could not map required field/i.test(message) ? '' : message);
    } finally {
      if (previewToken.current === token) setBusy('');
    }
  }, []);

  const takeFile = useCallback(
    async (next: File | null) => {
      if (!next) return;
      const problem = fileProblem(next);
      if (problem) {
        setError(problem);
        return;
      }
      setReport(null);
      setError('');
      setFile(next);
      setPreview(null);
      setAutoMapping({});
      setOverrides({});
      setSample(null);
      try {
        setSample(await readCsvHead(next));
      } catch {
        /* the preview below reports what is wrong with it */
      }
      await runPreview(next, {}, true);
    },
    [runPreview]
  );

  const changeMapping = (field: LeadField, header: string) => {
    const next: FieldMapping = { ...overrides };
    if (header) next[field] = header;
    else delete next[field];
    setOverrides(next);
    if (!file) return;
    const mapping = mappingToSend(next);
    // A mapping missing one of the three the server insists on would come back
    // as an error, not a preview. It is a half-finished form, so it waits.
    if (REQUIRED_FIELDS.every((required) => mapping[required]))
      void runPreview(file, mapping, false);
    else {
      setPreview(null);
      setError('');
    }
  };

  /**
   * A few rows as they are in the file, beside the names that will be stored.
   *
   * Accepted rows come back in file order and every rejected row names its own
   * line number, so walking the local sample and the accepted list together
   * pairs raw row to cleaned row without either side carrying an id.
   */
  const scrubExamples = useMemo(() => {
    if (!preview || !sample) return [];
    const rejectedRows = new Set(preview.rejected.map((entry) => entry.row));
    const firstHeader = chosenHeader('firstName');
    const lastHeader = chosenHeader('lastName');
    const pairs: Array<{ before: string; after: string; changed: boolean }> = [];
    let acceptedIndex = 0;
    sample.rows.forEach((row, index) => {
      if (rejectedRows.has(index + 2)) return;
      const clean = preview.accepted[acceptedIndex];
      acceptedIndex += 1;
      if (!clean) return;
      const before =
        `${firstHeader ? (row[firstHeader] ?? '') : ''} ${lastHeader ? (row[lastHeader] ?? '') : ''}`
          .replace(/\s+/g, ' ')
          .trim();
      const after = `${clean.firstName} ${clean.lastName}`.trim();
      if (before) pairs.push({ before, after, changed: before !== after });
    });
    const changed = pairs.filter((pair) => pair.changed);
    return (changed.length > 0 ? changed : pairs).slice(0, 3);
  }, [preview, sample, chosenHeader]);

  const destinationList = lists.find((list) => list.id === destination) ?? null;
  const canImport =
    busy === '' &&
    file !== null &&
    preview !== null &&
    preview.acceptedCount > 0 &&
    missingRequired.length === 0 &&
    (destination !== 'new' ? destinationList !== null : newName.trim().length > 0);

  /** Why the import button is off, said where the button is. */
  const blocker = !file
    ? ''
    : missingRequired.length > 0
      ? 'Point first name, last name and company at a column before importing.'
      : !preview
        ? ''
        : preview.acceptedCount === 0
          ? 'No row in this file has all three of first name, last name and company, so there is nothing to import yet.'
          : destination === 'new' && !newName.trim()
            ? 'Name the new list before importing.'
            : '';

  const runImport = async () => {
    if (!file || !canImport) return;
    setBusy('import');
    setError('');
    try {
      const list =
        destination === 'new'
          ? await createLinkedInManagerLeadList({
              seatKey: activeSeatKey,
              name: newName.trim(),
              sourceKind: 'csv'
            })
          : destinationList!;
      const counts = (await importLinkedInManagerLeadCsv(
        list.id,
        file,
        mappingToSend(overrides),
        activeSeatKey
      )) as ImportReport;
      setReport({ listId: list.id, listName: list.name, counts });
      setToast(
        counts.inserted > 0
          ? `${plural(counts.inserted, 'lead')} added to “${list.name}”. Campaigns can enrol from it now.`
          : `Nothing new was added to “${list.name}” — every usable row was already there.`
      );
      // The file is done. A second import is a deliberate act, not a stray click.
      setFile(null);
      setPreview(null);
      setSample(null);
      setOverrides({});
      setAutoMapping({});
      setNewName('');
      setDestination(list.id);
      await loadLists();
      await openList(list.id);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Unable to import that CSV. Nothing was stored.'));
    } finally {
      setBusy('');
    }
  };

  /* -- editing what is already in a list --------------------------------- */

  const startEdit = (contact: LinkedInLeadContact) => {
    setArmed('');
    // The editor is not inside the table -- a form in a sideways-scrolling row
    // is a form a phone cannot reach -- so it is brought to the operator
    // instead of the operator hunting for it.
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'nearest' }));
    setDraft({
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      company: contact.company,
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      country: contact.country ?? '',
      profileUrl: contact.profileUrl ?? ''
    });
  };

  const saveContact = async () => {
    if (!draft) return;
    setRowBusy(draft.id);
    try {
      const updated = await updateLinkedInManagerLeadContact(draft.id, {
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        company: draft.company.trim(),
        email: draft.email.trim() || null,
        phone: draft.phone.trim() || null,
        country: draft.country.trim() || null,
        profileUrl: draft.profileUrl.trim() || null
      });
      setContacts((current) =>
        current.map((contact) => (contact.id === updated.id ? updated : contact))
      );
      setDraft(null);
      setListError('');
      setToast(`${updated.firstName} ${updated.lastName} updated.`);
      await onChanged();
    } catch (err) {
      setListError(errorMessage(err, 'Unable to save that lead.'));
    } finally {
      setRowBusy('');
    }
  };

  /**
   * Removing a lead is not removing a row from a list.
   *
   * `linkedin_campaign_members.contact_id` and `linkedin_manual_tasks.contact_id`
   * both reference this record ON DELETE CASCADE, so deleting the contact takes
   * their place in every campaign they are enrolled in and every message a
   * campaign was waiting on the operator to write for them. The old sentence --
   * "any campaign they are already in is unaffected" -- was the exact opposite
   * of what the schema does, and it was said AFTER the fact. What Trevra
   * already sent is untouched: `linkedin_actions` keys on the profile URL and
   * holds no reference to this record, so the ledger keeps its history.
   */
  const removeContact = async (contact: LinkedInLeadContact) => {
    setRowBusy(contact.id);
    try {
      await deleteLinkedInManagerLeadContact(contact.id);
      setContacts((current) => current.filter((entry) => entry.id !== contact.id));
      setContactTotal((current) => Math.max(0, current - 1));
      setArmed('');
      setListError('');
      setToast(
        `${contact.firstName} ${contact.lastName} removed. Their place in every campaign they were in went with them, along with any message a campaign was waiting on you to write for them. What Trevra already sent stays in the ledger.`
      );
      await loadLists();
      await onChanged();
    } catch (err) {
      setListError(errorMessage(err, 'Unable to remove that lead.'));
    } finally {
      setRowBusy('');
    }
  };

  const openMeta = lists.find((list) => list.id === openListId) ?? null;
  /** The lead a Remove press has armed, so the consequences can be read before the second press. */
  const armedContact = contacts.find((contact) => contact.id === armed) ?? null;
  const term = filter.trim().toLowerCase();
  const filtered = term
    ? contacts.filter((contact) =>
        `${contact.firstName} ${contact.lastName} ${contact.company} ${contact.email ?? ''}`
          .toLowerCase()
          .includes(term)
      )
    : contacts;
  const shown = filtered.slice(0, visible);
  const draftValid =
    draft !== null &&
    draft.firstName.trim() !== '' &&
    draft.lastName.trim() !== '' &&
    draft.company.trim() !== '';

  return (
    <div className="lead-build">
      <section
        className="page-panel"
        onDragOver={(event) => {
          if (busy === '') {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (busy !== '') return;
          void takeFile(event.dataTransfer.files?.[0] ?? null);
        }}
      >
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>
              <Users size={18} className="li-heading-icon" /> Add leads from a CSV
            </h3>
            <p>
              Names, companies and contact details from a file you already have. Nothing is stored
              until you import, and what you confirm here is exactly what lands — campaigns enrol
              people from these lists.
            </p>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="li-form-grid">
          <label>
            Add these leads to
            <select
              value={destination}
              disabled={busy !== ''}
              onChange={(event) => setDestination(event.target.value)}
            >
              <option value="new">A new list…</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} · {plural(list.leadCount, 'lead')}
                </option>
              ))}
            </select>
          </label>
          {destination === 'new' && (
            <label>
              Name the new list
              <input
                value={newName}
                disabled={busy !== ''}
                placeholder="Q3 founders"
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
          )}
        </div>

        <div className={dragging ? 'lead-drop is-dragging' : 'lead-drop'}>
          <FileUp size={20} />
          <div className="lead-drop-copy">
            <strong>{file ? file.name : 'Drop a CSV here'}</strong>
            <p>
              {file
                ? `${formatSize(file.size)}${preview ? ` · ${plural(preview.acceptedCount, 'usable row')}` : busy === 'preview' ? ' · reading it…' : ''}`
                : 'Or choose one below. Up to 2 MB, .csv only — a file dropped here is read, not stored.'}
            </p>
          </div>
          <label className="secondary-button">
            {busy === 'preview' ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <FileUp size={14} />
            )}
            {file ? ' Choose another file' : ' Choose a CSV'}
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              disabled={busy !== ''}
              onChange={(event) => {
                void takeFile(event.target.files?.[0] ?? null);
                event.target.value = '';
              }}
            />
          </label>
        </div>

        {file && headers.length > 0 && (
          <div className="lead-section">
            <h4>Which column is which</h4>
            <p className="li-hint">
              Matched from your headings. Change any of them and the rows below are read again.
              First name, last name and company have to point at a column — a lead without them is
              not a lead a campaign can write to.
            </p>
            <div className="li-form-grid lead-map-grid">
              {FIELDS.map((entry) => {
                const chosen = chosenHeader(entry.field);
                const auto = autoMapping[entry.field] ?? '';
                const missing = entry.required && !chosen;
                return (
                  <label
                    key={entry.field}
                    className={missing ? 'lead-map-row is-missing' : 'lead-map-row'}
                  >
                    <span className="lead-map-name">
                      {entry.label}
                      {entry.required && <em>Required</em>}
                    </span>
                    <select
                      value={chosen}
                      disabled={busy !== ''}
                      onChange={(event) => changeMapping(entry.field, event.target.value)}
                    >
                      {!chosen && (
                        <option value="">
                          {entry.required ? 'Choose a column…' : 'Not imported'}
                        </option>
                      )}
                      {!entry.required && !auto && chosen && <option value="">Not imported</option>}
                      {headers.map((header) => (
                        <option key={header} value={header}>
                          {header || '(unnamed column)'}
                        </option>
                      ))}
                    </select>
                    <span className="lead-map-note">
                      {chosen && auto && chosen !== auto
                        ? `Changed from “${auto}”`
                        : chosen && chosen === auto
                          ? 'Matched by its heading'
                          : chosen
                            ? 'Your choice'
                            : 'No column matched'}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {file && missingRequired.length > 0 && (
          <div className="li-warn-block">
            <CircleAlert size={15} />
            <div>
              <strong>
                {missingRequired.length === 1
                  ? 'One column is still unanswered'
                  : `${missingRequired.length} columns are still unanswered`}
              </strong>
              <ul>
                {missingRequired.map((entry) => (
                  <li key={entry.field}>
                    Point <b>{entry.label}</b> at the column that holds it.
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {scrubExamples.length > 0 && (
          <div className="lead-section">
            <h4>What the names will look like</h4>
            <p className="li-hint">
              Titles and qualifications — Dr, Prof, Mrs, PhD, MBA, MSc, CEO, LION and the rest of
              the usual list — along with emoji and stray punctuation, are removed before a lead is
              stored, so a message that opens with a first name opens with a name.
            </p>
            <ul className="lead-scrub-list">
              {scrubExamples.map((example, index) => (
                <li key={`${example.before}:${index}`}>
                  <span
                    className={example.changed ? 'lead-scrub-raw is-changed' : 'lead-scrub-raw'}
                  >
                    {example.before}
                  </span>
                  <ArrowRight size={13} />
                  <strong>{example.after}</strong>
                  {!example.changed && <em>unchanged</em>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {preview && preview.rejectedCount > 0 && (
          <div className="lead-section">
            <h4>{plural(preview.rejectedCount, 'row')} will not be imported</h4>
            <p className="li-hint">
              Fix them in the file and drop it again, or import the rest and leave them. Row numbers
              count the heading as row 1.
            </p>
            <div className="li-table-scroll">
              <table className="li-table lead-rejects">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rejected.slice(0, 8).map((entry) => (
                    <tr key={entry.row}>
                      <td className="li-num">{entry.row}</td>
                      <td>{entry.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rejectedCount > 8 && (
              <p className="li-hint">
                {plural(preview.rejectedCount - 8, 'other row')} for the same kinds of reason.
              </p>
            )}
          </div>
        )}

        <div className="panel-footer">
          <span>
            {blocker ||
              (preview
                ? `${plural(preview.acceptedCount, 'lead')} ready for ${destination === 'new' ? (newName.trim() ? `“${newName.trim()}”` : 'a new list') : `“${destinationList?.name ?? 'this list'}”`}.`
                : 'Reading a file changes nothing. Importing writes the leads and contacts nobody.')}
          </span>
          <button
            className="primary-button"
            type="button"
            disabled={!canImport}
            onClick={() => void runImport()}
          >
            {busy === 'import' ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
            {preview ? ` Import ${plural(preview.acceptedCount, 'lead')}` : ' Import'}
          </button>
        </div>

        {report && (
          <div className="lead-report" role="status">
            <strong>
              <Check size={15} /> “{report.listName}” updated
            </strong>
            <ul className="lead-counts">
              <li>
                <strong>{report.counts.inserted.toLocaleString()}</strong> added
              </li>
              <li>
                <strong>
                  {Math.max(
                    0,
                    report.counts.duplicates - (report.counts.reused ?? 0)
                  ).toLocaleString()}
                </strong>{' '}
                already in this list
              </li>
              <li>
                <strong>{(report.counts.reused ?? 0).toLocaleString()}</strong> already yours in
                another list
              </li>
              <li>
                <strong>{report.counts.rejected.length.toLocaleString()}</strong> rejected
              </li>
            </ul>
            <p className="li-hint">
              Somebody who was already in another list keeps their single record rather than being
              copied — one person is one lead, so a campaign cannot reach them twice.
            </p>
            <div className="mgr-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void openList(report.listId)}
              >
                <Users size={14} /> See the leads in this list
              </button>
            </div>
          </div>
        )}

        <div className="lead-kinds">
          <h4>Where lead lists come from</h4>
          <dl>
            <div>
              <dt>{SOURCE_LABELS.csv}</dt>
              <dd>Built here, from a file you export from anywhere.</dd>
            </div>
            <div>
              <dt>{SOURCE_LABELS.linkedin_search}</dt>
              <dd>
                Walked by the local browser worker on Lead sources, then added to a list from there.
              </dd>
            </div>
            <div>
              <dt>{SOURCE_LABELS.sales_navigator}</dt>
              <dd>The same walk against a Sales Navigator people search.</dd>
            </div>
            <div>
              <dt>{SOURCE_LABELS.post_keyword}</dt>
              <dd>People who reacted to or commented on posts matching your keywords.</dd>
            </div>
          </dl>
          <a className="li-link" href="/outreach/leads">
            Open Lead sources <ArrowRight size={13} />
          </a>
        </div>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Leads in a list</h3>
            <p>
              Read a list, fix a row, drop somebody who left. Editing a lead here changes them
              everywhere, including in campaigns they are already in.
            </p>
          </div>
          <button
            className="ghost-button"
            type="button"
            disabled={contactsLoading || listsLoading}
            onClick={() =>
              void (async () => {
                await loadLists();
                await openList(openListId);
              })()
            }
          >
            {contactsLoading || listsLoading ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <RefreshCw size={14} />
            )}{' '}
            Refresh
          </button>
        </div>

        {listError && <div className="error-banner">{listError}</div>}

        {!listsLoading && lists.length === 0 ? (
          <div className="mgr-empty">
            <h4 aria-level={3}>No lead list yet</h4>
            <p>
              Import a CSV above, or walk a LinkedIn search on Lead sources and add the people it
              finds to a list. A campaign enrols from a list — until one has leads in it, there is
              nobody to reach.
            </p>
            <div className="mgr-actions">
              <a className="secondary-button" href="/outreach/leads">
                Open Lead sources <ArrowRight size={14} />
              </a>
            </div>
          </div>
        ) : (
          <>
            <div className="li-filter-row">
              <label>
                List
                <select
                  value={openListId}
                  disabled={contactsLoading}
                  onChange={(event) => void openList(event.target.value)}
                >
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name} · {plural(list.leadCount, 'lead')}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Find someone
                <input
                  value={filter}
                  placeholder="Name, company or email"
                  onChange={(event) => {
                    setFilter(event.target.value);
                    setVisible(PAGE);
                  }}
                />
              </label>
              {openMeta && (
                <span className="li-chip">From {SOURCE_LABELS[openMeta.sourceKind]}</span>
              )}
            </div>

            {contactsLoading ? (
              <p className="empty-copy">Reading this list…</p>
            ) : contacts.length === 0 ? (
              <p className="empty-copy">
                Nothing in this list yet. Import a CSV above and it fills up.
              </p>
            ) : (
              <>
                {/* The truncation notice is the server's count against the page
                    it actually returned, so it appears exactly when a page was
                    short and says by how much. Contacts come back oldest first,
                    which is what makes "the first" the right word for them. */}
                <p className="li-hint">
                  {plural(filtered.length, 'lead')}
                  {term ? ` of ${plural(contacts.length, 'lead')} read` : ''} in “
                  {openMeta?.name ?? 'this list'}”.
                  {contactTotal > contacts.length &&
                    ` The first ${contacts.length.toLocaleString()} of ${plural(contactTotal, 'lead')} are shown — one read of a list returns no more than that, and Find someone searches the ones it returned.`}
                </p>
                {draft && (
                  <div className="lead-editor" ref={editorRef}>
                    <h4>
                      Editing {contacts.find((contact) => contact.id === draft.id)?.firstName}{' '}
                      {contacts.find((contact) => contact.id === draft.id)?.lastName}
                    </h4>
                    <div className="li-form-grid lead-edit-grid">
                      <label>
                        First name
                        <input
                          value={draft.firstName}
                          onChange={(event) =>
                            setDraft({ ...draft, firstName: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Last name
                        <input
                          value={draft.lastName}
                          onChange={(event) => setDraft({ ...draft, lastName: event.target.value })}
                        />
                      </label>
                      <label>
                        Company
                        <input
                          value={draft.company}
                          onChange={(event) => setDraft({ ...draft, company: event.target.value })}
                        />
                      </label>
                      <label>
                        Email
                        <input
                          value={draft.email}
                          onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                        />
                      </label>
                      <label>
                        Phone
                        <input
                          value={draft.phone}
                          onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                        />
                      </label>
                      <label>
                        Country
                        <input
                          value={draft.country}
                          onChange={(event) => setDraft({ ...draft, country: event.target.value })}
                        />
                      </label>
                      <label className="li-span-2">
                        LinkedIn profile URL
                        <input
                          value={draft.profileUrl}
                          placeholder="https://www.linkedin.com/in/…"
                          onChange={(event) =>
                            setDraft({ ...draft, profileUrl: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <p className="li-hint">
                      Names are cleaned on save the same way they are on import. First name, last
                      name and company are required.
                    </p>
                    <div className="mgr-actions">
                      <button
                        className="primary-button"
                        type="button"
                        disabled={!draftValid || rowBusy !== ''}
                        onClick={() => void saveContact()}
                      >
                        {rowBusy === draft.id ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <Check size={14} />
                        )}{' '}
                        Save this lead
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={rowBusy !== ''}
                        onClick={() => setDraft(null)}
                      >
                        <X size={14} /> Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/*
                  THE CONSEQUENCES ARE READ BEFORE THE PRESS, NOT AFTER IT.

                  The second press used to be two words in a table cell and the
                  cascade was described in a toast that had it backwards. It is
                  out of the row for the same reason the editor is: a decision
                  taken inside a sideways-scrolling table is a decision a phone
                  cannot reach, and this one is not reversible.
                */}
                {armedContact && (
                  <div className="li-warn-block" ref={confirmRef}>
                    <CircleAlert size={15} />
                    <div>
                      <strong>
                        Remove {armedContact.firstName} {armedContact.lastName} for good?
                      </strong>
                      <p>
                        This deletes the lead, not just their line in “
                        {openMeta?.name ?? 'this list'}”. Their place in every campaign they are
                        enrolled in goes with them, and so does any message a campaign was waiting
                        on you to write for them — both hang off this record and are removed with
                        it. What Trevra has already sent them stays in the ledger; nothing is
                        unsent.
                      </p>
                      <div className="mgr-actions">
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={rowBusy !== ''}
                          onClick={() => setArmed('')}
                        >
                          <X size={14} /> Keep them
                        </button>
                        <button
                          className="li-mini-button li-mini-danger"
                          type="button"
                          disabled={rowBusy !== ''}
                          onClick={() => void removeContact(armedContact)}
                        >
                          {rowBusy === armedContact.id ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <Trash2 size={14} />
                          )}{' '}
                          Remove for good
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div className="li-table-scroll">
                  <table className="li-table lead-contacts">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Company</th>
                        <th>Email</th>
                        <th>Phone</th>
                        <th>Country</th>
                        <th>LinkedIn</th>
                        <th>
                          <span className="mgr-sr">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((contact) => {
                        const editing = draft?.id === contact.id;
                        return (
                          <tr key={contact.id} className={editing ? 'lead-row-editing' : undefined}>
                            <td>
                              <strong>
                                {contact.firstName} {contact.lastName}
                              </strong>
                            </td>
                            <td>{contact.company || '—'}</td>
                            <td>{contact.email || '—'}</td>
                            <td>{contact.phone || '—'}</td>
                            <td>{contact.country || '—'}</td>
                            <td>
                              {contact.profileUrl ? (
                                <a
                                  className="li-link"
                                  href={contact.profileUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Profile
                                </a>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>
                              <div className="li-row-actions">
                                {armed === contact.id ? (
                                  <span className="li-hint">Confirm above</span>
                                ) : (
                                  <>
                                    <button
                                      className="li-mini-button"
                                      type="button"
                                      disabled={rowBusy !== '' || editing}
                                      onClick={() => startEdit(contact)}
                                    >
                                      <Pencil size={12} /> Edit
                                    </button>
                                    <button
                                      className="li-mini-button li-mini-danger"
                                      type="button"
                                      disabled={rowBusy !== ''}
                                      onClick={() => {
                                        setDraft(null);
                                        setArmed(contact.id);
                                        // The confirmation is above the table, so it is
                                        // brought to the operator rather than left for
                                        // them to scroll back and find.
                                        requestAnimationFrame(() =>
                                          confirmRef.current?.scrollIntoView({ block: 'nearest' })
                                        );
                                      }}
                                    >
                                      <Trash2 size={12} /> Remove
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {filtered.length > shown.length && (
                  <div className="mgr-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => setVisible(visible + PAGE)}
                    >
                      Show {Math.min(PAGE, filtered.length - shown.length)} more
                    </button>
                  </div>
                )}
                {filtered.length === 0 && (
                  <p className="empty-copy">Nobody in this list matches “{filter.trim()}”.</p>
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
