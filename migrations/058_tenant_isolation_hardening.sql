-- Tenant isolation hardening: composite parentage, seat defaults, scoped
-- idempotency, a login index the planner can actually use, and workspace_id on
-- the ten tables that never had one.
--
-- WHY THIS FILE EXISTS. Every foreign key in this schema up to 057 is
-- single-column. `workspace_id` is carried on almost every table and every
-- handler filters on it, but nothing at the DATABASE level ties a child row's
-- workspace_id to its parent's. So this is legal SQL today:
--
--   INSERT INTO linkedin_campaign_members (id, workspace_id, campaign_id, ...)
--   VALUES ('lcm_x', 'ws_attacker', 'lcm_victims_campaign', ...);
--
-- `campaign_id` resolves (it is a real campaign), `workspace_id` resolves (it
-- is a real workspace), and the row is accepted. The only thing standing
-- between that INSERT and a cross-tenant read is a WHERE clause in TypeScript.
-- On a hosted multi-tenant database that is not an isolation boundary, it is a
-- code review convention. This file makes the disagreement unrepresentable.
--
-- ---------------------------------------------------------------------------
-- LOCK DISCIPLINE, AND THE ONE THING THAT CONSTRAINS EVERY STATEMENT BELOW
-- ---------------------------------------------------------------------------
--
-- THIS FILE IS DELIBERATELY IN THE TRANSACTIONAL LANE. `runMigrations()` in
-- src/server/db.ts gives each file its own transaction and offers an opt-out
-- (`-- trevra:no-transaction`, one statement per round trip, nothing rolled
-- back) for statements that cannot run inside a transaction block. This file
-- does NOT take that opt-out, because migrations/README.md rule 2 is right:
-- the lane is for index builds, not data rewrites, and section 5b below
-- backfills rows. A half-applied backfill in a lane with no rollback is a
-- table left in two states. So:
--
--   1. `CREATE INDEX CONCURRENTLY` CANNOT BE USED HERE. It is prohibited
--      inside a transaction block. Every index this file builds is built the
--      blocking way, and every blocking build is SIZE-GATED (below) so that it
--      is only ever done to a table small enough for the block to be
--      imperceptible. Anything too big is skipped and recorded, with the exact
--      `CREATE INDEX CONCURRENTLY` to run in a follow-up file that DOES carry
--      the `-- trevra:no-transaction` marker.
--
--   2. Locks are released at THIS FILE'S COMMIT, not at the end of the run.
--      That is what makes the size gate sufficient rather than merely prudent:
--      the exposure is this file's own duration, and this file does no
--      unbounded work.
--
--   3. The runner sets `statement_timeout = 0` and `lock_timeout` to 10s. A
--      statement here that cannot GET its lock fails fast and takes the file
--      with it, rather than queueing an AccessExclusiveLock that every arriving
--      query then piles up behind. A failed run is a retry in a quieter minute;
--      nothing in this file is order-dependent on having run before.
--
--   4. `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` is still two
--      statements rather than one `ADD CONSTRAINT`: the ACCESS EXCLUSIVE half
--      stays catalog-only and instant, and the scanning half takes only SHARE
--      UPDATE EXCLUSIVE, which does not block reads or writes.
--
-- THE SIZE GATE. Any statement that scans or rewrites a table is executed only
-- when that table's heap is at or below 64 MB (roughly 400k narrow rows -- a
-- sub-second build). Above that the statement is SKIPPED, a WARNING is raised,
-- and a row is written to `schema_hardening_deferred` naming exactly what was
-- not done, why, and the statement to run instead. This file therefore never
-- becomes an outage, and never lies about having hardened something it did not.
--
-- WHAT HAPPENS IF EXISTING DATA ALREADY VIOLATES A CONSTRAINT. This could not
-- be checked against production from here (no Trevra database is reachable
-- from the authoring environment), so it is handled rather than assumed. Every
-- risky statement runs inside its own plpgsql subtransaction:
--
--   * `ADD CONSTRAINT ... NOT VALID` never fails on existing data by
--     definition -- it does not look at it. It DOES take effect immediately
--     for every INSERT and UPDATE from that moment on. So the worst case is
--     always "new writes are correct, old bad rows survive", never "deploy
--     fails".
--   * `VALIDATE CONSTRAINT` is the statement that can fail. If it does, the
--     subtransaction rolls back, the constraint STAYS `NOT VALID` (still
--     enforced on new rows), a WARNING names the table, and the work is
--     recorded in `schema_hardening_deferred`. The migration continues.
--     Nothing is deleted and nothing is repaired silently: a cross-tenant row
--     is evidence, and quarantining it is the operator's call, not this file's.
--   * A unique index that collides on existing data is treated the same way.
--
-- To find out afterwards whether anything was left undone:
--
--   SELECT * FROM schema_hardening_deferred ORDER BY item, table_name;
--
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 0. The deferral ledger and the two helpers this file uses everywhere.
-- ===========================================================================
--
-- A WARNING scrolls past in a deploy log and is gone. This table is the thing
-- a follow-up migration, and a human, can both read. It is deliberately not
-- workspace-scoped: it is a fact about the schema, not about a tenant.
--
-- LOCK: CREATE TABLE on a table nobody else references -- ACCESS EXCLUSIVE on
-- a brand-new relation, instant.
CREATE TABLE IF NOT EXISTS schema_hardening_deferred (
  -- Which of this file's concerns: 'composite-parent-key', 'composite-fk',
  -- 'composite-fk-validate', 'seat-key-default', 'webhook-idempotency',
  -- 'users-email-lower', 'workspace-column', 'workspace-column-validate'.
  item TEXT NOT NULL,
  table_name TEXT NOT NULL,
  -- One sentence an operator can act on, including what to run instead.
  detail TEXT NOT NULL,
  -- The heap size that triggered the size gate, so "is it still too big" is
  -- answerable without guessing what the threshold was on the day.
  heap_bytes BIGINT NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (item, table_name)
);

-- 64 MB of heap. Chosen because a unique btree build over that much narrow TEXT
-- data finishes in well under a second on the smallest instance we ship on, and
-- because the lock is held until this file commits, not until the statement
-- ends (see note 2).
CREATE OR REPLACE FUNCTION trevra_h058_cheap(rel regclass) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(pg_relation_size($1), 0) <= 64 * 1024 * 1024;
$fn$;

