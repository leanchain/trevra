import { id, type Db } from '../db.js';
import type {
  Account,
  AccountFeedback,
  AccountImportResult,
  AccountImportRow,
  AccountSource,
  AccountStatus,
  AccountTier,
  AccountScore,
  AccountSignal,
  RankedAccount,
  ScoreRationale
} from './types.js';

/**
 * The accounts store: the only writer of the account spine, and the only place
 * that decides what an account IS.
 *
 * Migration 039 says why the tables look like this. This file says why the
 * reads and writes over them look like this, and the whole file follows from
 * one sentence in that migration -- ONE RIGHT COMPANY BEATS A HUNDRED WRONG
 * ONES. A store built for a hundred wrong ones would be a bulk pipe: take the
 * paste, write the rows, move on. This one is built for the operator who is
 * going to look at forty companies and act on three, so:
 *
 * 1. THE DOMAIN IS THE IDENTITY, and {@link normalizeAccountDomain} is the ONE
 *    place that computes it. Every path in -- CSV, paste, sourced list,
 *    LinkedIn walk, a typed-in single account -- goes through it, because two
 *    spellings of the same company that survive as two rows is not a cosmetic
 *    problem: each one accumulates half the signals and neither scores.
 * 2. THE OPERATOR NEVER MAPS COLUMNS. {@link parseAccountImport} is one parser
 *    for a pasted newline list and for a CSV with or without a header, and it
 *    finds the domain rather than demanding it be in a particular place. A
 *    column-mapping dialog is a screen an operator abandons.
 * 3. AN IMPORT IS ONE ROUND TRIP, not one per row. A 500-line paste that costs
 *    500 statements is a request that times out, and the fix is not a spinner:
 *    the insert is a single statement over a JSON payload, and the unique index
 *    on (workspace_id, LOWER(domain)) is what makes re-pasting the same list a
 *    no-op. Same shape `storeLeads` uses next door, for the same reason.
 * 4. A REJECTION MUST COST NOTHING TWICE. Saying 'not a fit' clears
 *    `next_sweep_at`, so the row is kept as the evidence it is but never buys
 *    another fetch, and it is recorded as a SHAPE -- the signal kinds that were
 *    present when the operator said no -- because that is the only thing about
 *    a rejection that generalises to the next hundred companies.
 *
 * NOTHING HERE SCORES ANYTHING. `account_scores` is read and never written by
 * this file; the scorer owns that table, and this store's job is to hand it the
 * accounts, the signals and the rejected shapes it argues from.
 */

/* ---------------------------------------------------------------------------
 * Rows.
 * ------------------------------------------------------------------------ */

/**
 * Spelled once, as a list rather than a string, because the ranked read needs
 * the SAME columns qualified with a table alias. Two hand-maintained copies of
 * a column list is how a column gets added to one read and not the other.
 */
const ACCOUNT_FIELDS = [
  'id',
  'workspace_id',
  'name',
  'domain',
  'linkedin_url',
  'source',
  'tags',
  'status',
  'icp_note',
  'last_swept_at',
  'next_sweep_at',
  'sweep_error',
  'created_at',
  'updated_at'
] as const;

const ACCOUNT_COLUMNS = ACCOUNT_FIELDS.join(', ');
const ACCOUNT_COLUMNS_QUALIFIED = ACCOUNT_FIELDS.map((field) => `a.${field}`).join(', ');

const SIGNAL_COLUMNS = `
  id, workspace_id, account_id, kind, detail, previous, current,
  evidence_url, observed_at, fingerprint, created_at
`;

interface AccountRow {
  id: string;
  workspace_id: string;
  name: string;
  domain: string;
  linkedin_url: string | null;
  source: string;
  tags: string[] | null;
  status: string;
  icp_note: string | null;
  last_swept_at: string | null;
  next_sweep_at: string | null;
  sweep_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SignalRow {
  id: string;
  workspace_id: string;
  account_id: string;
  kind: string;
  detail: string;
  previous: string | null;
  current: string | null;
  evidence_url: string;
  observed_at: string;
  fingerprint: string;
  created_at: string;
}

interface ScoreRow {
  score: number | null;
  tier: string | null;
  distinct_kinds: number | null;
  newest_signal_at: string | null;
  rationale_json: string | null;
  computed_at: string | null;
}

interface FeedbackRow {
  id: string;
  workspace_id: string;
  account_id: string;
  verdict: string;
  reason: string | null;
  signal_shape: string;
  score_at_verdict: number | null;
  created_at: string;
}

/**
 * Postgres' own text form for a timestamptz is `2026-08-05 18:57:02.07+00`,
 * and the pool hands it back verbatim -- `db.ts` installs an identity type
 * parser so nothing in the process is at the mercy of a Date round trip. That
 * form is fine to compare in SQL and wrong to ship: the API contract in
 * `types.ts` says ISO, screens format ISO, and a test that asserts on one shape
 * while the API returns the other is a bug found in a browser. SO EVERY
 * TIMESTAMP CROSSES THIS FUNCTION ON THE WAY OUT, without exception.
 */
function toIso(value: string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: string | null): string | null {
  return value === null ? null : toIso(value);
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    domain: row.domain,
    linkedinUrl: row.linkedin_url,
    source: row.source as AccountSource,
    tags: row.tags ?? [],
    status: row.status as AccountStatus,
    icpNote: row.icp_note,
    lastSweptAt: toIsoOrNull(row.last_swept_at),
    nextSweepAt: toIsoOrNull(row.next_sweep_at),
    sweepError: row.sweep_error,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toSignal(row: SignalRow): AccountSignal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    kind: row.kind,
    detail: row.detail,
    previous: row.previous,
    current: row.current,
    evidenceUrl: row.evidence_url,
    observedAt: toIso(row.observed_at),
    fingerprint: row.fingerprint,
    createdAt: toIso(row.created_at)
  };
}

