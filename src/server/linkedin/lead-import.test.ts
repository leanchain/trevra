import { describe, expect, it } from 'vitest';
import { autoMatchLeadFields, parseLeadCsv, scrubLeadName } from './lead-import.js';

describe('LinkedIn lead CSV import', () => {
  it('automatches common header spellings', () => {
    expect(autoMatchLeadFields(['First Name', 'Surname', 'Company Name', 'Work Email', 'LinkedIn URL'])).toMatchObject({
      firstName: 'First Name', lastName: 'Surname', company: 'Company Name', email: 'Work Email', profileUrl: 'LinkedIn URL'
    });
  });

  it('scrubs titles, degrees, punctuation and emoji as standalone tokens', () => {
    expect(scrubLeadName('Dr. Maya 🙂 Smith, MBA')).toBe('Maya Smith');
    expect(scrubLeadName("Prof. Anne-Marie O'Connor, PhD")).toBe("Anne-Marie O'Connor");
  });

  it('never removes short credential tokens from inside real names', () => {
    expect(scrubLeadName('Maya Mason')).toBe('Maya Mason');
  });

  it('normalizes, deduplicates and reports rejected rows without aborting the file', () => {
    const csv = [
      'First Name,Last Name,Company,Email,LinkedIn URL',
      'Dr. Maya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-smith/',
      'Maya,Smith,Acme,MAYA@example.com,https://www.linkedin.com/in/maya-smith',
      ',Jones,Widgets,bad,https://linkedin.com/in/jones'
    ].join('\n');
    const result = parseLeadCsv(csv);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ firstName: 'Maya', lastName: 'Smith', company: 'Acme', email: 'maya@example.com' });
    expect(result.rejected.map((row) => row.reason)).toEqual(['Duplicate lead in this CSV.', 'Missing required first name.']);
  });
});
