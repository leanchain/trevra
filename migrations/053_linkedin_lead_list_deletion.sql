-- Migration 053: a LEAD LIST becomes deletable WITHOUT DELETING THE PEOPLE IN
-- IT.
--
-- THE NOTE MIGRATION 052 LEFT, ANSWERED. 052 split list membership out into
-- `linkedin_lead_list_members` so one person could sit in several lists, and
-- ended with a warning in writing:
--
--     NOTE FOR WHOEVER ADDS "DELETE A LEAD LIST": there is no such path today,
--     and when there is, `linkedin_lead_contacts.list_id` still cascades. A
--     person whose ORIGIN list is deleted would be deleted with it even though
--     they sit in other lists. Repoint the origin (or drop the FK to ON DELETE
--     SET NULL and make the column nullable) before shipping that route.
--
-- This is that change, and the route it unblocks is `deleteLeadList` in
-- src/server/linkedin/lead-lists.ts.
--
-- WHAT THE OLD SHAPE WOULD HAVE DONE. Migration 046 declared the column
-- `NOT NULL REFERENCES linkedin_lead_lists(id) ON DELETE CASCADE`, which was
-- correct when a contact BELONGED to exactly one list. After 052 the column
-- means only "the list this person first arrived in", and a hard owner is the
-- wrong relationship for that fact. Deleting a list would have taken with it:
--
--   * every contact whose origin list it was -- including people in five other
--     lists, which is precisely the case 052 exists to support;
--   * their `linkedin_lead_list_members` rows in those OTHER lists, by cascade,
--     so the other lists would silently shrink;
--   * their `linkedin_campaign_members` rows and `linkedin_manual_tasks`, by
--     cascade, in campaigns that have nothing to do with this list;
--   * and NOT their `linkedin_actions` rows, because `campaign_member_id`
--     carries no foreign key (046 added it as a plain attribution column). The
--     planned and held ones would have survived as orphans pointing at member
--     rows that no longer exist -- and `startManagedCampaign` restores every
--     held row of a campaign to 'planned' in one statement, so a later resume
--     would have sent them. An invite from the customer's own account to
--     somebody the product had already deleted.
--
-- SET NULL, NOT REPOINT. The two options 052 offered are not equivalent.
-- Repointing the origin to some other list the person is in keeps the column
-- non-null at the cost of making it a LIE: it would claim they arrived through
-- a list they were added to later, and for a person whose only list this was
-- there is nothing to repoint to anyway. A null says the true thing -- we no
-- longer know where they came from, because the record of it was deleted --
-- and it is the answer every reader of an origin column can already handle.
-- `LinkedInLeadContact.listId` is typed `string | null` to match.
--
-- =========================================================================
-- WHAT THIS LOCKS, AND FOR HOW LONG
-- =========================================================================
--
-- THIS FILE IS IN THE NON-TRANSACTIONAL LANE (see migrations/README.md), and
-- the marker below is what puts it there. It is here for ONE statement -- the
-- index build -- and everything else in the file is written to be safe without
-- a transaction to fall back on, which is the price of the lane.
--
-- Statement by statement, on a table with millions of rows:
--
--   1. ALTER COLUMN ... DROP NOT NULL -- ACCESS EXCLUSIVE on
--      `linkedin_lead_contacts`, CATALOGUE ONLY. Postgres clears
--      `pg_attribute.attnotnull`; it does not read or rewrite a single heap
--      page. Milliseconds, whatever the row count. Idempotent: dropping a
--      constraint that is not there is a no-op, not an error.
--
--   2. The DO block -- ACCESS EXCLUSIVE on `linkedin_lead_contacts` AND on
--      `linkedin_lead_lists`, because a foreign key locks both ends. CATALOGUE
--      ONLY, and ATOMIC: a `DO` block is one statement, so the DROP and the
--      ADD inside it either both happen or neither does. That matters here
--      more than anywhere else in the file -- in this lane there is no
--      transaction to undo a drop that succeeded before an add that failed,
--      and a contacts table with no foreign key on `list_id` at all is a worse
--      state than either the old shape or the new one.
--
--      `NOT VALID` IS THE LOAD-BEARING WORD. Adding a validated foreign key
--      seq-scans the whole referencing table to prove every existing row
--      satisfies it -- minutes of ACCESS EXCLUSIVE on a big table, and
--      entirely redundant here, because the constraint being replaced enforced
--      the identical reference and every existing row therefore satisfies the
--      new one by construction. NOT VALID skips only that proof: the
--      constraint is fully enforced on every INSERT and UPDATE from this
--      moment, and its ON DELETE SET NULL action fires exactly as a validated
--      one's would. Tidying the catalogue flag later is optional and online:
--
--          ALTER TABLE linkedin_lead_contacts
--            VALIDATE CONSTRAINT linkedin_lead_contacts_list_id_fkey;
--
--      which takes only SHARE UPDATE EXCLUSIVE and does not block writes.
--
--   3. CREATE INDEX CONCURRENTLY -- SHARE UPDATE EXCLUSIVE on
--      `linkedin_lead_contacts`. THIS IS THE ONLY STATEMENT HERE WHOSE COST IS
--      PROPORTIONAL TO THE TABLE, and CONCURRENTLY is why the file gives up
--      its transaction: a plain build takes SHARE and BLOCKS EVERY WRITE to
--      the contacts table for its whole duration, which on a hosted
--      multi-tenant deployment means every tenant's imports stop while one
--      index is built. Concurrently it takes two passes and does not block
--      writes at all.
--
--      The index is needed, not decorative: 052 dropped
--      `idx_linkedin_lead_contacts_list_dedupe`, which was the only index
--      leading with `list_id`, so nothing indexes that column today. ON DELETE
--      SET NULL must find the referencing rows on every list delete, and
--      without an index that is a sequential scan of the entire contacts table
--      per deleted list -- a slow statement holding row locks, on the exact
--      path this migration exists to enable.
--
--      NO UNIQUE INDEX IS BUILT ANYWHERE IN THIS FILE. A unique build is the
--      one that can fail on data it does not like, and in this lane a failure
--      leaves the file half-applied.
--
--   4. COMMENT ON COLUMN -- catalogue only.
--
-- Nothing here rewrites the table and there is no data-migration statement at
-- all: the SET NULLs happen later, one list delete at a time, as an
-- application action.
--
-- IDEMPOTENT, WHICH THIS LANE REQUIRES because nothing in it is rolled back
-- and a failure re-runs the file from the top. `DROP NOT NULL` is a no-op on
-- an already-nullable column; the DO block skips a constraint that already
-- carries ON DELETE SET NULL; the DROP INDEX IF EXISTS before the build is
-- README rule 4 (a failed CONCURRENTLY build leaves an INVALID index that
-- `IF NOT EXISTS` would otherwise find and accept); and COMMENT ON is a
-- straight overwrite.