function toFeedback(row: FeedbackRow): AccountFeedback {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    verdict: row.verdict as AccountFeedback['verdict'],
    reason: row.reason,
    signalShape: row.signal_shape,
    scoreAtVerdict: row.score_at_verdict,
    createdAt: toIso(row.created_at)
  };
}

const EMPTY_RATIONALE: ScoreRationale = {
  components: [],
  combinations: [],
  penalties: [],
  windowDays: 0,
  summary: ''
};

/**
 * A score whose rationale will not parse is still a score.
 *
 * `rationale_json` is TEXT written by the scorer, and the ranked list is the
 * screen an operator lives on. A malformed blob -- a truncated write, a schema
 * that moved -- must cost the "why this score" panel and NOT the whole list;
 * throwing here would turn one bad row into an empty page.
 */
function toScore(workspaceId: string, accountId: string, row: ScoreRow): AccountScore | null {
  if (row.score === null || row.computed_at === null) return null;
  let rationale = EMPTY_RATIONALE;
  try {
    rationale = { ...EMPTY_RATIONALE, ...(JSON.parse(row.rationale_json ?? '{}') as Partial<ScoreRationale>) };
  } catch {
    /* Keep the empty rationale; the number and the tier are still true. */
  }
  return {
    workspaceId,
    accountId,
    score: row.score,
    tier: (row.tier ?? 'cold') as AccountTier,
    distinctKinds: row.distinct_kinds ?? 0,
    newestSignalAt: toIsoOrNull(row.newest_signal_at),
    rationale,
    computedAt: toIso(row.computed_at)
  };
}

/* ---------------------------------------------------------------------------
 * The domain. The identity of an account.
 * ------------------------------------------------------------------------ */

/**
 * Hosts that exist only inside somebody's own machine or network.
 *
 * An account keyed on one of these is a sweep that fails forever: there is no
 * public page to read, so it can never produce a signal, never score, and will
 * sit in the queue burning a fetch on every pass. REJECTED AT THE DOOR rather
 * than stored and marked broken later, because the operator who pasted a
 * staging hostname wants to be told now, in the import summary, not in a week.
 */
const NON_PUBLIC_SUFFIXES = new Set(['localhost', 'local', 'internal', 'lan', 'home', 'test', 'invalid', 'localdomain']);

/**
 * A host that survived permissive parsing: dot-separated labels of ASCII
 * letters, digits and inner hyphens, at least two of them. Deliberately
 * narrower than what the WHATWG parser will accept, which is the point --
 * see {@link normalizeAccountDomain}.
 */
const STRICT_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The registrable host an operator meant, or null when they did not give one.
 *
 * THIS FUNCTION IS THE IDENTITY OF AN ACCOUNT, so it is strict, and every
 * rejection below is a specific way two rows could otherwise become one
 * company or one row could become a permanent sweep failure.
 *
 * PARSE PERMISSIVELY, VALIDATE STRICTLY. The input is whatever a human had on
 * the clipboard -- `https://www.Acme.com/pricing?x=1`, `hi@acme.com`,
 * `ACME.COM.`, `acme.com:8080` -- so the WHATWG URL parser does the unwrapping,
 * because it already knows how to drop a scheme, userinfo, port, path, query
 * and fragment, lowercase the host and punycode an internationalised one, and a
 * hand-rolled regex for that job is a bug farm. But the URL parser is a
 * permissive thing that will happily hand back `192.168.0.1`, `localhost` or a
 * percent-encoded oddity, so ITS OUTPUT IS THEN VALIDATED AGAINST A NARROW
 * PATTERN. Neither half is redundant: the parser normalises, the pattern judges.
 *
 * What is rejected, and why each one:
 *
 *   * EMPTY -- nothing to key on.
 *   * ANY WHITESPACE -- `acme.com Ltd` is a line the parser never should have
 *     been handed; it means a CSV field was split wrong or a name and a domain
 *     were pasted together, and guessing which half is meant is how a company
 *     gets stored under half its name.
 *   * IP LITERALS, v4 and v6 -- an address is not a company. Two customers
 *     behind one CDN address would merge into one account; one company that
 *     changes host would fork into two.
 *   * LOCALHOST AND THE PRIVATE SUFFIXES -- see {@link NON_PUBLIC_SUFFIXES}.
 *   * SINGLE-LABEL HOSTS -- `acme` is a search term, not a host. Accepting it
 *     would let `acme` and `acme.com` live as two accounts for one company.
 *   * A NUMERIC LAST LABEL -- what an IPv4 literal looks like after a typo, and
 *     never what a real registrable domain looks like.
 *
 * NO PUBLIC SUFFIX LIST, DELIBERATELY. `www.` is stripped because it is the
 * one prefix that is never part of the identity, and nothing else is: cutting
 * to eTLD+1 without the PSL would turn `acme.co.uk` into `co.uk` and merge
 * every British company in the list into one account. A subdomain that really
 * is a separate company keeps its own row, which is the safe direction to be
 * wrong in -- a false split is visible to the operator, a false merge is not.
 *
 * lc-debt: no PSL, so `blog.acme.com` and `acme.com` are two accounts;
 * upgrade path is a bundled public-suffix table and a cut to eTLD+1 here, with
 * a one-off merge pass over existing rows.
 */
