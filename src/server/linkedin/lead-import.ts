import { parse } from 'csv-parse/sync';

export const LEAD_IMPORT_FIELDS = [
  'firstName',
  'lastName',
  'company',
  'email',
  'phone',
  'country',
  'linkedinUrl'
] as const;

export type LeadImportField = (typeof LEAD_IMPORT_FIELDS)[number];
export type LeadFieldMapping = Partial<Record<LeadImportField, string>>;

export const REQUIRED_LEAD_IMPORT_FIELDS = ['firstName', 'lastName', 'company'] as const satisfies readonly LeadImportField[];

const FIELD_ALIASES: Readonly<Record<LeadImportField, readonly string[]>> = {
  firstName: ['first', 'firstname', 'givenname', 'forename'],
  lastName: ['last', 'lastname', 'surname', 'familyname'],
  company: ['company', 'companyname', 'employer', 'organization', 'organisation'],
  email: ['email', 'emailaddress', 'emailid'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'telephone'],
  country: ['country', 'countrycode', 'locationcountry'],
  linkedinUrl: ['linkedin', 'linkedinurl', 'linkedinprofile', 'linkedinprofileurl', 'profileurl']
};

export const LEAD_NAME_STOP_TOKENS = new Set([
  'mr', 'ms', 'mrs', 'miss', 'jr', 'sr', 'snr', 'jnr', 'prof', 'professor',
  'dr', 'drs', 'doc', 'doctor', 'phd', 'ba', 'bfa', 'bs', 'ma', 'mba', 'mfa',
  'jd', 'md', 'do', 'ceo', 'lion', 'lme', 'lmt', 'mim', 'msc', 'sip', 'rpm'
]);

const MAX_IMPORT_ROWS = 10_000;

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '');
}

/** Suggest a deterministic one-to-one mapping from CSV headers. */
export function autoMatchLeadFields(headers: readonly string[]): LeadFieldMapping {
  const normalized = headers.map((header) => ({ header, normalized: normalizeHeader(header) }));
  const used = new Set<string>();
  const mapping: LeadFieldMapping = {};

  for (const field of LEAD_IMPORT_FIELDS) {
    const aliases = new Set(FIELD_ALIASES[field]);
    const match = normalized.find((candidate) => !used.has(candidate.header) && aliases.has(candidate.normalized));
    if (!match) continue;
    mapping[field] = match.header;
    used.add(match.header);
  }

  return mapping;
}

/**
 * Clean a first-name or last-name value using the product's explicit rules.
 * Removal is token-based: `MA` can be removed while `Maya` remains intact.
 */
export function scrubLeadNamePart(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\p{Extended_Pictographic}\uFE0E\uFE0F\u200D]+/gu, ' ')
    .replace(/[.,?!]+/g, ' ')
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !LEAD_NAME_STOP_TOKENS.has(token.toLocaleLowerCase('en-US')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.normalize('NFKC').trim();
  return trimmed ? trimmed : null;
}

