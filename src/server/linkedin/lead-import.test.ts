import { describe, expect, it } from 'vitest';
import { autoMatchLeadFields, scrubLeadNamePart } from './lead-import.js';

describe('autoMatchLeadFields', () => {
  it('matches the requested common CSV aliases', () => {
    expect(
      autoMatchLeadFields([
        'First Name',
        'surname',
        'Company Name',
        'Email Address',
        'Phone Number',
        'Country',
        'LinkedIn URL'
      ])
    ).toEqual({
      firstName: 'First Name',
      lastName: 'surname',
      company: 'Company Name',
      email: 'Email Address',
      phone: 'Phone Number',
      country: 'Country',
      linkedinUrl: 'LinkedIn URL'
    });
  });

  it('normalizes separators and BOM without changing the source header it returns', () => {
    expect(autoMatchLeadFields(['\uFEFFfirst_name', 'family-name', 'organisation'])).toEqual({
      firstName: '\uFEFFfirst_name',
      lastName: 'family-name',
      company: 'organisation'
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

  it('returns an empty string when the value contained only removable tokens', () => {
    expect(scrubLeadNamePart('Dr., MBA 🙂')).toBe('');
  });
});