export function normalizeAccountDomain(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Whitespace anywhere inside means this was never one host. Checked before
  // parsing because the URL parser would silently percent-encode it away.
  if (/\s/.test(trimmed)) return null;

  let host: string;
  try {
    // A bare `acme.com` is not a URL; give it a scheme so the parser will take
    // it. Anything that already carries one keeps it -- including `mailto:`,
    // whose address the parser then reads as userinfo, which is exactly right.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    host = new URL(withScheme).hostname;
  } catch {
    return null;
  }

  // A fully-qualified `acme.com.` and `acme.com` are the same company. The root
  // dot is legal and the parser keeps it, so it is dropped here rather than
  // becoming a second row.
  host = host.replace(/\.+$/, '').toLowerCase();
  // The URL parser wraps an IPv6 literal in brackets. Nothing else does.
  if (host.startsWith('[')) return null;
  if (host.startsWith('www.')) host = host.slice(4);
  if (!STRICT_HOST.test(host)) return null;

  const labels = host.split('.');
  const suffix = labels[labels.length - 1] ?? '';
  if (NON_PUBLIC_SUFFIXES.has(suffix)) return null;
  // A trailing all-digit label is an IP literal or the wreckage of one. Real
  // top-level domains are never numeric.
  if (/^\d+$/.test(suffix)) return null;
  return host;
}

/* ---------------------------------------------------------------------------
 * The import parser. One parser, no column mapping.
 * ------------------------------------------------------------------------ */

/**
 * The ceiling on one paste.
 *
 * Not a performance limit -- the insert is one statement either way. It is a
 * PRODUCT limit: a list of ten thousand companies is not an ICP, it is a
 * purchased database, and sweeping it would spend a week of fetches on rows
 * nobody chose. The operator is told, in {@link AccountImportResult.rejected},
 * exactly how much was left unread rather than silently losing the tail.
 */
const MAX_IMPORT_ROWS = 2000;

/**
 * The vocabulary a header cell may be built from, and the words that make a
 * cell a header at all.
 *
 * A HEADER CELL IS MADE ONLY OF HEADER WORDS. That is the whole sniff rule, and
 * it is what keeps the first line of a headerless paste from being eaten: a
 * cell reading `Domain` or `Company Name` or `LinkedIn URL` is made entirely of
 * these, and `linkedin.com/company/acme` -- which contains the word `linkedin`
 * -- is not, because `com` and `acme` are not header words. Substring matching
 * would get that one wrong and silently drop a company.
 */
const HEADER_VOCABULARY = new Set([
  'domain',
  'website',
  'web',
  'site',
  'url',
  'link',
  'company',
  'account',
  'organisation',
  'organization',
  'name',
  'linkedin',
  'tags',
  'tag',
  'label',
  'labels'
]);

/** The words that carry meaning. A cell of only `link` is not a header. */
const HEADER_KEYWORDS = ['domain', 'website', 'url', 'company', 'name', 'linkedin', 'tags'];

/**
 * Split one CSV line into fields, honouring double quotes and `""` escapes.
 *
 * Written here rather than pulled in, because the input is a PASTE: it is one
 * line at a time, it has no encoding declaration, and half the time it is not
 * CSV at all but a newline list, in which case this returns the single field it
 * was given and nothing downstream has to know which shape it was.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      fields.push(field.trim());
      field = '';
      continue;
    }
    field += char;
  }
  fields.push(field.trim());
  return fields;
}

function headerTokens(cell: string): string[] {
  return cell
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isHeaderCell(cell: string): boolean {
  const tokens = headerTokens(cell);
  if (tokens.length === 0) return false;
  return tokens.every((token) => HEADER_VOCABULARY.has(token)) && tokens.some((token) => HEADER_KEYWORDS.includes(token));
}

/** Which column holds what. `-1` means "not named", which is the common case. */
interface ColumnMap {
  domain: number;
  name: number;
  linkedin: number;
  tags: number;
}

