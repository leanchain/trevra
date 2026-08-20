export interface AccountImportFileLike {
  name: string;
  size: number;
  /** Browser directory uploads expose this; tests and single-file imports may omit it. */
  webkitRelativePath?: string;
  text(): Promise<string>;
}

export interface PreparedContactEvidence {
  names: string[];
  emails: string[];
  phones: string[];
}

export interface PreparedAccountRow {
  id: string;
  included: boolean;
  domain: string;
  name: string;
  platform: string;
  linkedinUrl: string;
  tags: string[];
  editedFields: string[];
  original: {
    domain: string;
    name: string;
    platform: string;
    linkedinUrl: string;
    tags: string[];
  };
  sourcePath: string;
  /** The exact source field used for each value. No model inference is hidden here. */
  sourceFields: {
    domain: string;
    name?: string;
    platform?: string;
    linkedinUrl?: string;
    tags?: string;
  };
  contactEvidence: PreparedContactEvidence;
  issues: string[];
}

export interface PreparedAccountFiles {
  text: string;
  rows: PreparedAccountRow[];
  accountCount: number;
  inspectedFiles: number;
  ignoredFiles: number;
  usedFiles: string[];
  /** Human-readable summary shown before the operator presses Import. */
  summary: string;
}

const SINGLE_FILE_MAX_BYTES = 5_000_000;
const MANIFEST_MAX_BYTES = 1_000_000;
const MAX_FOLDER_FILES = 20_000;
const MAX_ACCOUNTS = 2_000;

const MANIFEST_NAME_HINT =
  /(^|[_-])(summary|summaries|account|accounts|company|companies|prospect|prospects|lead|leads|store|stores|shop|shops)([_-]|\.|$)/i;

interface PickedString {
  value: string;
  field: string;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): PickedString | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return { value: value.trim(), field: key };
  }
  return null;
}