CREATE OR REPLACE FUNCTION trevra_h058_defer(p_item TEXT, p_table TEXT, p_detail TEXT)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO schema_hardening_deferred (item, table_name, detail, heap_bytes, recorded_at)
  VALUES (p_item, p_table, p_detail,
          COALESCE(pg_relation_size(to_regclass('public.' || p_table)), 0), CURRENT_TIMESTAMP)
  ON CONFLICT (item, table_name) DO UPDATE
    SET detail = excluded.detail, heap_bytes = excluded.heap_bytes, recorded_at = excluded.recorded_at;
  RAISE WARNING '058 deferred [%] on % -- %', p_item, p_table, p_detail;
END $fn$;

CREATE OR REPLACE FUNCTION trevra_h058_done(p_item TEXT, p_table TEXT)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM schema_hardening_deferred WHERE item = p_item AND table_name = p_table;
END $fn$;

-- Does a table have all of these columns? Guards every statement below against
-- landing before or after a sibling migration that creates or renames a column.
-- This file assumes NOTHING about 053-057 or 059-060 having run.
CREATE OR REPLACE FUNCTION trevra_h058_has_cols(rel regclass, cols TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT $1 IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM unnest(string_to_array(replace($2, ' ', ''), ',')) AS want(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = $1 AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped
    )
  );
$fn$;


-- ===========================================================================
-- 1. Composite parent keys, so a composite foreign key has something to point
--    at.
-- ===========================================================================
--
-- A composite FK needs a UNIQUE constraint on the parent's (workspace_id, id).
-- That pair is ALREADY unique -- `id` alone is the primary key -- so this adds
-- no new rule and CANNOT fail on existing data. It exists purely so the FK
-- below has a target. The cost is one extra btree per parent table.
--
-- TWO STATEMENTS, NOT ONE, and the order matters:
--
--   CREATE UNIQUE INDEX               -- SHARE lock: blocks writes to this
--                                        table for the length of the build,
--                                        READS KEEP WORKING. Size-gated.
--   ALTER TABLE ... ADD CONSTRAINT
--     ... UNIQUE USING INDEX          -- ACCESS EXCLUSIVE, but catalog-only
--                                        and instant: it adopts the index just
--                                        built rather than building another.
--
-- `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (workspace_id, id)` on its own
-- would have done both in one statement and held ACCESS EXCLUSIVE -- blocking
-- SELECTs too -- for the whole build. On a shared box that difference is the
-- difference between "slow" and "down".
DO $$
DECLARE
  r RECORD;
  c regclass;
  idx TEXT;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('linkedin_campaigns'),
    ('linkedin_lead_lists'),
    ('linkedin_lead_contacts'),
    ('linkedin_workflows'),
    ('linkedin_campaign_members'),
    ('linkedin_threads'),
    ('accounts')
  ) AS t(tbl) LOOP
    c := to_regclass('public.' || r.tbl);
    CONTINUE WHEN c IS NULL;
    CONTINUE WHEN NOT trevra_h058_has_cols(c, 'workspace_id,id');
    idx := 'uq_' || r.tbl || '_workspace_id';

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c AND conname = idx) THEN
      PERFORM trevra_h058_done('composite-parent-key', r.tbl);
      CONTINUE;
    END IF;

    IF NOT trevra_h058_cheap(c) THEN
      PERFORM trevra_h058_defer('composite-parent-key', r.tbl,
        'heap over 64MB; run CREATE UNIQUE INDEX CONCURRENTLY ' || idx ||
        ' ON ' || r.tbl || ' (workspace_id, id); then ALTER TABLE ' || r.tbl ||
        ' ADD CONSTRAINT ' || idx || ' UNIQUE USING INDEX ' || idx || ';');
      CONTINUE;
    END IF;

    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (workspace_id, id)', idx, r.tbl);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE USING INDEX %I', r.tbl, idx, idx);
    PERFORM trevra_h058_done('composite-parent-key', r.tbl);
  END LOOP;
END $$;