const NO_COLUMNS: ColumnMap = { domain: -1, name: -1, linkedin: -1, tags: -1 };

/**
 * Read a header row into a column map.
 *
 * RESOLVED MOST-SPECIFIC FIRST, and each column is claimed once. `LinkedIn URL`
 * would answer to both `linkedin` and `url`, so `linkedin` is taken first and
 * that cell is then off the table -- otherwise the LinkedIn column would be
 * read as the domain column and every row in the import would key on
 * `linkedin.com`, collapsing the entire list into one account.
 */
function mapColumns(cells: string[]): ColumnMap {
  const tokens = cells.map(headerTokens);
  const claimed = new Set<number>();
  const claim = (...words: string[]): number => {
    for (const word of words) {
      const index = tokens.findIndex((cell, position) => !claimed.has(position) && cell.includes(word));
      if (index >= 0) {
        claimed.add(index);
        return index;
      }
    }
    return -1;
  };
  const linkedin = claim('linkedin');
  const tags = claim('tags', 'tag', 'labels', 'label');
  const domain = claim('domain', 'website', 'url', 'site', 'web');
  const name = claim('name', 'company', 'account', 'organisation', 'organization');
  return { domain, name, linkedin, tags };
}

/** Free-text labels, however the operator separated them. */
function splitTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,|]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(tag);
  }
  return kept;
}

function looksLikeLinkedIn(value: string): boolean {
  return /(^|[./@])linkedin\.com\b/i.test(value);
}

/**
 * One line into one row, or null when it holds no company.
 *
 * THE DOMAIN IS FOUND, NOT DEMANDED. A named column is believed first, but if
 * it is empty or holds something that is not a host, every other field on the
 * line is tried before the line is rejected -- and with no header at all the
 * same scan runs from the first field. That is what "never make the operator
 * map columns" costs, and it is cheap: a list pasted as `Acme Corp, acme.com`
 * and a list pasted as `acme.com, Acme Corp` both import, and neither needed a
 * dialog.
 */