export function canonicalLinkedInProfileUrl(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const candidate = raw.includes('://') ? raw : `https://${raw}`;
    const url = new URL(candidate);
    const host = url.hostname.toLocaleLowerCase('en-US');
    if (host !== 'linkedin.com' && host !== 'www.linkedin.com') return null;
    const match = /^\/in\/([^/?#]+)\/?$/i.exec(url.pathname);
    if (!match) return null;
    return `https://www.linkedin.com/in/${encodeURIComponent(decodeURIComponent(match[1])).replace(/%2F/gi, '')}/`;
  } catch {
    return null;
  }
}

export interface NormalizedLeadImportRow {
  row: number;
  firstName: string;
  lastName: string;
  company: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  linkedinUrl: string | null;
  raw: Record<string, string>;
}

export interface LeadImportRowError {
  row: number;
  field: LeadImportField | 'row';
  message: string;
  raw: Record<string, string>;
}

export interface LeadCsvPreview {
  headers: string[];
  suggestedMapping: LeadFieldMapping;
  mapping: LeadFieldMapping;
  preview: Record<string, string>[];
  rows: NormalizedLeadImportRow[];
  errors: LeadImportRowError[];
  totalRows: number;
}

function validateMapping(headers: readonly string[], mapping: LeadFieldMapping): void {
  const headerSet = new Set(headers);
  const used = new Set<string>();
  for (const [field, header] of Object.entries(mapping) as Array<[LeadImportField, string | undefined]>) {
    if (!header) continue;
    if (!headerSet.has(header)) throw new Error(`The mapped column '${header}' for ${field} is not present in this CSV.`);
    if (used.has(header)) throw new Error(`The CSV column '${header}' is mapped more than once.`);
    used.add(header);
  }
}

/** Pure preview/normalization. It never writes anything. */
export function parseLeadCsv(
  input: Buffer | string,
  mappingOverride?: LeadFieldMapping,
  options: { maxRows?: number; previewRows?: number } = {}
): LeadCsvPreview {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  const maxRows = Math.max(1, Math.min(MAX_IMPORT_ROWS, Math.trunc(options.maxRows ?? MAX_IMPORT_ROWS)));
  const previewRows = Math.max(1, Math.min(25, Math.trunc(options.previewRows ?? 5)));

  const records = parse(text.replace(/^\uFEFF/, ''), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: false,
    trim: false,
    max_record_size: 256 * 1024
  }) as Record<string, unknown>[];
  if (records.length > maxRows) throw new Error(`This CSV has ${records.length} rows; the import limit is ${maxRows}. Split the file and import it in batches.`);

  const headers = records.length > 0
    ? Object.keys(records[0]).map((header) => header.replace(/^\uFEFF/, ''))
    : firstCsvHeaders(text);
  const suggestedMapping = autoMatchLeadFields(headers);
  const mapping = { ...suggestedMapping, ...(mappingOverride ?? {}) };
  validateMapping(headers, mapping);

  const rows: NormalizedLeadImportRow[] = [];
  const errors: LeadImportRowError[] = [];
  const normalizedRecords = records.map((record) => Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key.replace(/^\uFEFF/, ''), typeof value === 'string' ? value : String(value ?? '')])
  ));

  normalizedRecords.forEach((raw, index) => {
    const rowNumber = index + 2;
    const value = (field: LeadImportField): string | null => {
      const header = mapping[field];
      return header ? clean(raw[header]) : null;
    };
    const firstName = scrubLeadNamePart(value('firstName') ?? '');
    const lastName = scrubLeadNamePart(value('lastName') ?? '');
    const company = value('company') ?? '';
    const emailRaw = value('email');
    const linkedinRaw = value('linkedinUrl');

    const rowErrors: LeadImportRowError[] = [];
    if (!firstName) rowErrors.push({ row: rowNumber, field: 'firstName', message: 'First name is required after name cleanup.', raw });
    if (!lastName) rowErrors.push({ row: rowNumber, field: 'lastName', message: 'Last name is required after name cleanup.', raw });
    if (!company) rowErrors.push({ row: rowNumber, field: 'company', message: 'Company is required.', raw });
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      rowErrors.push({ row: rowNumber, field: 'email', message: 'Email is not in a valid address format.', raw });
    }
    const linkedinUrl = canonicalLinkedInProfileUrl(linkedinRaw);
    if (linkedinRaw && !linkedinUrl) {
      rowErrors.push({ row: rowNumber, field: 'linkedinUrl', message: 'LinkedIn URL must be a linkedin.com/in/... profile URL.', raw });
    }
    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }

    rows.push({
      row: rowNumber,
      firstName,
      lastName,
      company,
      email: emailRaw?.toLocaleLowerCase('en-US') ?? null,
      phone: value('phone'),
      country: value('country'),
      linkedinUrl,
      raw
    });
  });

  return {
    headers,
    suggestedMapping,
    mapping,
    preview: normalizedRecords.slice(0, previewRows),
    rows,
    errors,
    totalRows: normalizedRecords.length
  };
}

function firstCsvHeaders(text: string): string[] {
  if (!text.trim()) return [];
  const first = parse(text.replace(/^\uFEFF/, ''), {
    to_line: 1,
    bom: true,
    relax_column_count: true
  }) as string[][];
  return (first[0] ?? []).map((header) => header.replace(/^\uFEFF/, ''));
}