-- ===========================================================================
-- 1b. The composite foreign keys themselves.
-- ===========================================================================
--
-- Each of these REPLACES NOTHING. The existing single-column FK stays: it is
-- what carries the ON DELETE behaviour that the application already relies on,
-- and dropping it would be a semantic change this file has no mandate for. The
-- composite FK is an ADDITIONAL edge that says the child's workspace_id must
-- be the parent's workspace_id, and there is no way to satisfy it while lying.
--
-- ON DELETE on the composite edge mirrors the single-column edge, so the two
-- never disagree about what a parent deletion means.
--
-- THE TWO DEFERRABLE ONES. `linkedin_campaigns.lead_list_id` and
-- `.workflow_id` are nullable pointers whose existing FK is ON DELETE SET NULL.
-- A composite `ON DELETE SET NULL` would null BOTH referencing columns --
-- including workspace_id, which is NOT NULL -- and every list deletion would
-- raise. PostgreSQL 15 added `ON DELETE SET NULL (lead_list_id)` for exactly
-- this, but depending on 15+ is a deployment constraint this file should not
-- introduce. So those two are `NO ACTION DEFERRABLE INITIALLY DEFERRED`: the
-- single-column FK does the SET NULL during the statement, and the deferred
-- check runs at COMMIT, by which time the pointer is NULL and MATCH SIMPLE is
-- satisfied. Cross-tenant assignment is still refused, at commit instead of at
-- statement -- which for a constraint nobody is supposed to hit is the same
-- thing.
--
-- LOCKS, per constraint:
--   ADD CONSTRAINT ... NOT VALID  -- ACCESS EXCLUSIVE on the child +
--                                    SHARE ROW EXCLUSIVE on the parent.
--                                    Catalog-only, no scan, milliseconds.
--                                    ENFORCED ON NEW ROWS IMMEDIATELY.
--   VALIDATE CONSTRAINT           -- SHARE UPDATE EXCLUSIVE on the child +
--                                    ROW SHARE on the parent. One sequential
--                                    scan. DOES NOT BLOCK reads or writes.
--                                    Size-gated anyway, because it still holds
--                                    that lock until this file commits.
--
-- No new indexes are added to support these FKs. Every referencing column here
-- already carries a single-column FK, so the parent-deletion lookups they imply
-- were already being performed against the same columns; the composite edge
-- adds no lookup shape that was not there before.
DO $$
DECLARE
  r RECORD;
  child regclass;
  parent regclass;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- The sharpest case in the whole schema: a member row in workspace B
    -- pointing at workspace A's campaign, and at workspace A's contact.
    ('fk_lkcm_campaign_ws',  'linkedin_campaign_members', 'workspace_id, campaign_id', 'linkedin_campaigns',        'ON DELETE CASCADE'),
    ('fk_lkcm_contact_ws',   'linkedin_campaign_members', 'workspace_id, contact_id',  'linkedin_lead_contacts',    'ON DELETE CASCADE'),
    -- 046:84 -- a manual task is a thing a human is told to do to a real
    -- person; getting its tenant wrong is an operator messaging a stranger.
    ('fk_lkmt_campaign_ws',  'linkedin_manual_tasks',     'workspace_id, campaign_id', 'linkedin_campaigns',        'ON DELETE CASCADE'),
    ('fk_lkmt_member_ws',    'linkedin_manual_tasks',     'workspace_id, member_id',   'linkedin_campaign_members', 'ON DELETE CASCADE'),
    ('fk_lkmt_contact_ws',   'linkedin_manual_tasks',     'workspace_id, contact_id',  'linkedin_lead_contacts',    'ON DELETE CASCADE'),
    -- 031:113 -- a message is a transcript of a real conversation. A message
    -- filed under the wrong tenant is that tenant reading someone else's mail.
    ('fk_lkmsg_thread_ws',   'linkedin_messages',         'workspace_id, thread_id',   'linkedin_threads',          'ON DELETE CASCADE'),
    -- A contact belongs to a list, and the list belongs to a workspace.
    ('fk_lklc_list_ws',      'linkedin_lead_contacts',    'workspace_id, list_id',     'linkedin_lead_lists',       'ON DELETE CASCADE'),
    -- 052's membership join carries all three ids; all three must agree.
    ('fk_lkllm_list_ws',     'linkedin_lead_list_members','workspace_id, list_id',     'linkedin_lead_lists',       'ON DELETE CASCADE'),
    ('fk_lkllm_contact_ws',  'linkedin_lead_list_members','workspace_id, contact_id',  'linkedin_lead_contacts',    'ON DELETE CASCADE'),
    -- 039:95/134/169 -- the account graph. Same shape, same hole.
    ('fk_acsig_account_ws',  'account_signals',           'workspace_id, account_id',  'accounts',                  'ON DELETE CASCADE'),
    ('fk_acsco_account_ws',  'account_scores',            'workspace_id, account_id',  'accounts',                  'ON DELETE CASCADE'),
    ('fk_acfb_account_ws',   'account_feedback',          'workspace_id, account_id',  'accounts',                  'ON DELETE CASCADE'),
    -- The two nullable pointers. See the DEFERRABLE note above.
    ('fk_lkc_leadlist_ws',   'linkedin_campaigns',        'workspace_id, lead_list_id','linkedin_lead_lists',       'ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED'),
    ('fk_lkc_workflow_ws',   'linkedin_campaigns',        'workspace_id, workflow_id', 'linkedin_workflows',        'ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED')
  ) AS t(cname, child_tbl, cols, parent_tbl, opts) LOOP

    child  := to_regclass('public.' || r.child_tbl);
    parent := to_regclass('public.' || r.parent_tbl);
    CONTINUE WHEN child IS NULL OR parent IS NULL;
    CONTINUE WHEN NOT trevra_h058_has_cols(child, r.cols);

    -- The parent key may have been size-gated out above. Without it the FK
    -- cannot be created at all; that is already recorded against the parent.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = parent AND conname = 'uq_' || r.parent_tbl || '_workspace_id'
    ) THEN
      PERFORM trevra_h058_defer('composite-fk', r.child_tbl,
        r.cname || ' not created: parent key uq_' || r.parent_tbl ||
        '_workspace_id is missing (deferred above).');
      CONTINUE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = child AND conname = r.cname) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I (workspace_id, id) %s NOT VALID',
        r.child_tbl, r.cname, r.cols, r.parent_tbl, r.opts);
    END IF;

    -- From here the constraint exists and every new write is checked. The only
    -- question left is whether history is clean.
    IF EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid = child AND conname = r.cname AND convalidated
    ) THEN
      PERFORM trevra_h058_done('composite-fk-validate', r.child_tbl || '.' || r.cname);
      CONTINUE;
    END IF;

    IF NOT trevra_h058_cheap(child) THEN
      PERFORM trevra_h058_defer('composite-fk-validate', r.child_tbl || '.' || r.cname,
        'constraint added NOT VALID (new writes ARE checked); heap over 64MB so the ' ||
        'validating scan was not run here. Run: ALTER TABLE ' || r.child_tbl ||
        ' VALIDATE CONSTRAINT ' || r.cname || '; -- SHARE UPDATE EXCLUSIVE, does not block DML.');
      CONTINUE;
    END IF;

    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', r.child_tbl, r.cname);
      PERFORM trevra_h058_done('composite-fk-validate', r.child_tbl || '.' || r.cname);
    EXCEPTION WHEN foreign_key_violation THEN
      -- Existing rows disagree with their parent's workspace. The constraint
      -- stays NOT VALID: new writes are refused, the offending history is left
      -- exactly where it is, and nobody's data is deleted by a migration.
      PERFORM trevra_h058_defer('composite-fk-validate', r.child_tbl || '.' || r.cname,
        'EXISTING ROWS VIOLATE THIS CONSTRAINT -- cross-tenant parentage is already ' ||
        'present in this database. Constraint left NOT VALID (new writes rejected). ' ||
        'Inspect with: SELECT c.* FROM ' || r.child_tbl || ' c LEFT JOIN ' || r.parent_tbl ||
        ' p ON p.id = c.' || split_part(replace(r.cols, ' ', ''), ',', 2) ||
        ' WHERE c.' || split_part(replace(r.cols, ' ', ''), ',', 2) ||
        ' IS NOT NULL AND (p.id IS NULL OR p.workspace_id <> c.workspace_id);');
    END;
  END LOOP;
END $$;


