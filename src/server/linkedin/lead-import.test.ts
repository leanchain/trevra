import { describe, expect, it } from 'vitest';
import {
  autoMatchLeadFields,
  autoMatchLeadFieldsWithConfidence,
  normalizeScrapedLead,
  parseLeadCsv,
  scrubLeadName,
  scrubNameField,
  splitAndScrubName
} from './lead-import.js';

describe('LinkedIn lead CSV import', () => {
  it('automatches common header spellings', () => {
    expect(
      autoMatchLeadFields(['First Name', 'Surname', 'Company Name', 'Work Email', 'LinkedIn URL'])
    ).toMatchObject({
      firstName: 'First Name',
      lastName: 'Surname',
      company: 'Company Name',
      email: 'Work Email',
      profileUrl: 'LinkedIn URL'
    });
  });

  it('tags an exact alias hit as exact confidence', () => {
    const { mapping, confidence } = autoMatchLeadFieldsWithConfidence([
      'First Name',
      'Last Name',
      'Company Name'
    ]);
    expect(mapping).toMatchObject({
      firstName: 'First Name',
      lastName: 'Last Name',
      company: 'Company Name'
    });
    expect(confidence).toMatchObject({ firstName: 'exact', lastName: 'exact', company: 'exact' });
  });

  it('fuzzy-matches a header that contains a known alias but is not one itself', () => {
    const { mapping, confidence } = autoMatchLeadFieldsWithConfidence(['Employer Name']);
    expect(mapping.company).toBe('Employer Name');
    expect(confidence.company).toBe('guessed');
  });

  it('fuzzy-matches a typo against its alias', () => {
    const { mapping, confidence } = autoMatchLeadFieldsWithConfidence(['Buisness']);
    expect(mapping.company).toBe('Buisness');
    expect(confidence.company).toBe('guessed');
  });

  it('leaves an unrecognisable header unmapped rather than forcing a guess', () => {
    const { mapping, confidence } = autoMatchLeadFieldsWithConfidence(['Favourite Colour']);
    expect(mapping.company).toBeUndefined();
    expect(confidence.company).toBeUndefined();
  });

  it('never lets two fields claim the same header, exact or guessed', () => {
    const { mapping } = autoMatchLeadFieldsWithConfidence(['Company Name', 'Employer Name']);
    const claimed = Object.values(mapping);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('scrubs titles, degrees, punctuation and emoji as standalone tokens', () => {
    expect(scrubLeadName('Dr. Maya 🙂 Smith, MBA')).toBe('Maya Smith');
    expect(scrubLeadName("Prof. Anne-Marie O'Connor, PhD")).toBe("Anne-Marie O'Connor");
  });

  it('never removes short credential tokens from inside real names', () => {
    expect(scrubLeadName('Maya Mason')).toBe('Maya Mason');
  });

  /**
   * THE SCRUBBER, AS A TABLE. Every row here is a shape that reached a stored
   * contact and a rendered `{{firstName}}` before it was fixed.
   */
  it.each([
    // A DOTTED TITLE IS ONE TOKEN. Splitting on the dots first turned `Ph.D.`
    // into `Ph` and `D` and neither is in the 33-token table, so every dotted
    // credential survived the scrub whose job was to remove it.
    ['Chen Ph.D.', 'Chen'],
    ['Maya Chen, M.B.A.', 'Maya Chen'],
    ['Alex Ray M.D.', 'Alex Ray'],
    ['Lee Park B.A.', 'Lee Park'],
    ['Sofia Rossi M.Sc.', 'Sofia Rossi'],
    // A FLAG IS NOT Extended_Pictographic. This one came through untouched.
    ['Maya \u{1F1FA}\u{1F1F8} Chen', 'Maya Chen'],
    // Nor is a keycap, and stripping only its combining marks leaves the digit.
    ['Sam 1️⃣ Ray', 'Sam Ray'],
    // Nor are the tag characters trailing a subdivision flag.
    ['Ann \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} Lee', 'Ann Lee'],
    // Nor the arrows and bullets a headline is padded with.
    ['▸ Ravi ✦ Patel', 'Ravi Patel'],
    ['Dr. Jane Smith \u{1F642}', 'Jane Smith'],
    // One whitespace token holding two words is still two words.
    ['Dr.Jane Smith', 'Jane Smith'],
    // And nothing here touches a letter in any script.
    ["Prof. Anne-Marie O'Connor, PhD", "Anne-Marie O'Connor"],
    ['Maya Mason', 'Maya Mason']
  ])('scrubs %j to %j', (raw, expected) => {
    expect(scrubLeadName(raw)).toBe(expected);
  });

  /**
   * THE TABLE IS ALSO A LIST OF SURNAMES, and a column headed "Last name" has
   * already told us the string is a name. `Anh Do` and `Yo-Yo Ma` were both
   * rejected outright with "Missing required last name".
   */
  it.each([
    ['Do', 'Do'],
    ['Ma', 'Ma'],
    ['Ba', 'Ba'],
    ['Sr', 'Sr'],
    ['Lion', 'Lion'],
    // The decoration and the punctuation still go; only the token table is
    // waived, and only when waiving it is the difference between a name and
    // nothing.
    ['Do \u{1F1FB}\u{1F1F3}', 'Do'],
    ['Chen', 'Chen'],
    ['Chen, PhD', 'Chen'],
    // An empty field is still empty, and is still refused upstream.
    ['', ''],
    ['\u{1F642}', '']
  ])('keeps a dedicated name column %j as %j rather than emptying it', (raw, expected) => {
    expect(scrubNameField(raw)).toBe(expected);
  });

  it('imports the real people the token table used to reject', () => {
    const csv = [
      'First Name,Last Name,Company',
      'Anh,Do,Widgets',
      'Yo-Yo,Ma,Silk Road',
      'Maya \u{1F1FA}\u{1F1F8},Chen Ph.D.,Acme'
    ].join('\n');
    const result = parseLeadCsv(csv);
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((lead) => [lead.firstName, lead.lastName])).toEqual([
      ['Anh', 'Do'],
      ['Yo-Yo', 'Ma'],
      ['Maya', 'Chen']
    ]);
  });

  it("scrubs a harvested card's dedicated halves rather than copying them through", () => {
    const lead = normalizeScrapedLead({
      profileUrl: 'https://www.linkedin.com/in/maya-chen/',
      firstName: 'Dr. Maya',
      lastName: 'Chen \u{1F1FA}\u{1F1F8} Ph.D.'
    });
    expect(lead).toMatchObject({ firstName: 'Maya', lastName: 'Chen' });
    // A one-token surname that IS a title token survives here too.
    expect(
      normalizeScrapedLead({
        profileUrl: 'https://www.linkedin.com/in/anh-do/',
        firstName: 'Anh',
        lastName: 'Do'
      })
    ).toMatchObject({ firstName: 'Anh', lastName: 'Do' });
  });

  it('splits one display name into a scrubbed first and last, for the CSV and the scraper alike', () => {
    expect(splitAndScrubName('Dr. Maya \u{1F642} Chen, MBA')).toEqual({
      firstName: 'Maya',
      lastName: 'Chen'
    });
    expect(splitAndScrubName("Prof. Anne-Marie O'Connor, PhD")).toEqual({
      firstName: 'Anne-Marie',
      lastName: "O'Connor"
    });
    // A surname is whatever is left after the given name. Picking the LAST
    // token would rename half of Latin America and most of the Netherlands.
    expect(splitAndScrubName('Maria del Carmen Rossi')).toEqual({
      firstName: 'Maria',
      lastName: 'del Carmen Rossi'
    });
    expect(splitAndScrubName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
    // A JOINED name stays a gamble and this is the losing side of it: with one
    // string and no column headers, `Ma` is indistinguishable from the degree.
    // The never-empty rule applies to DEDICATED columns, where the operator
    // has already said which half is which -- see `scrubNameField`.
    expect(splitAndScrubName('Yo-Yo Ma')).toEqual({ firstName: 'Yo-Yo', lastName: '' });
    // A name that scrubs away to nothing is two empty strings, not a throw:
    // the caller decides whether a nameless row is still a lead.
    expect(splitAndScrubName('Dr.')).toEqual({ firstName: '', lastName: '' });
    expect(splitAndScrubName('')).toEqual({ firstName: '', lastName: '' });
  });

  it('turns a harvested card into a contact, forgiving a missing company and never a missing name', () => {
    const lead = normalizeScrapedLead({
      profileUrl: 'https://www.linkedin.com/in/maya-smith/?trk=search',
      name: 'Dr. Maya Smith, MBA',
      headline: 'Founder',
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/',
      interactionKind: 'comment'
    });
    expect(lead).toMatchObject({
      firstName: 'Maya',
      lastName: 'Smith',
      profileUrl: 'https://www.linkedin.com/in/maya-smith/'
    });
    // A post engager has no company field at all; rejecting those would mean
    // keyword discovery could never feed a campaign.
    expect(lead?.company).toBe('');
    // The provenance the contacts table has no column for is kept anyway.
    expect(lead?.original).toMatchObject({ interactionKind: 'comment', headline: 'Founder' });
    // IDENTICAL TO THE CSV PATH'S KEY for the same person, which is the only
    // reason a harvested lead and an uploaded one collide at all.
    const csv = parseLeadCsv(
      'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Acme,https://linkedin.com/in/maya-smith/'
    );
    expect(lead?.dedupeKey).toBe(csv.accepted[0].dedupeKey);

    expect(
      normalizeScrapedLead({ profileUrl: 'https://www.linkedin.com/in/x/', name: null })
    ).toBeNull();
    expect(normalizeScrapedLead({ profileUrl: null, name: 'Maya Smith' })).toBeNull();
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
    expect(result.accepted[0]).toMatchObject({
      firstName: 'Maya',
      lastName: 'Smith',
      company: 'Acme',
      email: 'maya@example.com'
    });
    expect(result.rejected.map((row) => row.reason)).toEqual([
      'Duplicate lead in this CSV.',
      'Missing required first name.'
    ]);
  });
});
