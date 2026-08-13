import { describe, expect, it } from 'vitest';
import { autoMatchLeadFields, canonicalLinkedInProfileUrl, parseLeadCsv, scrubLeadNamePart } from './lead-import.js';

describe('autoMatchLeadFields', () => {
  it('matches the requested common CSV aliases', () => {
    expect(autoMatchLeadFields(['First Name','surname','Company Name','Email Address','Phone Number','Country','LinkedIn URL']))
      .toEqual({
        firstName: 'First Name', lastName: 'surname', company: 'Company Name', email: 'Email Address',
        phone: 'Phone Number', country: 'Country', linkedinUrl: 'LinkedIn URL'
      });
  });

  it('normalizes separators and BOM without changing the source header it returns', () => {
    expect(autoMatchLeadFields(['\uFEFFfirst_name', 'family-name', 'organisation'])).toEqual({
      firstName: '\uFEFFfirst_name', lastName: 'family-name', company: 'organisation'
    });
  });

  it('leaves unknown columns unmapped instead of guessing', () => {
    expect(autoMatchLeadFields(['Person', 'Business', 'Notes'])).toEqual({});
  });
});

describe('scrubLeadNamePart', () => {
  it('removes requested titles, degrees, punctuation and emoji', () => {
    expect(scrubLeadNamePart('Dr. Maya 🙂, MBA')).toBe('Maya');
    expect(scrubLeadNamePart('Prof. John 💪 Smith, PhD!')).toBe('John Smith');
  });
  it('matches stop tokens case-insensitively', () => {
    expect(scrubLeadNamePart('MRS Jane CEO')).toBe('Jane');
    expect(scrubLeadNamePart('Alex SR')).toBe('Alex');
  });
  it('never removes stop-token substrings from legitimate names', () => {
    expect(scrubLeadNamePart('Maya')).toBe('Maya');
    expect(scrubLeadNamePart('Mason')).toBe('Mason');
    expect(scrubLeadNamePart('Doctorow')).toBe('Doctorow');
  });
  it('preserves apostrophes and hyphens and collapses whitespace', () => {
    expect(scrubLeadNamePart("  Dr.  Anne-Marie   O'Neill  ")).toBe("Anne-Marie O'Neill");
  });
});

describe('parseLeadCsv', () => {
  it('parses BOM, quoted commas, automaps fields and retains raw audit values', () => {
    const result = parseLeadCsv('\uFEFFFirst Name,Last Name,Company Name,Email Address,LinkedIn URL\n"Dr. Maya 🙂, MBA",Chen,"Acme, Inc",Maya@Example.com,https://linkedin.com/in/maya-chen');
    expect(result.totalRows).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      firstName: 'Maya', lastName: 'Chen', company: 'Acme, Inc', email: 'maya@example.com',
      linkedinUrl: 'https://www.linkedin.com/in/maya-chen/'
    });
    expect(result.rows[0].raw['First Name']).toBe('Dr. Maya 🙂, MBA');
  });

  it('returns row-level required-field errors without dropping other valid rows', () => {
    const result = parseLeadCsv('first,last,company\nMaya,Chen,Acme\nDr.,Rossi,Luma');
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ row: 3, field: 'firstName' })
    ]);
  });

  it('accepts manual mapping overrides and validates duplicate mappings', () => {
    const csv = 'given,business,family\nMaya,Acme,Chen';
    const result = parseLeadCsv(csv, { firstName: 'given', lastName: 'family', company: 'business' });
    expect(result.rows[0]).toMatchObject({ firstName: 'Maya', lastName: 'Chen', company: 'Acme' });
    expect(() => parseLeadCsv(csv, { firstName: 'given', lastName: 'given', company: 'business' })).toThrow(/mapped more than once/);
  });

  it('refuses malformed LinkedIn profile URLs when one was supplied', () => {
    const result = parseLeadCsv('first,last,company,linkedin\nMaya,Chen,Acme,https://evil.example/in/maya');
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toMatchObject({ field: 'linkedinUrl' });
  });
});

describe('canonicalLinkedInProfileUrl', () => {
  it('canonicalizes profile URLs and strips tracking', () => {
    expect(canonicalLinkedInProfileUrl('linkedin.com/in/Maya-Chen/?trk=abc')).toBe('https://www.linkedin.com/in/Maya-Chen/');
  });
  it('does not turn arbitrary URLs into LinkedIn identities', () => {
    expect(canonicalLinkedInProfileUrl('https://example.com/in/maya')).toBeNull();
  });
});