-- ===========================================================================
-- 2. `seat_key TEXT NOT NULL DEFAULT 'owner'` -- drop the defaults.
-- ===========================================================================
--
-- 022's seat-model note was honest when it was written: one seat, always
-- 'owner', and a defaulted column was cheaper than a backfill later. 045 made
-- seats plural. The default did not change, and it is now the wrong kind of
-- helpful: a writer that forgets the column does not fail, it silently files
-- another person's LinkedIn activity against the owner's seat -- which is the
-- seat whose pacing budget, warm-up band and restriction history everything
-- else reads. Mis-attribution here is not a display bug, it is an account the
-- safety system is no longer counting correctly.
--
-- This is a CATALOG-ONLY change. `ALTER COLUMN ... DROP DEFAULT` rewrites no
-- rows, reads no rows, and takes ACCESS EXCLUSIVE for the microseconds it takes
-- to update pg_attrdef. It is safe on a table of any size, which is why it is
-- the one section here with no size gate.
--
-- The sweep is DYNAMIC rather than a hand-written list of the eight tables from
-- 022/024/027/031/032/045/046: sibling migrations 053-060 are landing in
-- parallel and any of them may add another `seat_key TEXT NOT NULL DEFAULT
-- 'owner'`. Whatever exists when this file runs loses its default.
--
-- ONE EXCLUSION, AND IT IS NOT A STYLE CHOICE. `linkedin_campaigns` keeps its
-- default for now because src/server/linkedin/campaigns.ts:132-134 --
-- `createCampaign`, a live API path -- inserts without naming seat_key. The
-- premise that "every production INSERT names the column" holds for the other
-- seven tables and does not hold for this one; the column is not latent there,
-- it is already being defaulted in production. Dropping the default before that
-- INSERT is fixed converts a silent mis-attribution into a 500 on campaign
-- creation. The required edit is named in this migration's report and the
-- deferral is recorded below; the drop belongs in the migration that lands
-- alongside the code change.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'seat_key'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.atthasdef
      AND c.relname <> 'linkedin_campaigns'
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN seat_key DROP DEFAULT', r.tbl);
    PERFORM trevra_h058_done('seat-key-default', r.tbl);
    RAISE NOTICE '058: dropped seat_key default on %', r.tbl;
  END LOOP;

  IF to_regclass('public.linkedin_campaigns') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = to_regclass('public.linkedin_campaigns')
         AND a.attname = 'seat_key' AND a.attnum > 0 AND NOT a.attisdropped AND a.atthasdef
     ) THEN
    PERFORM trevra_h058_defer('seat-key-default', 'linkedin_campaigns',
      'default kept ON PURPOSE: src/server/linkedin/campaigns.ts:132-134 inserts without ' ||
      'seat_key and would fail. Fix that INSERT to name seat_key, then run: ' ||
      'ALTER TABLE linkedin_campaigns ALTER COLUMN seat_key DROP DEFAULT;');
  END IF;
END $$;


-- ===========================================================================
-- 3. `webhook_events` -- idempotency that one tenant can deny to another.
-- ===========================================================================
--
-- 001:58 made (provider, external_event_id) globally unique. Providers do not
-- allocate event ids in a global namespace -- they allocate them per account,
-- per app installation, sometimes per object -- so two tenants receiving the
-- same provider's event id is ordinary, not adversarial. Under the global
-- unique the second tenant's event is a duplicate: the insert is a no-op, the
-- handler treats it as already-processed, and the event is DROPPED. That is a
-- cross-tenant denial of idempotency, and it is also an existence oracle --
-- "my event was swallowed" tells you somebody else already has that id.
--
-- THE DECISION ABOUT NULL, WHICH IS THE ONLY INTERESTING PART.
-- `workspace_id` is nullable here (001:51) and that is correct: a webhook is
-- received BEFORE its tenant is known. Resolution happens by looking up the
-- connection named in the payload, which can fail, and an unattributable event
-- must still be recorded rather than dropped. So a NULL workspace is a real
-- state, not a defect, and it means exactly one thing: NOT YET RESOLVED.
--
-- A plain UNIQUE (workspace_id, provider, external_event_id) would be wrong,
-- because SQL NULLs are distinct from each other: every unresolved redelivery
-- of the same event would insert a new row, and the pre-resolution retry path
-- -- the one place a provider hammers hardest -- would lose its idempotency
-- entirely. NULLS NOT DISTINCT (PG 15+) would fix that but pins the deployment.
--
-- So: the unresolved events share ONE bucket, keyed by a sentinel that cannot
-- collide with a workspace id (every workspace id this codebase mints is
-- prefixed `ws_`). Unresolved redeliveries still dedupe against each other;
-- resolved events dedupe only within their own tenant; no tenant can consume
-- another tenant's event id. A row that is later resolved simply moves from the
-- sentinel bucket to its own.
--
-- THIS INDEX CANNOT FAIL ON EXISTING DATA. The constraint it replaces was
-- strictly stronger -- global uniqueness on (provider, external_event_id)
-- implies uniqueness on any superset of those columns -- so every existing row
-- already satisfies it.
--
-- LOCKS:
--   CREATE UNIQUE INDEX  -- SHARE: blocks writes for the build, reads fine.
--   DROP CONSTRAINT      -- ACCESS EXCLUSIVE, catalog-only, instant.
--   ADD CONSTRAINT FK NOT VALID / VALIDATE -- as section 1b.
DO $$
DECLARE
  c regclass := to_regclass('public.webhook_events');
  oldname TEXT;