function stringsFrom(record: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const raw = record[key];
    if (Array.isArray(raw)) {
      return raw
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (typeof raw === 'string' && raw.trim()) {
      return raw
        .split(/[;,|]/)
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function tagsFrom(record: Record<string, unknown>): { tags: string[]; field?: string } {
  const field =
    Array.isArray(record.tags) || typeof record.tags === 'string'
      ? 'tags'
      : Array.isArray(record.labels) || typeof record.labels === 'string'
        ? 'labels'
        : undefined;
  const raw = field ? record[field] : undefined;
  const tags = Array.isArray(raw)
    ? raw
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    : typeof raw === 'string'
      ? raw
          .split(/[;,|]/)
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  return {
    tags: [...new Map(tags.map((tag) => [tag.toLowerCase(), tag])).values()],
    field
  };
}

/** A deterministic key for review-only duplicate detection. The server remains authoritative. */
export function reviewDomainKey(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.replace(/^www\./, '').replace(/\.$/, '');
    if (!host || !host.includes('.') || /\s/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

function compactRow(value: unknown, sourcePath: string, index: number): PreparedAccountRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const domain = pickString(record, ['domain', 'website', 'url', 'site']);
  if (!domain) return null;
  const name = pickString(record, ['name', 'company', 'account', 'organisation', 'organization']);
  const platform = pickString(record, ['platform']);
  const linkedin = pickString(record, ['linkedinUrl', 'linkedin_url', 'linkedin']);
  const tagResult = tagsFrom(record);
  const key = reviewDomainKey(domain.value);
  const initial = {
    domain: domain.value,
    name: name?.value ?? '',
    platform: platform?.value ?? '',
    linkedinUrl: linkedin?.value ?? '',
    tags: tagResult.tags
  };
  return {
    id: `${sourcePath}:${index}`,
    included: Boolean(key),
    ...initial,
    editedFields: [],
    original: { ...initial, tags: [...initial.tags] },
    sourcePath,
    sourceFields: {
      domain: domain.field,
      ...(name ? { name: name.field } : {}),
      ...(platform ? { platform: platform.field } : {}),
      ...(linkedin ? { linkedinUrl: linkedin.field } : {}),
      ...(tagResult.field ? { tags: tagResult.field } : {})
    },
    contactEvidence: {
      names: stringsFrom(record, ['contact_names', 'contactNames', 'contacts']),
      emails: stringsFrom(record, ['emails', 'contact_emails', 'contactEmails', 'email']),
      phones: stringsFrom(record, ['phones', 'phone_numbers', 'phoneNumbers', 'phone'])
    },
    issues: key ? [] : ['Domain could not be recognized as a public company domain.']
  };
}

function rowsFromJson(value: unknown, sourcePath: string): PreparedAccountRow[] {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (() => {
          const root = value as Record<string, unknown>;
          if (Array.isArray(root.accounts)) return root.accounts;
          if (Array.isArray(root.candidates)) return root.candidates;
          return [root];
        })()
      : [];
  return values
    .map((entry, index) => compactRow(entry, sourcePath, index))
    .filter((row): row is PreparedAccountRow => Boolean(row));
}

async function scanJsonFiles(
  files: readonly AccountImportFileLike[]
): Promise<{ rows: PreparedAccountRow[]; inspected: number; usedFiles: string[] }> {
  const rows: PreparedAccountRow[] = [];
  const usedFiles: string[] = [];
  let inspected = 0;
  for (const file of files) {
    if (rows.length >= MAX_ACCOUNTS) break;
    if (!file.name.toLowerCase().endsWith('.json') || file.size > MANIFEST_MAX_BYTES) continue;
    inspected += 1;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const sourcePath = file.webkitRelativePath || file.name;
      const extracted = rowsFromJson(parsed, sourcePath);
      if (extracted.length > 0) usedFiles.push(sourcePath);
      for (const row of extracted) {
        rows.push(row);
        if (rows.length >= MAX_ACCOUNTS) break;
      }
    } catch {
      // Folder uploads commonly contain unrelated or partial artifacts. A bad
      // candidate manifest stays local; the review only shows data we can point
      // back to an exact source field.
    }
  }
  return { rows, inspected, usedFiles };
}

export function reviewPreparedRows(rows: readonly PreparedAccountRow[]): PreparedAccountRow[] {
  const firstByDomain = new Map<string, string>();
  return rows.map((row) => {
    const key = reviewDomainKey(row.domain);
    if (!key) {
      return {
        ...row,
        included: false,
        issues: ['Domain could not be recognized as a public company domain.']
      };
    }
    const first = firstByDomain.get(key);
    if (first) {
      return {
        ...row,
        included: false,
        issues: [`Duplicate of another uploaded row (${key}).`]
      };
    }
    firstByDomain.set(key, row.id);
    return { ...row, issues: [] };
  });
}

export function serializePreparedAccountRows(rows: readonly PreparedAccountRow[]): string {
  const accounts = rows
    .filter((row) => row.included)
    .map((row) => {
      const compact: Record<string, unknown> = { domain: row.domain.trim() };
      if (row.name.trim()) compact.name = row.name.trim();
      if (row.linkedinUrl.trim()) compact.linkedinUrl = row.linkedinUrl.trim();
      const tags = row.platform.trim()
        ? row.tags.filter((tag) => !tag.toLowerCase().startsWith('platform:'))
        : [...row.tags];
      if (row.platform.trim()) tags.push(`platform:${row.platform.trim().toLowerCase()}`);
      const dedupedTags = [
        ...new Map(tags.filter(Boolean).map((tag) => [tag.toLowerCase(), tag])).values()
      ];
      if (dedupedTags.length > 0) compact.tags = dedupedTags;
      return compact;
    });
  return JSON.stringify({ accounts }, null, 2);
}
/**
 * Prepare one file or an entire selected folder for the existing account import.
 *
 * A single file remains transparent: its exact text is shown and sent unchanged.
 * A folder is distilled locally into an editable review. We first inspect small
 * JSON files whose names look like company manifests (e.g. `domain_summary.json`),
 * then fall back to all small JSON only if those yielded no companies. Product
 * and catalog artifacts therefore never leave the browser merely because they
 * sat beside a manifest.
 */
export async function prepareAccountFiles(
  files: readonly AccountImportFileLike[],
  mode: 'file' | 'folder'
): Promise<PreparedAccountFiles> {
  if (files.length === 0) throw new Error('Choose at least one file.');
  if (mode === 'file' && files.length === 1) {
    const file = files[0];
    if (file.size > SINGLE_FILE_MAX_BYTES)
      throw new Error('That file is larger than 5 MB. Split it into smaller imports.');
    return {
      text: await file.text(),
      rows: [],
      accountCount: 0,
      inspectedFiles: 1,
      ignoredFiles: 0,
      usedFiles: [file.name],
      summary: `${file.name} loaded. Review it below, then import.`
    };
  }

  if (files.length > MAX_FOLDER_FILES) {
    throw new Error(
      `That folder contains more than ${MAX_FOLDER_FILES.toLocaleString()} files. Select a smaller folder or export the company manifests only.`
    );
  }

  const jsonFiles = files.filter(
    (file) => file.name.toLowerCase().endsWith('.json') && file.size <= MANIFEST_MAX_BYTES
  );
  const hinted = jsonFiles.filter((file) => MANIFEST_NAME_HINT.test(file.name));
  let scanned = await scanJsonFiles(hinted);
  if (scanned.rows.length === 0) scanned = await scanJsonFiles(jsonFiles);

  if (scanned.rows.length === 0) {
    throw new Error(
      'No company manifests were found. Folder import looks for small JSON objects with a top-level domain, website, url, or site field.'
    );
  }

  const rows = reviewPreparedRows(scanned.rows);
  const included = rows.filter((row) => row.included).length;
  const ignoredFiles = Math.max(0, files.length - scanned.inspected);
  return {
    text: serializePreparedAccountRows(rows),
    rows,
    accountCount: included,
    inspectedFiles: scanned.inspected,
    ignoredFiles,
    usedFiles: scanned.usedFiles,
    summary: `${rows.length} row(s) detected from ${scanned.usedFiles.length} source file(s). ${ignoredFiles} other artifact file(s) stayed local and were ignored.`
  };
}
