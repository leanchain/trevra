export interface AccountImportFileLike {
  name: string;
  size: number;
  /** Browser directory uploads expose this; tests and single-file imports may omit it. */
  webkitRelativePath?: string;
  text(): Promise<string>;
}

export interface PreparedAccountFiles {
  text: string;
  accountCount: number;
  inspectedFiles: number;
  ignoredFiles: number;
  /** Human-readable summary shown before the operator presses Import. */
  summary: string;
}

const SINGLE_FILE_MAX_BYTES = 5_000_000;
const MANIFEST_MAX_BYTES = 1_000_000;
const MAX_FOLDER_FILES = 20_000;
const MAX_ACCOUNTS = 2_000;

const MANIFEST_NAME_HINT =
  /(^|[_-])(summary|summaries|account|accounts|company|companies|prospect|prospects|lead|leads|store|stores|shop|shops)([_-]|\.|$)/i;

function nonEmptyString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function tagsFrom(record: Record<string, unknown>): string[] {
  const raw = record.tags ?? record.labels;
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
  const platform = nonEmptyString(record, ['platform']);
  if (platform) tags.push(`platform:${platform.toLowerCase()}`);
  return [...new Map(tags.map((tag) => [tag.toLowerCase(), tag])).values()];
}

function compactAccount(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const domain = nonEmptyString(record, ['domain', 'website', 'url', 'site']);
  if (!domain) return null;
  const name = nonEmptyString(record, [
    'name',
    'company',
    'account',
    'organisation',
    'organization'
  ]);
  const linkedin = nonEmptyString(record, ['linkedinUrl', 'linkedin_url', 'linkedin']);
  const compact: Record<string, unknown> = { domain };
  if (name) compact.name = name;
  if (linkedin) compact.linkedinUrl = linkedin;
  const tags = tagsFrom(record);
  if (tags.length > 0) compact.tags = tags;
  return compact;
}

function accountsFromJson(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value
      .map(compactAccount)
      .filter((value): value is Record<string, unknown> => Boolean(value));
  if (!value || typeof value !== 'object') return [];
  const root = value as Record<string, unknown>;
  const envelope = Array.isArray(root.accounts)
    ? root.accounts
    : Array.isArray(root.candidates)
      ? root.candidates
      : null;
  if (envelope)
    return envelope
      .map(compactAccount)
      .filter((value): value is Record<string, unknown> => Boolean(value));
  const one = compactAccount(root);
  return one ? [one] : [];
}

async function scanJsonFiles(
  files: readonly AccountImportFileLike[]
): Promise<{ accounts: Record<string, unknown>[]; inspected: number }> {
  const accounts: Record<string, unknown>[] = [];
  let inspected = 0;
  for (const file of files) {
    if (accounts.length >= MAX_ACCOUNTS) break;
    if (!file.name.toLowerCase().endsWith('.json') || file.size > MANIFEST_MAX_BYTES) continue;
    inspected += 1;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      for (const account of accountsFromJson(parsed)) {
        accounts.push(account);
        if (accounts.length >= MAX_ACCOUNTS) break;
      }
    } catch {
      // Folder uploads commonly contain unrelated or partial artifacts. A bad
      // candidate manifest is ignored here; the server still validates every
      // compact account we do emit before writing anything.
    }
  }
  return { accounts, inspected };
}

/**
 * Prepare one file or an entire selected folder for the existing account import.
 *
 * A single file remains transparent: its exact text is shown and sent unchanged.
 * A folder is distilled locally. We first inspect small JSON files whose names
 * look like company manifests (e.g. `domain_summary.json`), then fall back to
 * all small JSON only if those yielded no companies. Product/catalog artifacts
 * therefore never leave the browser merely because they sat beside a manifest.
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
      accountCount: 0,
      inspectedFiles: 1,
      ignoredFiles: 0,
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
  if (scanned.accounts.length === 0) scanned = await scanJsonFiles(jsonFiles);

  const deduped = new Map<string, Record<string, unknown>>();
  for (const account of scanned.accounts) {
    const raw = typeof account.domain === 'string' ? account.domain.trim().toLowerCase() : '';
    if (!raw || deduped.has(raw)) continue;
    deduped.set(raw, account);
    if (deduped.size >= MAX_ACCOUNTS) break;
  }
  if (deduped.size === 0) {
    throw new Error(
      'No company manifests were found. Folder import looks for small JSON objects with a top-level domain, website, url, or site field.'
    );
  }

  const accounts = [...deduped.values()];
  return {
    text: JSON.stringify({ accounts }, null, 2),
    accountCount: accounts.length,
    inspectedFiles: scanned.inspected,
    ignoredFiles: Math.max(0, files.length - scanned.inspected),
    summary: `${accounts.length} account(s) prepared from ${scanned.inspected} manifest file(s). ${Math.max(0, files.length - scanned.inspected)} other artifact file(s) stayed local and were ignored.`
  };
}