BEGIN
  IF c IS NULL OR NOT trevra_h058_has_cols(c, 'workspace_id,provider,external_event_id') THEN
    RETURN;
  END IF;

  IF to_regclass('public.idx_webhook_events_tenant_idempotency') IS NULL THEN
    IF NOT trevra_h058_cheap(c) THEN
      PERFORM trevra_h058_defer('webhook-idempotency', 'webhook_events',
        'heap over 64MB; run CREATE UNIQUE INDEX CONCURRENTLY idx_webhook_events_tenant_idempotency ' ||
        'ON webhook_events (COALESCE(workspace_id, ''@unresolved''), provider, external_event_id); ' ||
        'then drop the global UNIQUE (provider, external_event_id).');
      RETURN;
    END IF;
    EXECUTE 'CREATE UNIQUE INDEX idx_webhook_events_tenant_idempotency
               ON webhook_events (COALESCE(workspace_id, ''@unresolved''), provider, external_event_id)';
  END IF;

  -- Only now is it safe to give up the old rule -- and only by looking the
  -- constraint up by its DEFINITION, because a name is a guess and this one was
  -- generated by PostgreSQL in 001.
  SELECT conname INTO oldname
  FROM pg_constraint
  WHERE conrelid = c AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (provider, external_event_id)'
  LIMIT 1;

  IF oldname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE webhook_events DROP CONSTRAINT %I', oldname);
    RAISE NOTICE '058: dropped cross-tenant unique % on webhook_events', oldname;
  END IF;

  -- 001:51 left workspace_id un-FK'd, so a webhook row can name a workspace
  -- that does not exist and survive that workspace being deleted. CASCADE
  -- matches every other tenant-owned table: deleting a tenant deletes their
  -- processed-event log.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c AND conname = 'fk_webhook_events_workspace') THEN
    ALTER TABLE webhook_events
      ADD CONSTRAINT fk_webhook_events_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = c AND conname = 'fk_webhook_events_workspace' AND convalidated) THEN
    IF trevra_h058_cheap(c) THEN
      BEGIN
        ALTER TABLE webhook_events VALIDATE CONSTRAINT fk_webhook_events_workspace;
        PERFORM trevra_h058_done('webhook-workspace-fk', 'webhook_events');
      EXCEPTION WHEN foreign_key_violation THEN
        PERFORM trevra_h058_defer('webhook-workspace-fk', 'webhook_events',
          'rows reference a workspace that no longer exists; constraint left NOT VALID ' ||
          '(new writes checked). Inspect: SELECT w.* FROM webhook_events w LEFT JOIN workspaces s ' ||
          'ON s.id = w.workspace_id WHERE w.workspace_id IS NOT NULL AND s.id IS NULL;');
      END;
    ELSE
      PERFORM trevra_h058_defer('webhook-workspace-fk', 'webhook_events',
        'added NOT VALID; run ALTER TABLE webhook_events VALIDATE CONSTRAINT fk_webhook_events_workspace;');
    END IF;
  END IF;
END $$;


-- ===========================================================================
-- 4. `users.email` -- the unique index the login path cannot use.
-- ===========================================================================
--
-- 001:10 declared `email TEXT NOT NULL UNIQUE`, and every lookup in
-- src/server/auth-service.ts (lines 320, 390, 397) is
-- `WHERE lower(email) = ?`. A btree on the raw column cannot answer a query
-- about a function of that column, so the unique index is dead weight for the
-- one query that matters and every sign-in is a sequential scan over `users`.
-- Worse, the rule the code believes in -- "one account per email address,
-- case-insensitively" -- is enforced nowhere but by a `toLowerCase()` call:
-- `Ada@x.com` and `ada@x.com` are two rows the database is happy with and the
-- login path will race over.
--
-- SCOPE: GLOBAL, not per-workspace, deliberately. `users.workspace_id` is NOT
-- NULL and a user belongs to exactly one workspace, and auth-service.ts:320
-- looks an account up by email ALONE, before any workspace is known -- there is
-- no tenant in hand at that point to scope by. Making this
-- (workspace_id, lower(email)) would let the same address exist twice and make
-- "which account is signing in" ambiguous. Global is what the code means.
--
-- IF EXISTING DATA COLLIDES the index build raises, the subtransaction rolls
-- back, the old raw unique is LEFT IN PLACE (so `users` is never left with no
-- uniqueness at all), and the collision is recorded for a human to merge. That
-- ordering -- build first, drop second, drop only on success -- is the whole
-- safety of this section.
--
-- LOCKS: CREATE UNIQUE INDEX takes SHARE on `users` (blocks writes, allows
-- reads) for the build; `users` is a tenant-count-sized table, so this is
-- milliseconds. DROP CONSTRAINT is ACCESS EXCLUSIVE and instant.
DO $$
DECLARE
  c regclass := to_regclass('public.users');
  oldname TEXT;
BEGIN
  IF c IS NULL OR NOT trevra_h058_has_cols(c, 'email') THEN RETURN; END IF;

  IF to_regclass('public.users_email_lower_key') IS NULL THEN
    IF NOT trevra_h058_cheap(c) THEN
      PERFORM trevra_h058_defer('users-email-lower', 'users',
        'heap over 64MB; run CREATE UNIQUE INDEX CONCURRENTLY users_email_lower_key ON users (lower(email));');
      RETURN;
    END IF;
    BEGIN
      EXECUTE 'CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email))';
      PERFORM trevra_h058_done('users-email-lower', 'users');
    EXCEPTION WHEN unique_violation THEN
      PERFORM trevra_h058_defer('users-email-lower', 'users',
        'TWO OR MORE ACCOUNTS SHARE AN EMAIL ADDRESS UP TO CASE. The raw UNIQUE(email) ' ||
        'is left in place and the login path keeps seq-scanning. Merge first: ' ||
        'SELECT lower(email), count(*), array_agg(id) FROM users GROUP BY 1 HAVING count(*) > 1;');
      RETURN;
    END;
  END IF;

  -- Only reached when the functional unique exists, which is strictly stronger
  -- than the raw one: dropping the raw index removes a redundant btree and a
  -- redundant write on every user insert, and removes nothing the schema was
  -- relying on. No code names this constraint (there is no ON CONFLICT (email)
  -- anywhere in src/).
  SELECT conname INTO oldname
  FROM pg_constraint
  WHERE conrelid = c AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (email)'
  LIMIT 1;

  IF oldname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', oldname);
  END IF;
END $$;