function rowFrom(fields: string[], columns: ColumnMap): AccountImportRow | null {
  const linkedinIndex = columns.linkedin >= 0 ? columns.linkedin : fields.findIndex((field) => looksLikeLinkedIn(field));

  let domainIndex = -1;
  let domain: string | null = null;
  if (columns.domain >= 0) domain = normalizeAccountDomain(fields[columns.domain] ?? '');
  if (domain) {
    domainIndex = columns.domain;
  } else {
    for (let index = 0; index < fields.length; index += 1) {
      // The LinkedIn field is never a domain candidate, and there is no fallback
      // to it. `linkedin.com/company/acme` normalises to `linkedin.com`, so a
      // list of LinkedIn URLs would not produce one account per company -- it
      // would produce ONE account, for LinkedIn, the unique index swallowing
      // every row after the first. Losing the line loudly beats that silently.
      if (index === linkedinIndex || index === columns.tags) continue;
      const candidate = normalizeAccountDomain(fields[index] ?? '');
      if (candidate) {
        domain = candidate;
        domainIndex = index;
        break;
      }
    }
  }
  if (!domain) return null;

  const linkedinUrl = linkedinIndex >= 0 ? (fields[linkedinIndex] ?? '').trim() || null : null;

  // With a header, the name is the named column. Without one, it is everything
  // on the line that was not the domain, the LinkedIn URL or the tags -- joined
  // rather than dropped, because an operator who pasted `acme.com, Acme, EU`
  // meant all of it to be the company, and losing the tail silently is worse
  // than a slightly long name they can edit.
  let name = columns.name >= 0 ? (fields[columns.name] ?? '').trim() : '';
  if (!name) {
    name = fields
      .filter((_, index) => index !== domainIndex && index !== linkedinIndex && index !== columns.tags && index !== columns.name)
      .map((field) => field.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  return {
    // NEVER NULL. The migration says so, and a screen that has to render
    // `(unnamed)` for half a CSV is a screen the operator stops trusting.
    name: name || domain,
    domain,
    linkedinUrl,
    tags: dedupeTags(splitTags(columns.tags >= 0 ? fields[columns.tags] : undefined))
  };
}

/**
 * A paste into rows, with a reason for every line that produced none.
 *
 * PURE, AND ONE PARSER FOR BOTH SHAPES. A newline list of bare domains and a
 * CSV export from a CRM are the same input to this function, because they are
 * the same intent from the operator: "here are the companies". A second parser
 * would be a second place for the header sniff and the dedupe to disagree.
 *
 * The dedupe is on the NORMALISED domain and the FIRST occurrence wins. The
 * order a list was pasted in is the operator's own ordering -- the top of the
 * list is the part they typed on purpose, the bottom is the part they appended
 * -- so a later line with a better name does not get to overwrite an earlier
 * one. An in-batch duplicate is not a rejection and is not reported as one:
 * nothing was lost, and telling somebody their list had the same company twice
 * is noise in a summary that exists to surface the lines that DID lose data.
 */
export function parseAccountImport(raw: string): { rows: AccountImportRow[]; rejected: { line: string; reason: string }[] } {
  const rejected: { line: string; reason: string }[] = [];
  const rows: AccountImportRow[] = [];
  if (typeof raw !== 'string' || !raw.trim()) return { rows, rejected };

  const lines = raw.split(/\r?\n/);
  let columns = NO_COLUMNS;
  let started = false;
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    // A blank line is not a mistake anybody needs told about.
    if (!line) continue;

    const fields = splitCsvLine(line);
    if (!started) {
      started = true;
      if (isHeaderCell(fields[0] ?? '')) {
        columns = mapColumns(fields);
        continue;
      }
    }

    if (rows.length >= MAX_IMPORT_ROWS) {
      // Counted, not guessed: the operator is told how many companies are still
      // sitting in their clipboard, so a second paste finishes the job.
      const remaining = lines.slice(index).filter((rest) => rest.trim()).length;
      rejected.push({
        line,
        reason: `An import is capped at ${MAX_IMPORT_ROWS} accounts. This line and ${remaining - 1} after it were not read -- paste the rest separately.`
      });
      break;
    }

    const row = rowFrom(fields, columns);
    if (!row) {
      rejected.push({
        line,
        reason: fields.some(looksLikeLinkedIn)
          ? 'Only a LinkedIn URL on this line. An account is keyed on its company domain -- every LinkedIn-only row would collapse into one account for linkedin.com.'
          : 'No company domain on this line. An account is keyed on its domain, so there is nothing here to import.'
      });
      continue;
    }
    if (seen.has(row.domain)) continue;
    seen.add(row.domain);
    rows.push(row);
  }

  return { rows, rejected };
}

/* ---------------------------------------------------------------------------
 * Writing accounts.
 * ------------------------------------------------------------------------ */

export interface AccountImportOptions {
  source: AccountSource;
  /** Applied to every row in the batch, on top of whatever the line carried. */
  tags?: string[];
  icpNote?: string | null;
}

/**
 * Import a paste. ONE STATEMENT, whatever the size of the list.
 *
 * A 500-line CSV that costs 500 inserts is a request an operator watches spin
 * and then reloads, which is how the same list gets imported twice. So the rows
 * ride in as ONE JSON PAYLOAD and are expanded server-side, the same shape
 * `storeLeads` uses for harvested leads.
 *
 * WHY JSON AND NOT `unnest` OF PARALLEL ARRAYS, which is what the lead insert
 * does: `tags` is a `TEXT[]` PER ROW, and a column of arrays cannot ride in an
 * `unnest` column -- Postgres flattens it. The alternative is hand-building an
 * array literal per row and casting it, which is a quoting-and-escaping problem
 * with an injection shape, and this file will not own that. `jsonb_to_recordset`
 * types the payload at the database, arrays and all, from ONE bound parameter.
 *
 * `created` and `duplicate` are EXACT because they are counted from the
 * `RETURNING` clause, not inferred: the unique index on
 * (workspace_id, LOWER(domain)) swallows what already existed, so the rows that
 * come back are precisely the rows that are new. Re-pasting the same list is
 * therefore a no-op that reports itself as one, which is the behaviour that
 * makes a nervous second paste safe.
 *
 * NEW ROWS ARE DUE IMMEDIATELY -- `next_sweep_at` is now. An import is an
 * operator saying "look at these", and a list that shows up empty because the
 * sweep has not been scheduled yet is a product that looks broken on its first
 * screen.
 */
export async function importAccounts(
  db: Db,
  workspaceId: string,
  raw: string,
  opts: AccountImportOptions,
  now: Date = new Date()
): Promise<AccountImportResult> {
  const { rows, rejected } = parseAccountImport(raw);
  if (rows.length === 0) return { created: 0, duplicate: 0, rejected, accounts: [] };

  const iso = now.toISOString();
  const batchTags = opts.tags ?? [];
  const payload = rows.map((row) => ({
    id: id('acc'),
    name: row.name,
    domain: row.domain,
    linkedin_url: row.linkedinUrl,
    tags: dedupeTags([...row.tags, ...batchTags])
  }));

  const created = await db.prepare(`
    INSERT INTO accounts
      (id, workspace_id, name, domain, linkedin_url, source, tags, status, icp_note,
       next_sweep_at, created_at, updated_at)
    SELECT r.id, ?, r.name, r.domain, r.linkedin_url, ?, r.tags, 'active', ?,
           ?::timestamptz, ?::timestamptz, ?::timestamptz
    FROM jsonb_to_recordset(?::jsonb)
      AS r(id text, name text, domain text, linkedin_url text, tags text[])
    ON CONFLICT (workspace_id, LOWER(domain)) DO NOTHING
    RETURNING ${ACCOUNT_COLUMNS}
  `).all<AccountRow>(
    workspaceId,
    opts.source,
    opts.icpNote ?? null,
    iso,
    iso,
    iso,
    JSON.stringify(payload)
  );

  // The second and last query. `accounts` is the whole batch as it now stands,
  // new rows and the ones that were already there, because the question the
  // operator asks after an import is "what have I got", not "what did you
  // write" -- and the counts above already answer the second one.
  const accounts = await db.prepare(`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
    WHERE workspace_id=? AND LOWER(domain) = ANY(?::text[])
    ORDER BY created_at DESC, id DESC
  `).all<AccountRow>(workspaceId, rows.map((row) => row.domain));

  return {
    created: created.length,
    duplicate: rows.length - created.length,
    rejected,
    accounts: accounts.map(toAccount)
  };
}

export interface AccountInput {
  name?: string;
  domain: string;
  linkedinUrl?: string | null;
  source: AccountSource;
  tags?: string[];
  icpNote?: string | null;
}

/**
 * Add one account by hand.
 *
 * IDEMPOTENT ON THE DOMAIN, like the import and for the same reason: a
 * double-submitted form must not produce a second row that splits the company's
 * signals. The existing account is returned unchanged -- NOT updated -- because
 * a create is not an edit, and silently overwriting a name or an ICP note
 * somebody curated would be a worse surprise than a form that appears to have
 * done nothing.
 *
 * Throws on a domain that is not one. Only here, never in the import path: a
 * single typed-in account has an operator looking straight at the field, and a
 * refusal they can read beats a row keyed on `htp://acme`.
 */
export async function createAccount(
  db: Db,
  workspaceId: string,
  input: AccountInput,
  now: Date = new Date()
): Promise<Account> {
  const domain = normalizeAccountDomain(input.domain);
  if (!domain) {
    throw new Error(
      `'${input.domain}' is not a company domain. An account is keyed on its registrable host -- acme.com, not an IP address, a single word or a local hostname.`
    );
  }

  const iso = now.toISOString();
  const inserted = await db.prepare(`
    INSERT INTO accounts
      (id, workspace_id, name, domain, linkedin_url, source, tags, status, icp_note,
       next_sweep_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?::text[],'active',?,?::timestamptz,?::timestamptz,?::timestamptz)
    ON CONFLICT (workspace_id, LOWER(domain)) DO NOTHING
    RETURNING ${ACCOUNT_COLUMNS}
  `).get<AccountRow>(
    id('acc'),
    workspaceId,
    input.name?.trim() || domain,
    domain,
    input.linkedinUrl?.trim() || null,
    input.source,
    dedupeTags(input.tags ?? []),
    input.icpNote ?? null,
    iso,
    iso,
    iso
  );
  if (inserted) return toAccount(inserted);

  // The index fired. There is exactly one row it could have fired on.
  const existing = await db.prepare(`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE workspace_id=? AND LOWER(domain)=?
  `).get<AccountRow>(workspaceId, domain);
  if (!existing) throw new Error(`The account for '${domain}' could not be created and no existing account claims that domain.`);
  return toAccount(existing);
}

/* ---------------------------------------------------------------------------
 * Reading accounts.
 * ------------------------------------------------------------------------ */

export async function getAccount(db: Db, workspaceId: string, accountId: string): Promise<Account | null> {
  const row = await db.prepare(`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE workspace_id=? AND id=?
  `).get<AccountRow>(workspaceId, accountId);
  return row ? toAccount(row) : null;
}

export interface ListAccountsOptions {
  status?: AccountStatus;
  limit?: number;
  offset?: number;
}

/**
 * The unranked list: newest first, every status unless one is asked for.
 *
 * `id DESC` is the last tiebreak on purpose. A bulk import writes every row
 * with the SAME `created_at`, so ordering on the timestamp alone is
 * non-deterministic between two reads of the same page -- which is a paginated
 * list that drops and repeats rows as the operator scrolls.
 */
export async function listAccounts(db: Db, workspaceId: string, opts: ListAccountsOptions = {}): Promise<Account[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const rows = await db.prepare(`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
    WHERE workspace_id=? AND (?::text IS NULL OR status = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all<AccountRow>(workspaceId, opts.status ?? null, opts.status ?? null, limit, offset);
  return rows.map(toAccount);
}

/**
 * Move an account in or out of the sweep.
 *
 * A REJECTED ACCOUNT MUST NEVER COST ANOTHER FETCH. `not_a_fit` and `archived`
 * both clear `next_sweep_at`, so the row survives as the record of the
 * operator's judgement -- which is the whole reason the migration refuses to
 * delete it -- while dropping straight out of the claim query. Leaving the
 * column set and relying on the worker to filter on status would be a second
 * place that has to remember, and the first sweep that forgot would spend a
 * day of fetches on companies somebody already said no to.
 *
 * Going back to `active` makes the account due IMMEDIATELY. Reactivating is an
 * operator changing their mind about a company, and the answer to "what has
 * moved there" should not wait for a scheduling cycle.
 */
export async function setAccountStatus(
  db: Db,
  workspaceId: string,
  accountId: string,
  status: AccountStatus,
  now: Date = new Date()
): Promise<Account | null> {
  const iso = now.toISOString();
  const row = await db.prepare(`
    UPDATE accounts SET status=?, next_sweep_at=?::timestamptz, updated_at=?::timestamptz
    WHERE workspace_id=? AND id=?
    RETURNING ${ACCOUNT_COLUMNS}
  `).get<AccountRow>(status, status === 'active' ? iso : null, iso, workspaceId, accountId);
  return row ? toAccount(row) : null;
}

/* ---------------------------------------------------------------------------
 * Feedback: what the operator rejected, and what it looked like.
 * ------------------------------------------------------------------------ */

/**
 * How far back a verdict looks when it computes the shape it is judging.
 *
 * Thirty days because that is roughly the horizon a signal is still worth
 * opening a message with. A shape assembled from everything ever observed would
 * describe a company's whole history rather than the state the operator was
 * actually shown, and the point of the snapshot is that it is what was ON THE
 * SCREEN when they said no.
 */
const FEEDBACK_SHAPE_WINDOW_DAYS = 30;

export interface AccountFeedbackInput {
  verdict: 'not_a_fit' | 'good_fit';
  reason?: string | null;
}

/**
 * Record a verdict, and what the account looked like when it was given.
 *
 * THE SHAPE IS THE POINT. "Acme is not a fit" teaches the scorer nothing it can
 * apply anywhere else; "hiring-up on its own, nothing else in thirty days, is
 * not a fit" teaches it something about the next hundred companies. So the
 * signal kinds inside the window are collapsed to a sorted, comma-joined string
 * and stored on the row -- SORTED IN JAVASCRIPT, not by the database, because
 * `ORDER BY` runs under whatever collation the cluster was initialised with and
 * a shape that sorts differently on two deployments is a shape that never
 * matches itself.
 *
 * `score_at_verdict` is copied, not referenced. The scorer replaces its row in
 * place on every recompute, so a foreign key would be a number that quietly
 * changes after the fact -- and "they rejected this at 84" has to stay true.
 *
 * A `not_a_fit` VERDICT ALSO SETS THE STATUS, in one call rather than leaving
 * it to whichever route happened to be in front of the operator. Rejecting a
 * company and having it come back on the next sweep is the single most
 * expensive way to lose their trust in the list. The two writes are deliberately
 * NOT wrapped in a transaction: the feedback row is the record of truth, this
 * store must stay callable from inside a caller's own transaction, and a status
 * update that lost a race is fixed by the next verdict rather than by losing
 * the judgement itself.
 */
export async function recordAccountFeedback(
  db: Db,
  workspaceId: string,
  accountId: string,
  input: AccountFeedbackInput,
  now: Date = new Date()
): Promise<AccountFeedback> {
  const account = await getAccount(db, workspaceId, accountId);
  if (!account) throw new Error(`No account '${accountId}' in this workspace, so there is nothing to give a verdict on.`);

  const cutoff = new Date(now.getTime() - FEEDBACK_SHAPE_WINDOW_DAYS * 86_400_000).toISOString();
  const [kindRows, scoreRow] = await Promise.all([
    db.prepare(`
      SELECT DISTINCT kind FROM account_signals
      WHERE workspace_id=? AND account_id=? AND observed_at >= ?::timestamptz
    `).all<{ kind: string }>(workspaceId, accountId, cutoff),
    db.prepare('SELECT score FROM account_scores WHERE workspace_id=? AND account_id=?').get<{ score: number }>(workspaceId, accountId)
  ]);

  const signalShape = kindRows
    .map((row) => row.kind)
    .sort()
    .join(',');

  const iso = now.toISOString();
  const row = await db.prepare(`
    INSERT INTO account_feedback
      (id, workspace_id, account_id, verdict, reason, signal_shape, score_at_verdict, created_at)
    VALUES (?,?,?,?,?,?,?,?::timestamptz)
    RETURNING id, workspace_id, account_id, verdict, reason, signal_shape, score_at_verdict, created_at
  `).get<FeedbackRow>(
    id('afb'),
    workspaceId,
    accountId,
    input.verdict,
    input.reason ?? null,
    signalShape,
    scoreRow?.score ?? null,
    iso
  );
  if (!row) throw new Error('The verdict could not be recorded.');

  if (input.verdict === 'not_a_fit') await setAccountStatus(db, workspaceId, accountId, 'not_a_fit', now);
  return toFeedback(row);
}

/**
 * The signal shapes this workspace has learned to say no to.
 *
 * The scorer's input, and the only cheap way the ranking gets sharper: nobody
 * is going to tune weights by hand, but everybody rejects rows, and a shape
 * rejected repeatedly is the operator telling us what their ICP is not.
 *
 * TWO GUARDS, both deliberate. `minCount` defaults to 2 because ONE rejection
 * is a company, not a pattern -- penalising a shape the first time it is
 * refused would let a single bad afternoon rewrite the ranking. And ANY
 * `good_fit` on a shape disqualifies it outright, however many rejections sit
 * next to it: a shape that has ever produced a real prospect is a shape whose
 * problem is the company, not the pattern, and suppressing it would hide the
 * next good one.
 *
 * The empty shape is excluded. "They had no signals in thirty days and I said
 * no" is a statement about silence, and penalising silence would push every
 * quiet company down a list they are already at the bottom of.
 *
 * Sorted in JavaScript, for the same collation reason the shapes are built that
 * way: the scorer compares these strings, and determinism is the contract.
 */
export async function rejectedSignalShapes(db: Db, workspaceId: string, opts: { minCount?: number } = {}): Promise<string[]> {
  const minCount = Math.max(1, Math.trunc(opts.minCount ?? 2));
  const rows = await db.prepare(`
    SELECT signal_shape FROM account_feedback
    WHERE workspace_id=? AND signal_shape <> ''
    GROUP BY signal_shape
    HAVING COUNT(*) FILTER (WHERE verdict='not_a_fit') >= ?
       AND COUNT(*) FILTER (WHERE verdict='good_fit') = 0
  `).all<{ signal_shape: string }>(workspaceId, minCount);
  return rows.map((row) => row.signal_shape).sort();
}

/* ---------------------------------------------------------------------------
 * The ranked list. The screen this whole spine exists to draw.
 * ------------------------------------------------------------------------ */

export interface RankedAccountsOptions {
  limit?: number;
  tier?: AccountTier;
  /** Newest signals carried per row. The evidence under the number. */
  signalLimit?: number;
  /** Audit-only: include `not_a_fit` and `archived` rows. Off by default, on purpose. */
  includeRejected?: boolean;
}

/**
 * Accounts by score, each carrying the evidence that produced it.
 *
 * TWO QUERIES, ALWAYS TWO, however long the list. The obvious implementation --
 * rank the accounts, then fetch each one's signals -- is a query per row, and
 * this is the list every session opens on. So the accounts and their scores
 * come back in one joined read, and the signals for all of them come back in
 * one windowed read that keeps the newest `signalLimit` PER ACCOUNT in the
 * database rather than over-fetching everything and slicing in memory.
 *
 * `NULLS LAST` is load-bearing: an unscored account is one the sweep has not
 * reached yet, not a zero, and Postgres sorts NULL first under `DESC` by
 * default -- which would put every account nobody has looked at above the ones
 * that actually earned their place. Below the scored rows, unscored accounts
 * fall back to newest-first, so a fresh import is visible immediately instead of
 * sinking under an old list.
 *
 * STATUS FILTERING: `active` only, always, unless the caller says otherwise in
 * so many words. A rejected company is not on a list to act on, and it must not
 * come back through the side door of a tier filter -- a score is computed at a
 * moment and outlives the rejection that followed it, so "show me the hot rows"
 * would otherwise resurrect exactly the accounts the operator already threw
 * out, at the top of the list. `includeRejected` exists for the audit question
 * ("what did the things I rejected score?"), and it has to be asked for.
 */
export async function listRankedAccounts(
  db: Db,
  workspaceId: string,
  opts: RankedAccountsOptions = {}
): Promise<RankedAccount[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 50)));
  const signalLimit = Math.max(0, Math.min(50, Math.trunc(opts.signalLimit ?? 5)));

  const rows = await db.prepare(`
    SELECT ${ACCOUNT_COLUMNS_QUALIFIED},
           s.score, s.tier, s.distinct_kinds, s.newest_signal_at, s.rationale_json, s.computed_at
    FROM accounts a
    LEFT JOIN account_scores s ON s.workspace_id = a.workspace_id AND s.account_id = a.id
    WHERE a.workspace_id=?
      AND (?::text IS NULL OR s.tier = ?)
      AND (?::bool IS TRUE OR a.status = 'active')
    ORDER BY s.score DESC NULLS LAST, a.created_at DESC, a.id DESC
    LIMIT ?
  `).all<AccountRow & ScoreRow>(workspaceId, opts.tier ?? null, opts.tier ?? null, opts.includeRejected ?? false, limit);
  if (rows.length === 0) return [];

  const accountIds = rows.map((row) => row.id);
  const signalRows =
    signalLimit === 0
      ? []
      : await db.prepare(`
          SELECT ${SIGNAL_COLUMNS} FROM (
            SELECT ${SIGNAL_COLUMNS},
                   ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY observed_at DESC, id DESC) AS rn
            FROM account_signals
            WHERE workspace_id=? AND account_id = ANY(?::text[])
          ) ranked
          WHERE rn <= ?
        `).all<SignalRow>(workspaceId, accountIds, signalLimit);

  const byAccount = new Map<string, AccountSignal[]>();
  for (const row of signalRows) {
    const bucket = byAccount.get(row.account_id);
    if (bucket) bucket.push(toSignal(row));
    else byAccount.set(row.account_id, [toSignal(row)]);
  }
  // The window function ordered them; the grouping above preserved that order.
  return rows.map((row) => ({
    account: toAccount(row),
    score: toScore(workspaceId, row.id, row),
    signals: byAccount.get(row.id) ?? []
  }));
}
