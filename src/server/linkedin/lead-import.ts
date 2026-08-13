import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { profileUrlFor } from './driver.js';

export const LEAD_FIELDS = ['firstName', 'lastName', 'company', 'email', 'phone', 'country', 'profileUrl'] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

export interface LeadFieldMapping {
  firstName?: string;
  lastName?: string;
  company?: string;
  email?: string;
  phone?: string;
  country?: string;
  profileUrl?: string;
}

export interface NormalizedLeadInput {
  firstName: string;
  lastName: string;
  company: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  profileUrl: string | null;
  dedupeKey: string;
  original: Record<string, string>;
}

export interface RejectedLeadRow {
  row: number;
  reason: string;
  original: Record<string, string>;
}

export interface LeadCsvPreview {
  headers: string[];
  mapping: LeadFieldMapping;
  accepted: NormalizedLeadInput[];
  rejected: RejectedLeadRow[];
}

const FIELD_ALIASES: Record<LeadField, readonly string[]> = {
  firstName: ['first', 'firstname', 'givenname', 'given', 'first_name', 'first name'],
  lastName: ['last', 'lastname', 'surname', 'familyname', 'family', 'last_name', 'last name'],
  company: ['company', 'companyname', 'employer', 'organization', 'organisation', 'account'],
  email: ['email', 'emailaddress', 'mail', 'workemail', 'work_email'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'telephone', 'tel'],
  country: ['country', 'countryname', 'locationcountry', 'nation'],
  profileUrl: ['linkedin', 'linkedinurl', 'linkedinprofile', 'linkedinprofileurl', 'profileurl', 'profile_url', 'linkedin_url']
};

const SCRUB_TOKENS = new Set([
  'mr', 'ms', 'mrs', 'miss', 'jr', 'sr', 'snr', 'jnr', 'prof', 'professor', 'dr', 'drs', 'doc', 'doctor',
  'phd', 'ba', 'bfa', 'bs', 'ma', 'mba', 'mfa', 'jd', 'md', 'do', 'ceo', 'lion', 'lme', 'lmt', 'mim', 'msc',
  'sip', 'rpm'
]);

function headerKey(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function aliasesFor(field: LeadField): Set<string> {
  return new Set(FIELD_ALIASES[field].map(headerKey));
}

/** Deterministic first-match automapping. A user override always wins later. */
export function autoMatchLeadFields(headers: readonly string[]): LeadFieldMapping {
  const result: LeadFieldMapping = {};
  for (const field of LEAD_FIELDS) {
    const aliases = aliasesFor(field);
    const match = headers.find((header) => aliases.has(headerKey(header)));
    if (match) result[field] = match;
  }
  return result;
}

/**
 * Remove titles/degrees/emoji without substring damage. `ma` is a removable
 * token; the same letters inside `Maya` are not.
 */
export function scrubLeadName(value: string): string {
  const withoutEmoji = value
    .normalize('NFKC')
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, ' ')
    .replace(/[.,?!]+/g, ' ');
  return withoutEmoji
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !SCRUB_TOKENS.has(part.toLowerCase()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nullable(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return text || null;
}

function normalizeEmail(value: unknown): string | null {
  const email = nullable(value)?.toLowerCase() ?? null;
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function canonicalProfileUrl(value: unknown): string | null {
  const raw = nullable(value);
  if (!raw) return null;
  const safe = profileUrlFor(raw);
  if (!safe) return null;
  const parsed = new URL(safe);
  const match = /^\/in\/([^/]+)\/?$/i.exec(parsed.pathname);
  if (!match) return null;
  return `https://www.linkedin.com/in/${match[1]}/`;
}

function dedupeKey(input: Pick<NormalizedLeadInput, 'firstName' | 'lastName' | 'company' | 'email' | 'profileUrl'>): string {
  const identity = input.profileUrl
    ? `linkedin:${input.profileUrl.toLowerCase()}`
    : input.email
      ? `email:${input.email.toLowerCase()}`
      : `name:${input.firstName.toLowerCase()}|${input.lastName.toLowerCase()}|${input.company.toLowerCase()}`;
  return createHash('sha256').update(identity).digest('hex');
}

export function normalizeLeadRow(row: Record<string, string>, mapping: LeadFieldMapping): NormalizedLeadInput {
  const read = (field: LeadField): string => {
    const header = mapping[field];
    return header ? String(row[header] ?? '') : '';
  };
  const firstName = scrubLeadName(read('firstName'));
  const lastName = scrubLeadName(read('lastName'));
  const company = read('company').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!firstName || !lastName || !company) {
    const missing = [!firstName && 'first name', !lastName && 'last name', !company && 'company'].filter(Boolean).join(', ');
    throw new Error(`Missing required ${missing}.`);
  }
  const email = normalizeEmail(read('email'));
  const lead: NormalizedLeadInput = {
    firstName,
    lastName,
    company,
    email,
    phone: nullable(read('phone')),
    country: nullable(read('country')),
    profileUrl: canonicalProfileUrl(read('profileUrl')),
    dedupeKey: '',
    original: { ...row }
  };
  lead.dedupeKey = dedupeKey(lead);
  return lead;
}

export function parseLeadCsv(csv: string, override: LeadFieldMapping = {}): LeadCsvPreview {
  if (!csv.trim()) throw new Error('CSV content is empty.');
  const records = parse(csv, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false
  }) as Array<Record<string, string>>;
  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  if (headers.length === 0) throw new Error('CSV needs a header row.');
  const auto = autoMatchLeadFields(headers);
  const mapping: LeadFieldMapping = { ...auto, ...override };
  for (const required of ['firstName', 'lastName', 'company'] as const) {
    if (!mapping[required]) throw new Error(`Could not map required field '${required}'. Choose a CSV column for it.`);
    if (!headers.includes(mapping[required] as string)) throw new Error(`Mapped column '${mapping[required]}' does not exist in this CSV.`);
  }
  for (const [field, header] of Object.entries(mapping)) {
    if (header && !headers.includes(header)) throw new Error(`Mapped column '${header}' for ${field} does not exist in this CSV.`);
  }

  const accepted: NormalizedLeadInput[] = [];
  const rejected: RejectedLeadRow[] = [];
  const seen = new Set<string>();
  records.forEach((row, index) => {
    try {
      const lead = normalizeLeadRow(row, mapping);
      if (seen.has(lead.dedupeKey)) {
        rejected.push({ row: index + 2, reason: 'Duplicate lead in this CSV.', original: row });
        return;
      }
      seen.add(lead.dedupeKey);
      accepted.push(lead);
    } catch (cause) {
      rejected.push({ row: index + 2, reason: cause instanceof Error ? cause.message : String(cause), original: row });
    }
  });
  return { headers, mapping, accepted, rejected };
}