-- ===========================================================================
-- 5a. The commercial-capture trigger has to survive a nullable workspace_id.
-- ===========================================================================
--
-- MUST RUN BEFORE 5b. `trevra_commercial_workspace_id` (007) resolves a row's
-- workspace by, first, returning `row_data->>'workspace_id'` whenever the JSONB
-- has that KEY at all -- and a column that exists but is NULL still produces
-- the key. So the moment 5b adds `workspace_id` to `contract_clauses`, every
-- not-yet-backfilled row starts resolving to NULL, `trevra_capture_...` returns
-- early, and the commercial event stream silently stops recording nine entity
-- types. The parent-lookup CASE below it -- which is correct and still needed
-- for exactly those rows -- would never be reached.
--
-- The fix is one word: fall through when the key is present but NULL. Once the
-- backfill lands the fast path takes over again; until then the CASE resolves
-- from the parent exactly as it does today.
--
-- LOCK: none worth naming -- CREATE OR REPLACE FUNCTION takes a lock on the
-- function, not on any table.
--
-- NOTE FOR SIBLINGS: if 059 or 060 also replaces this function, the later file
-- wins and MUST keep the `IS NOT NULL` guard, or 5b re-breaks the event stream.
CREATE OR REPLACE FUNCTION trevra_commercial_workspace_id(table_name TEXT, row_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE result TEXT;
BEGIN
  IF row_data ? 'workspace_id' AND row_data->>'workspace_id' IS NOT NULL THEN
    RETURN row_data->>'workspace_id';
  END IF;
  CASE table_name
    WHEN 'contract_clauses' THEN SELECT workspace_id INTO result FROM contracts WHERE id=row_data->>'contract_id';
    WHEN 'scope_items' THEN SELECT workspace_id INTO result FROM projects WHERE id=row_data->>'project_id';
    WHEN 'milestones' THEN SELECT p.workspace_id INTO result FROM projects p WHERE p.id=row_data->>'project_id';
    WHEN 'deliverables' THEN SELECT p.workspace_id INTO result FROM projects p WHERE p.id=row_data->>'project_id';
    WHEN 'commitments' THEN SELECT workspace_id INTO result FROM clients WHERE id=row_data->>'client_id';
    WHEN 'proof_packs' THEN SELECT r.workspace_id INTO result FROM recommendations r WHERE r.id=row_data->>'recommendation_id';
    WHEN 'proof_pack_items' THEN SELECT r.workspace_id INTO result FROM proof_packs pp JOIN recommendations r ON r.id=pp.recommendation_id WHERE pp.id=row_data->>'proof_pack_id';
    WHEN 'approvals' THEN SELECT a.workspace_id INTO result FROM actions a WHERE a.id=row_data->>'action_id';
    WHEN 'recommendation_outcomes' THEN SELECT r.workspace_id INTO result FROM recommendations r WHERE r.id=row_data->>'recommendation_id';
    WHEN 'recommendation_evidence' THEN SELECT r.workspace_id INTO result FROM recommendations r WHERE r.id=row_data->>'recommendation_id';
    ELSE result := NULL;
  END CASE;
  RETURN result;
END $$;


-- ===========================================================================
-- 5b. `workspace_id` on the ten tables that never had one.
-- ===========================================================================
--
-- These ten are tenant-owned data reachable only through a parent id, which
-- means NO HANDLER CAN SCOPE THEM DIRECTLY. Every read of a clause, a scope
-- item, a milestone, an approval or a step run has to join to a parent to
-- prove it is allowed to see the row, and a query that forgets the join is not
-- a slow query, it is a cross-tenant read that returns 200. 007 already had to
-- write a nine-branch plpgsql CASE (`trevra_commercial_workspace_id`) purely to
-- rediscover the workspace these rows belong to -- that function is the receipt
-- for this problem.
--
-- WHAT THIS SECTION DOES, AND WHAT IT DELIBERATELY DOES NOT:
--
--   ADD COLUMN workspace_id TEXT       -- nullable, NO DEFAULT. Catalog-only in
--                                         PG 11+: no rewrite, no scan, ACCESS
--                                         EXCLUSIVE for microseconds, safe at
--                                         any size. A constant DEFAULT is what
--                                         the rules require IF the column were
--                                         NOT NULL; here there is no honest
--                                         constant -- the value is the parent's
--                                         -- so the column starts nullable
--                                         instead. See the NOT NULL note below.
--   UPDATE ... FROM parent             -- ROW EXCLUSIVE + row locks. THE ONLY
--                                         ROW-TOUCHING STATEMENT IN THIS FILE,
--                                         and the reason the size gate exists.
--   CREATE INDEX (workspace_id)        -- SHARE: blocks writes, allows reads.
--   ADD CONSTRAINT FK NOT VALID        -- catalog-only, instant.
--   VALIDATE CONSTRAINT                -- SHARE UPDATE EXCLUSIVE, one scan,
--                                         does not block DML.
--
--   NOT NULL IS NOT SET, and that is not an oversight. Every writer of these
--   tables (named in this migration's report) still inserts without a
--   workspace_id; `SET NOT NULL` today would break each of them on the next
--   insert. The staged path is: this migration adds and backfills -> the
--   writers start supplying the column -> a later migration adds
--   `CHECK (workspace_id IS NOT NULL) NOT VALID`, validates it, then runs
--   `SET NOT NULL`, which PG 12+ proves from the validated CHECK without a
--   second scan and without an exclusive-lock table scan.
--
--   NO COMPOSITE FK TO THE PARENT EITHER, for a reason worth stating: while
--   workspace_id is nullable, a MATCH SIMPLE composite FK is satisfied by any
--   row with a NULL in it, so it would enforce nothing on exactly the rows that
--   need enforcing. The composite edge belongs in the same later migration as
--   the NOT NULL, once the two are meaningful together.
--
-- THE BACKFILL IS A SCHEMA REPAIR, NOT A BUSINESS EVENT. Nine of these tables
-- carry 007's `trevra_capture_*` trigger, so an unguarded backfill would emit
-- one commercial_entity_event per row -- doubling the write volume of the
-- migration and filling a tenant's event stream with upserts that describe no
-- change anyone made. The trigger is disabled around the UPDATE and re-enabled
-- immediately (SHARE ROW EXCLUSIVE, catalog-only, instant, and inside the same
-- transaction so no concurrent writer can slip through the window).
--
-- SIZE GATE, PER TABLE. `contract_clauses`, `scope_items`, `milestones`,
-- `approvals`, `recommendation_outcomes`, `recommendation_evidence`,
-- `proof_packs` and `proof_pack_items` are bounded by the commercial graph and
-- will be small for a long time. `playbook_step_runs` grows once per step per
-- run and `research_source_documents` is a join table over a corpus that grows
-- per polled document -- THOSE TWO ARE THE ONES EXPECTED TO TRIP THE GATE ON A
-- BUSY TENANT. When they do, the column is still added (that part is free) and
-- only the backfill and the index are deferred, with the batched path written
-- into `schema_hardening_deferred.detail`: repeat
--   UPDATE <t> SET workspace_id = p.workspace_id FROM <parent> p
--   WHERE p.id = <t>.<fk> AND <t>.workspace_id IS NULL
--     AND <t>.ctid IN (SELECT ctid FROM <t> WHERE workspace_id IS NULL LIMIT 10000);
-- one autocommitted batch at a time, until it reports 0 rows. That cannot be
-- done from here: this file is one transaction, and batching inside a single
-- transaction buys nothing -- the row locks and the WAL are held either way.
-- Nor can it move to the `-- trevra:no-transaction` lane, which has no rollback
-- and is documented as being for index builds rather than data rewrites.
DO $$
DECLARE
  r RECORD;
  c regclass;
  trg TEXT;
  had_trigger BOOLEAN;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('contract_clauses',          'contract_id',     'contracts',
     'UPDATE contract_clauses c SET workspace_id = p.workspace_id FROM contracts p WHERE p.id = c.contract_id AND c.workspace_id IS DISTINCT FROM p.workspace_id'),
    ('scope_items',               'project_id',      'projects',
     'UPDATE scope_items c SET workspace_id = p.workspace_id FROM projects p WHERE p.id = c.project_id AND c.workspace_id IS DISTINCT FROM p.workspace_id'),
    ('milestones',                'project_id',      'projects',
     'UPDATE milestones c SET workspace_id = p.workspace_id FROM projects p WHERE p.id = c.project_id AND c.workspace_id IS DISTINCT FROM p.workspace_id'),
    ('recommendation_evidence',   'recommendation_id','recommendations',
     'UPDATE recommendation_evidence c SET workspace_id = p.workspace_id FROM recommendations p WHERE p.id = c.recommendation_id AND c.workspace_id IS DISTINCT FROM p.workspace_id'),
    ('proof_packs',               'recommendation_id','recommendations',
     'UPDATE proof_packs c SET workspace_id = p.workspace_id FROM recommendations p WHERE p.id = c.recommendation_id AND c.workspace_id IS DISTINCT FROM p.workspace_id'),
    -- Two hops: an item knows its pack, the pack knows the recommendation, the
    -- recommendation knows the tenant. Runs after proof_packs above, but reads
    -- through to `recommendations` rather than depending on that row order.
    ('proof_pack_items',          'proof_pack_id',   'proof_packs',
     'UPDATE proof_pack_items c SET workspace_id = rec.workspace_id FROM proof_packs pp JOIN recommendations rec ON rec.id = pp.recommendation_id WHERE pp.id = c.proof_pack_id AND c.workspace_id IS DISTINCT FROM rec.workspace_id'),
    ('approvals',                 'action_id',       'actions',
     'UPDATE approvals c SET workspace_id = p.workspace_id FROM actions p WHERE p.id = c.action_id AND c.workspace_id IS DISTINCT FROM p.workspace_id'),
    ('recommendation_outcomes',   'recommendation_id','recommendations',
     'UPDATE recommendation_outcomes c SET workspace_id = p.workspace_id FROM recommendations p WHERE p.id = c.recommendation_id AND c.workspace_id IS DISTINCT FROM p.workspace_id'),
    ('playbook_step_runs',        'playbook_run_id', 'playbook_runs',
     'UPDATE playbook_step_runs c SET workspace_id = p.workspace_id FROM playbook_runs p WHERE p.id = c.playbook_run_id AND c.workspace_id IS DISTINCT FROM p.workspace_id'),
    ('research_source_documents', 'source_id',       'research_sources',
     'UPDATE research_source_documents c SET workspace_id = p.workspace_id FROM research_sources p WHERE p.id = c.source_id AND c.workspace_id IS DISTINCT FROM p.workspace_id')
  ) AS t(tbl, fk_col, parent_tbl, backfill) LOOP

    c := to_regclass('public.' || r.tbl);
    CONTINUE WHEN c IS NULL;
    CONTINUE WHEN to_regclass('public.' || r.parent_tbl) IS NULL;
    CONTINUE WHEN NOT trevra_h058_has_cols(c, r.fk_col);

    -- (i) The column. Free at any size, so never gated.
    IF NOT trevra_h058_has_cols(c, 'workspace_id') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN workspace_id TEXT', r.tbl);
      c := to_regclass('public.' || r.tbl);
    END IF;

    -- (ii) The backfill. Gated, trigger-suppressed, and skipped entirely once
    -- there is nothing left to do (which is what makes a re-run free).
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c AND conname = 'fk_' || r.tbl || '_workspace')
       AND NOT trevra_h058_cheap(c) THEN
      NULL; -- already hardened on a previous run; nothing to do
    ELSIF NOT trevra_h058_cheap(c) THEN
      PERFORM trevra_h058_defer('workspace-column', r.tbl,
        'column added (nullable); backfill and index DEFERRED, heap over 64MB. Run the ' ||
        'batched backfill from the header comment against ' || r.parent_tbl ||
        ' via ' || r.fk_col || ', then CREATE INDEX CONCURRENTLY idx_' || r.tbl ||
        '_workspace ON ' || r.tbl || '(workspace_id); then ADD CONSTRAINT fk_' || r.tbl ||
        '_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID; VALIDATE.');
      CONTINUE;
    ELSE
      trg := 'trevra_capture_' || r.tbl;
      had_trigger := EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = c AND tgname = trg AND NOT tgisinternal);
      IF had_trigger THEN
        EXECUTE format('ALTER TABLE %I DISABLE TRIGGER %I', r.tbl, trg);
      END IF;
      EXECUTE r.backfill;
      IF had_trigger THEN
        EXECUTE format('ALTER TABLE %I ENABLE TRIGGER %I', r.tbl, trg);
      END IF;

      -- (iii) The index that makes the new column worth having: this is the
      -- one that lets a handler filter by tenant without the parent join.
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (workspace_id)',
                     'idx_' || r.tbl || '_workspace', r.tbl);

      -- (iv) The tenant edge. CASCADE, matching every other tenant-owned table.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c AND conname = 'fk_' || r.tbl || '_workspace') THEN
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID',
          r.tbl, 'fk_' || r.tbl || '_workspace');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = c AND conname = 'fk_' || r.tbl || '_workspace' AND convalidated) THEN
        BEGIN
          EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', r.tbl, 'fk_' || r.tbl || '_workspace');
        EXCEPTION WHEN foreign_key_violation THEN
          -- Only reachable if a parent row points at a workspace that is gone,
          -- i.e. the orphan predates this file. Left NOT VALID, never deleted.
          PERFORM trevra_h058_defer('workspace-column-validate', r.tbl,
            'backfilled workspace_id references a missing workspace; FK left NOT VALID. ' ||
            'Inspect: SELECT c.* FROM ' || r.tbl || ' c LEFT JOIN workspaces w ON w.id = c.workspace_id ' ||
            'WHERE c.workspace_id IS NOT NULL AND w.id IS NULL;');
        END;
      END IF;

      PERFORM trevra_h058_done('workspace-column', r.tbl);
    END IF;
  END LOOP;
