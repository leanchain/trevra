import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { profileUrlFor } from './driver.js';

export const LEAD_FIELDS = [
  'firstName',
  'lastName',
  'company',
  'email',
  'phone',
  'country',
  'profileUrl'
] as const;
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
  /** Which of `mapping`'s fields came from an exact alias hit vs. a fuzzy guess, for the fields automatch chose. Absent for a field the caller's own override supplied. */
  mappingConfidence: Partial<Record<LeadField, FieldMatchConfidence>>;
  accepted: NormalizedLeadInput[];
  rejected: RejectedLeadRow[];
}

const FIELD_ALIASES: Record<LeadField, readonly string[]> = {
  firstName: ['first', 'firstname', 'givenname', 'given', 'first_name', 'first name'],
  lastName: ['last', 'lastname', 'surname', 'familyname', 'family', 'last_name', 'last name'],
  company: [
    'company',
    'companyname',
    'employer',
    'organization',
    'organisation',
    'account',
    'business',
    'businessname',
    'business name'
  ],
  email: ['email', 'emailaddress', 'mail', 'workemail', 'work_email'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'telephone', 'tel'],
  country: ['country', 'countryname', 'locationcountry', 'nation'],
  profileUrl: [
    'linkedin',
    'linkedinurl',
    'linkedinprofile',
    'linkedinprofileurl',
    'profileurl',
    'profile_url',
    'linkedin_url'
  ]
};

const SCRUB_TOKENS = new Set([
  'mr',
  'ms',
  'mrs',
  'miss',
  'jr',
  'sr',
  'snr',
  'jnr',
  'prof',
  'professor',
  'dr',
  'drs',
  'doc',
  'doctor',
  'phd',
  'ba',
  'bfa',
  'bs',
  'ma',
  'mba',
  'mfa',
  'jd',
  'md',
  'do',
  'ceo',
  'lion',
  'lme',
  'lmt',
  'mim',
  'msc',
  'sip',
  'rpm'
]);

