import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { addExclusions, filterExcluded, listExclusions } from './exclusions.js';

// Real ephemeral Postgres, per the repo's test harness: the whole point of
// this module is a SQL match rule, so an in-memory stub would test nothing
// that ships.
let db: Db;

const NOW = new Date('2026-08-06T09:00:00.000Z');
const WORKSPACE_ID = 'ws_linkedin_exclusions_test';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'LinkedIn Exclusions Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_exclusions WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
});

describe('filterExcluded', () => {
  it('matches a harvested URL carrying tracking params against a plain exclusion for the same profile', async () => {
    await addExclusions(
      db,
      WORKSPACE_ID,
      [{ targetRef: 'https://www.linkedin.com/in/jonas', reason: 'Asked to stop' }],
      NOW
    );

    // What a harvested href actually looks like: query params, a
    // miniProfileUrn, a trailing slash -- none of which the operator who typed
    // the plain exclusion above ever saw.
    const harvested =
      'https://www.linkedin.com/in/jonas/?trk=flagship3_search&miniProfileUrn=urn%3Ali%3Afs_miniProfile%3Ajonas';

    const { kept, excluded } = await filterExcluded(db, WORKSPACE_ID, [harvested]);

    expect(kept).toEqual([]);
    expect(excluded).toEqual([{ targetRef: harvested, reason: 'Asked to stop' }]);
  });

  it('matches a bare exclusion handle against the full profile URL for the same person', async () => {
    // Stored as a bare handle, which is what a CSV or a quick manual entry
    // produces.
    await addExclusions(db, WORKSPACE_ID, [{ targetRef: 'sofia', reason: 'Opted out' }], NOW);

    const { kept, excluded } = await filterExcluded(db, WORKSPACE_ID, [
      'https://www.linkedin.com/in/sofia/'
    ]);

    expect(kept).toEqual([]);
    expect(excluded).toEqual([
      { targetRef: 'https://www.linkedin.com/in/sofia/', reason: 'Opted out' }
    ]);
  });

  it('keeps a target that is not on the list', async () => {
    await addExclusions(
      db,
      WORKSPACE_ID,
      [{ targetRef: 'https://www.linkedin.com/in/jonas' }],
      NOW
    );

    const { kept, excluded } = await filterExcluded(db, WORKSPACE_ID, [
      'https://www.linkedin.com/in/maya/'
    ]);

    expect(kept).toEqual(['https://www.linkedin.com/in/maya/']);
    expect(excluded).toEqual([]);
  });
});

describe('addExclusions', () => {
  it('lists what it added, most recent first', async () => {
    await addExclusions(db, WORKSPACE_ID, [{ targetRef: 'maya', reason: 'Asked to stop' }], NOW);
    const list = await listExclusions(db, WORKSPACE_ID);
    expect(list).toHaveLength(1);
    expect(list[0]?.targetRef).toBe('maya');
    expect(list[0]?.reason).toBe('Asked to stop');
  });
});