END $$;


-- ===========================================================================
-- 6. `module_publishers` -- a global namespace on a tenant-owned table.
-- ===========================================================================
--
-- 007:7 and 007:10 make `slug` and `key_fingerprint` GLOBALLY unique on a table
-- that carries `owner_workspace_id`. Two things follow, and only one of them is
-- a bug:
--
--   * SLUG. First tenant to claim 'acme' owns it forever, across every other
--     tenant on the platform, and a failed claim is an existence oracle: the
--     error tells you a publisher you cannot see exists under that name. On a
--     hosted platform where tenants are strangers, that is a squatting surface
--     and an enumeration surface at once.
--   * KEY_FINGERPRINT. Also globally unique, and that one is CORRECT and must
--     stay correct under either option below. A fingerprint is a cryptographic
--     identity, not a name: two publishers presenting the same signing key is
--     not a namespace collision, it is a signature-verification collision, and
--     scoping it per tenant would let tenant B register tenant A's key and have
--     A's signed releases verify as B's. IT IS NOT A NAMESPACE. Leave it alone.
--
-- Another agent is deciding whether the registry is genuinely public (one
-- catalogue everyone browses) or per-tenant (each workspace's own shelf). Both
-- halves are written out below; NEITHER IS APPLIED by this file, because
-- applying the wrong one is a data migration in the opposite direction.
--
-- WHAT THE CODE WILL NEED: option A. The registry is browsed cross-tenant
-- (module_releases has a `visibility` column and idx_module_releases_public
-- orders a public feed), a module id is quoted in manifests and installs, and
-- `workspace_module_installations` references releases by (module_id, version)
-- with no workspace in the key -- so the namespace is already global in the
-- data model, and making the slug per-tenant would make a quoted module id
-- ambiguous. Option A keeps the global namespace and closes the two real holes
-- in it: case/whitespace squatting, and an unowned publisher surviving its
-- workspace. If the other agent decides the registry is per-tenant, option B is
-- the shape, and it is a bigger change than it looks -- see its note.
--
-- ---------------------------------------------------------------------------
-- OPTION A -- PUBLIC REGISTRY, ONE GLOBAL NAMESPACE (recommended).
-- ---------------------------------------------------------------------------
-- The slug stays globally unique because it is a public name, and the oracle is
-- accepted as inherent to a public namespace (npm, crates.io and Docker Hub all
-- have it). Two things still need fixing:
--
--   -- 1. Fold case and stop lookalike claims of the same name. Locks: SHARE on
--   --    module_publishers for the build (tiny table), then instant.
--   -- CREATE UNIQUE INDEX uq_module_publishers_slug_lower
--   --   ON module_publishers (lower(slug));
--   -- ALTER TABLE module_publishers DROP CONSTRAINT module_publishers_slug_key;
--   -- ALTER TABLE module_publishers
--   --   ADD CONSTRAINT module_publishers_slug_format
--   --   CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$') NOT VALID;
--   -- ALTER TABLE module_publishers VALIDATE CONSTRAINT module_publishers_slug_format;
--
--   -- 2. `owner_workspace_id` is ON DELETE SET NULL, so deleting a tenant
--   --    leaves an ownerless publisher still holding the slug -- a name nobody
--   --    can reclaim and nobody can prove title to. Publishers must be
--   --    retired explicitly rather than orphaned:
--   -- ALTER TABLE module_publishers
--   --   ADD COLUMN retired_at TIMESTAMPTZ;
--   -- (and the handler stops SET NULL-ing the owner; it retires the publisher
--   --  and releases the slug on a timer.)
--
-- Code impact of option A: publisher registration must lower() the slug before
-- insert and compare with lower(); the "slug taken" response must be identical
-- in shape and timing to a validation failure, so the oracle leaks no more than
-- the public catalogue already does.
--
-- ---------------------------------------------------------------------------
-- OPTION B -- PER-TENANT REGISTRY, ONE SHELF PER WORKSPACE.
-- ---------------------------------------------------------------------------
-- The slug is a name inside one workspace; two tenants may both have 'acme'.
--
--   -- ALTER TABLE module_publishers DROP CONSTRAINT module_publishers_slug_key;
--   -- CREATE UNIQUE INDEX uq_module_publishers_ws_slug
--   --   ON module_publishers (owner_workspace_id, lower(slug));
--   -- key_fingerprint STAYS globally unique -- see the note above; do NOT
--   -- rescope it.
--
-- AND THE PART THAT MAKES B EXPENSIVE, stated so it is not discovered later:
-- `owner_workspace_id` is NULLABLE with ON DELETE SET NULL, so under B the
-- uniqueness key is nullable and NULLs do not collide -- every ownerless
-- publisher would be able to re-claim any slug. B therefore requires
-- owner_workspace_id NOT NULL, which requires a sentinel workspace to own the
-- built-in publishers seeded by seedBuiltinModuleRegistry, which requires the
-- ON DELETE to become CASCADE or RESTRICT. Beyond the publisher table, module
-- ids stop being globally meaningful: module_packages.module_id (PRIMARY KEY),
-- module_releases (module_id, version), workspace_module_installations and
-- module_usage_metrics all key on a bare module_id, and every one of them would
-- need a workspace in its key. That is a schema-wide change, not this one
-- table.


-- ===========================================================================
-- Housekeeping: the helpers were scaffolding for this file only.
-- `schema_hardening_deferred` stays -- it is the record of what is still owed.
-- ===========================================================================
DROP FUNCTION IF EXISTS trevra_h058_cheap(regclass);
DROP FUNCTION IF EXISTS trevra_h058_defer(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS trevra_h058_done(TEXT, TEXT);
DROP FUNCTION IF EXISTS trevra_h058_has_cols(regclass, TEXT);