function headerKey(value: string): string {
  return value
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function aliasesFor(field: LeadField): Set<string> {
  return new Set(FIELD_ALIASES[field].map(headerKey));
}

/** How a field ended up mapped: an exact alias hit, or a fuzzy guess worth flagging for review. */
export type FieldMatchConfidence = 'exact' | 'guessed';

/** Classic edit distance. Headers and aliases are both short (a handful of words at most), so the O(n*m) table is not a cost worth avoiding. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * How alike a normalized header is to a normalized alias, from 0 to 1.
 *
 * CONTAINMENT IS SCORED SEPARATELY FROM EDIT DISTANCE, not folded into it.
 * "businessname" containing "business" is a strong signal a plain distance
 * ratio undersells (six characters differ from "company", nowhere near a typo),
 * so containment gets its own floor, scaled by how much of the longer string
 * the shorter one actually covers -- "e" is technically contained in "email"
 * and must not pass on that alone.
 */
function headerSimilarity(header: string, alias: string): number {
  if (!header || !alias) return 0;
  if (header === alias) return 1;
  if (header.includes(alias) || alias.includes(header)) {
    const shorter = Math.min(header.length, alias.length);
    const longer = Math.max(header.length, alias.length);
    return 0.7 + 0.3 * (shorter / longer);
  }
  const distance = levenshtein(header, alias);
  return 1 - distance / Math.max(header.length, alias.length);
}

/** Below this, a header is left unmapped rather than guessed at -- the same outcome as today for anything unrecognisable. */
const FUZZY_MATCH_THRESHOLD = 0.72;

/**
 * Automapping, in two passes, with a confidence tag riding along.
 *
 * PASS ONE IS THE ORIGINAL EXACT-ALIAS MATCH, UNCHANGED, so every header that
 * already worked keeps matching the same way. PASS TWO only looks at headers
 * still unclaimed after pass one, and only accepts a guess that clears
 * `FUZZY_MATCH_THRESHOLD` -- "Business Name" now reaches `company`, a typo'd
 * "Buisness" still reaches it, and something with nothing in common with any
 * alias stays unmapped, same as before this existed.
 *
 * A HEADER CLAIMED BY ONE FIELD IS REMOVED FROM THE POOL for every field after
 * it, in both passes -- so two fields can never point at the same column, exact
 * or guessed.
 */
export function autoMatchLeadFieldsWithConfidence(headers: readonly string[]): {
  mapping: LeadFieldMapping;
  confidence: Partial<Record<LeadField, FieldMatchConfidence>>;
} {
  const mapping: LeadFieldMapping = {};
  const confidence: Partial<Record<LeadField, FieldMatchConfidence>> = {};
  const claimed = new Set<string>();

  for (const field of LEAD_FIELDS) {
    const aliases = aliasesFor(field);
    const match = headers.find((header) => !claimed.has(header) && aliases.has(headerKey(header)));
    if (match) {
      mapping[field] = match;
      confidence[field] = 'exact';
      claimed.add(match);
    }
  }

  for (const field of LEAD_FIELDS) {
    if (mapping[field]) continue;
    const aliasKeys = FIELD_ALIASES[field].map(headerKey);
    let best: { header: string; score: number } | null = null;
    for (const header of headers) {
      if (claimed.has(header)) continue;
      const key = headerKey(header);
      if (!key) continue;
      const score = Math.max(...aliasKeys.map((alias) => headerSimilarity(key, alias)));
      if (score >= FUZZY_MATCH_THRESHOLD && (!best || score > best.score)) best = { header, score };
    }
    if (best) {
      mapping[field] = best.header;
      confidence[field] = 'guessed';
      claimed.add(best.header);
    }
  }

  return { mapping, confidence };
}

/** Deterministic first-match automapping. A user override always wins later. Kept as the plain-mapping entry point; see `autoMatchLeadFieldsWithConfidence` for the fuzzy pass and its confidence tags. */
export function autoMatchLeadFields(headers: readonly string[]): LeadFieldMapping {
  return autoMatchLeadFieldsWithConfidence(headers).mapping;
}

/**
 * EVERYTHING IN A DISPLAY NAME THAT IS DECORATION RATHER THAN A NAME.
 *
 * `\p{Extended_Pictographic}` ALONE WAS NOT ENOUGH, and the gap was not an
 * exotic one. A FLAG is a pair of REGIONAL INDICATORS (U+1F1E6..U+1F1FF) and
 * those carry Extended_Pictographic=No, so `Maya \u{1F1FA}\u{1F1F8} Chen` came
 * through this function completely unchanged and was stored with a surname of
 * "\u{1F1FA}\u{1F1F8} Chen" -- rendered verbatim into `Hi {{firstName}}`. Flags
 * in a LinkedIn display name are ordinary, not rare.
 *
 * THREE MORE SHAPES MISS THE PICTOGRAPHIC PROPERTY FOR THE SAME REASON and are
 * matched here explicitly:
 *
 *   * KEYCAPS. `1️⃣` is the PLAIN DIGIT `1` plus a variation selector
 *     plus the enclosing-keycap mark. Removing only the two combining marks
 *     would leave a bare `1` sitting inside the name, so the whole sequence is
 *     one alternative and it is matched FIRST, before the digit can survive.
 *   * TAG SEQUENCES. `\u{1F3F4}\u{E0067}...\u{E007F}` is a pictographic base
 *     followed by six INVISIBLE tag characters; strip the base alone and the
 *     tags stay in the string.
 *   * MISCELLANEOUS SYMBOLS used as decoration -- the `▸ ✦ ➤
 *     ▪` a headline is padded with. They are Symbol/other, not
 *     pictographs.
 *
 * `\p{So}` is the honest generalisation of the last case and it subsumes the
 * regional indicators too: it is every "other symbol" in Unicode and it
 * contains no letter in any script. Letters, marks and CJK are untouched, so
 * `Anne-Marie`, `Núñez` and `陈` survive it intact.
 */
const NAME_DECORATION =
  /[#*0-9]️?⃣|\p{Extended_Pictographic}|\p{So}|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]|[︎️‍⃣]/gu;

/** The punctuation the brief names -- `.`, `,`, `?`, `!` -- and nothing else. */
const NAME_PUNCTUATION = /[.,?!]/g;
const NAME_PUNCTUATION_SPLIT = /[.,?!]+/;

/**
 * A display name as a list of name parts. `dropTitles` applies the 33-token
 * table; false gives the same parse with every token kept.
 *
 * TOKENISE FIRST, THEN TAKE THE PUNCTUATION OUT OF EACH TOKEN. The order is
 * the whole fix. Replacing `.,?!` with spaces BEFORE the split turned `Ph.D.`
 * into `Ph` and `D`, `M.B.A.` into `M`, `B`, `A`, and `M.D.` into `M` and `D` --
 * and not one of those fragments is in the table, so every DOTTED title
 * survived a scrub whose entire job was to remove it. "Chen Ph D" was stored
 * under a UI that promises PhD/MBA/MSc are taken off.
 *
 * A token is therefore compacted (`Ph.D.` -> `PhD`) and looked up WHOLE. Only
 * when the whole token is not itself a title is it split on its punctuation,
 * which is what still reads `Dr.Jane` and `Smith,MBA` -- one whitespace token
 * holding two words -- as the two words they are.
 */
function nameTokens(value: string, dropTitles: boolean): string[] {
  const parts: string[] = [];
  for (const raw of value.normalize('NFKC').replace(NAME_DECORATION, ' ').split(/\s+/)) {
    if (!raw) continue;
    const compact = raw.replace(NAME_PUNCTUATION, '');
    if (!compact) continue;
    if (dropTitles && SCRUB_TOKENS.has(compact.toLowerCase())) continue;
    for (const piece of raw.split(NAME_PUNCTUATION_SPLIT)) {
      const part = piece.trim();
      if (!part) continue;
      if (dropTitles && SCRUB_TOKENS.has(part.toLowerCase())) continue;
      parts.push(part);
    }
  }
  return parts;
}

/**
 * Remove titles/degrees/emoji without substring damage. `ma` is a removable
 * token; the same letters inside `Maya` are not.
 */
export function scrubLeadName(value: string): string {
  return nameTokens(typeof value === 'string' ? value : '', true).join(' ');
}

/**
 * The scrub for a DEDICATED first- or last-name column, which may never empty
 * one.
 *
 * THE TABLE IS A LIST OF TITLES AND IT IS ALSO A LIST OF SURNAMES. `Do`, `Ma`,
 * `Ba`, `Bs`, `Sr` and `Lion` are all in it, and they are all real family
 * names: Anh Do, Yo-Yo Ma. Applied to a JOINED display name that is a
 * defensible gamble -- "Maya Chen, MBA" almost never means a Ms. MBA. Applied
 * to a column whose HEADER already said "Last name", it is not a gamble at
 * all: the operator has already told us this string is a name, and scrubbing
 * it to nothing made `normalizeLeadRow` throw "Missing required last name" at
 * a row that was perfectly correct.
 *
 * So a dedicated column falls back to ITS OWN VALUE, decoration and punctuation
 * still gone, whenever the token table would have left it empty. A field that
 * was empty to begin with stays empty and is still refused upstream.
 */
export function scrubNameField(value: string): string {
  const raw = typeof value === 'string' ? value : '';
  const scrubbed = nameTokens(raw, true).join(' ');
  return scrubbed || nameTokens(raw, false).join(' ');
}

/**
 * One display name -> a scrubbed first and last name.
 *
 * THE ONE SPLITTER, SHARED BY THE CSV IMPORT AND EVERY SCRAPE. A LinkedIn card
 * shows "Dr. Maya Chen, MBA 🙂" as a single string; a CSV shows the same person
 * as two columns. Both end up in the same `linkedin_lead_contacts` row and both
 * end up in the same `{{firstName}}` in a template, so both go through the same
 * scrub -- otherwise the harvested copy of a person an operator also uploaded
 * is a DIFFERENT person as far as the dedupe key is concerned.
 *
 * FIRST TOKEN, THEN EVERYTHING ELSE. "Maria del Carmen Rossi" keeps "del Carmen
 * Rossi" together rather than dropping the particles: a surname is whatever is
 * left after the given name, and picking the LAST token would rename half of
 * Latin America and most of the Netherlands.
 *
 * A name that scrubs away to nothing gives two empty strings rather than a
 * throw -- the caller decides whether a nameless row is still a lead.
 */
export function splitAndScrubName(raw: string): { firstName: string; lastName: string } {
  const clean = scrubLeadName(typeof raw === 'string' ? raw : '');
  if (!clean) return { firstName: '', lastName: '' };
  const parts = clean.split(' ');
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
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

/**
 * The identity a lead is deduplicated on. EXPORTED so the scraped path can set
 * it the same way the CSV path does -- two writers computing "the same person"
 * two ways is how one human ends up in two campaigns.
 */
export function leadDedupeKey(
  input: Pick<NormalizedLeadInput, 'firstName' | 'lastName' | 'company' | 'email' | 'profileUrl'>
): string {
  const identity = input.profileUrl
    ? `linkedin:${input.profileUrl.toLowerCase()}`
    : input.email
      ? `email:${input.email.toLowerCase()}`
      : `name:${input.firstName.toLowerCase()}|${input.lastName.toLowerCase()}|${input.company.toLowerCase()}`;
  return createHash('sha256').update(identity).digest('hex');
}

export function normalizeLeadRow(
  row: Record<string, string>,
  mapping: LeadFieldMapping
): NormalizedLeadInput {
  const read = (field: LeadField): string => {
    const header = mapping[field];
    return header ? String(row[header] ?? '') : '';
  };
  // DEDICATED COLUMNS, so the scrub may not empty them: see `scrubNameField`.
  const firstName = scrubNameField(read('firstName'));
  const lastName = scrubNameField(read('lastName'));
  const company = read('company').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!firstName || !lastName || !company) {
    const missing = [!firstName && 'first name', !lastName && 'last name', !company && 'company']
      .filter(Boolean)
      .join(', ');
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
  lead.dedupeKey = leadDedupeKey(lead);
  return lead;
}

/** A harvested person, as `linkedin_leads` stored them. */
export interface ScrapedLeadRecord {
  profileUrl: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  company?: string | null;
  postUrl?: string | null;
  interactionKind?: string | null;
}

/**
 * A harvested lead in the shape the contacts table takes, or null.
 *
 * SEPARATE FROM `normalizeLeadRow` AND DELIBERATELY MORE FORGIVING ABOUT ONE
 * FIELD. A CSV row without a company is a row the operator can go and fix, so
 * it is rejected. A search card without one is the NORMAL case -- post engagers
 * have no company field at all -- and rejecting those would mean keyword
 * discovery could never feed a campaign, which is the entire point of it.
 *
 * A NAMELESS ROW IS STILL REJECTED, because the first thing a campaign does
 * with a contact is put their first name in a message, and "Hi ," is worse
 * than one fewer lead. The profile URL is likewise required: a lead we cannot
 * address is not a lead.
 *
 * Everything the contacts table has no column for -- the headline, the post,
 * the interaction -- is kept in `original`, so "where did this person come
 * from" still has an answer after the source rows are pruned.
 */
export function normalizeScrapedLead(input: ScrapedLeadRecord): NormalizedLeadInput | null {
  const profileUrl = canonicalProfileUrl(input.profileUrl);
  if (!profileUrl) return null;
  const split =
    input.firstName || input.lastName
      ? {
          firstName: scrubNameField(input.firstName ?? ''),
          lastName: scrubNameField(input.lastName ?? '')
        }
      : splitAndScrubName(input.name ?? '');
  if (!split.firstName) return null;
  const company = (input.company ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const original: Record<string, string> = { profileUrl };
  if (input.name) original.name = input.name;
  if (input.headline) original.headline = input.headline;
  if (input.postUrl) original.postUrl = input.postUrl;
  if (input.interactionKind) original.interactionKind = input.interactionKind;
  const lead: NormalizedLeadInput = {
    firstName: split.firstName,
    lastName: split.lastName,
    company,
    email: null,
    phone: null,
    country: null,
    profileUrl,
    dedupeKey: '',
    original
  };
  lead.dedupeKey = leadDedupeKey(lead);
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
  const { mapping: auto, confidence: mappingConfidence } =
    autoMatchLeadFieldsWithConfidence(headers);
  const mapping: LeadFieldMapping = { ...auto, ...override };
  for (const required of ['firstName', 'lastName', 'company'] as const) {
    if (!mapping[required])
      throw new Error(`Could not map required field '${required}'. Choose a CSV column for it.`);
    if (!headers.includes(mapping[required] as string))
      throw new Error(`Mapped column '${mapping[required]}' does not exist in this CSV.`);
  }
  for (const [field, header] of Object.entries(mapping)) {
    if (header && !headers.includes(header))
      throw new Error(`Mapped column '${header}' for ${field} does not exist in this CSV.`);
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
      rejected.push({
        row: index + 2,
        reason: cause instanceof Error ? cause.message : String(cause),
        original: row
      });
    }
  });
  return { headers, mapping, mappingConfidence, accepted, rejected };
}