-- trevra:no-transaction

/* ---------------------------------------------------------------------------
 * 1. The origin list stops owning the person.
 * ------------------------------------------------------------------------ */

ALTER TABLE linkedin_lead_contacts ALTER COLUMN list_id DROP NOT NULL;

-- The constraint is found in the catalogue rather than named, because 046
-- created it inline in CREATE TABLE and it therefore carries PostgreSQL's
-- generated name. That name is stable in practice and guaranteed by nothing,
-- and a migration that hard-codes it fails on any database where the table was
-- ever restored or rebuilt under a different one.
--
-- `confdeltype <> 'n'` is what makes the block idempotent: 'n' is SET NULL, so
-- a constraint that already has the delete action this migration installs is
-- left exactly where it is and the ADD below is skipped.
DO $$
DECLARE con RECORD;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'linkedin_lead_contacts'::regclass
      AND c.contype = 'f'
      AND a.attname = 'list_id'
      AND c.confdeltype <> 'n'
  LOOP
    EXECUTE format('ALTER TABLE linkedin_lead_contacts DROP CONSTRAINT %I', con.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'linkedin_lead_contacts'::regclass
      AND c.contype = 'f'
      AND a.attname = 'list_id'
  ) THEN
    ALTER TABLE linkedin_lead_contacts
      ADD CONSTRAINT linkedin_lead_contacts_list_id_fkey
      FOREIGN KEY (list_id) REFERENCES linkedin_lead_lists(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

/* ---------------------------------------------------------------------------
 * 2. The index ON DELETE SET NULL needs to not be a sequential scan.
 * ------------------------------------------------------------------------ */

-- Dropped first, per README rule 4: a CREATE INDEX CONCURRENTLY that fails
-- leaves an INVALID index behind, and `IF NOT EXISTS` on the retry would find
-- it, skip the build and leave the table indexed by something the planner
-- refuses to use. On a first run this is a no-op.
DROP INDEX IF EXISTS idx_linkedin_lead_contacts_list;

-- Partial on `list_id IS NOT NULL` because the null side is the side that
-- grows: every list deletion adds rows the FK will never have to look up
-- again, and indexing them would make this index a copy of the table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_lead_contacts_list
  ON linkedin_lead_contacts(list_id)
  WHERE list_id IS NOT NULL;

/* ---------------------------------------------------------------------------
 * 3. Say what the column means now, where the next reader will look.
 * ------------------------------------------------------------------------ */

COMMENT ON COLUMN linkedin_lead_contacts.list_id IS
'The lead list this contact FIRST arrived in, or NULL once that list has been deleted. NOT membership -- since migration 052 membership is linkedin_lead_list_members and one person may be in many lists. Nullable with ON DELETE SET NULL since migration 053: deleting a list must not delete the people who came in through it, because they may sit in other lists and be enrolled in other campaigns. Read this column only for provenance; read linkedin_lead_list_members for "which list is this person in".';
