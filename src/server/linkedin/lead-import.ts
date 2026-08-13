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
