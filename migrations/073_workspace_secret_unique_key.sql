-- THE UNIQUE KEY EVERY SECRET WRITE INFERS ON.
--
-- `putWorkspaceSecret` upserts with `ON CONFLICT (workspace_id, kind)`. Postgres
-- resolves that by finding a unique index whose key columns are EXACTLY those
-- two; anything else -- a wider index, a narrower one -- is not a match and the
-- statement fails outright with 42P10, "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification". Not a wrong row: no row,
-- and a 500 for the operator typing their LinkedIn password.
--
-- Migration 015 created that index as `idx_workspace_secrets_kind`. A dev
-- database was observed carrying `idx_workspace_secrets_kind_scope` UNIQUE
-- (workspace_id, kind, scope_key) INSTEAD -- a `scope_key` column that appears
-- nowhere in this repository or its history, so an out-of-band experiment
-- replaced the index and left the database unable to store any secret at all:
-- model keys, Reddit, LinkedIn, every kind.
--
-- This restores the index the code actually infers on. It does not touch the
-- wider one and does not drop a column: an extra unique index is harmless (its
-- key is a superset, so it can never reject a row this one accepts), and
-- dropping columns out from under a database nobody has read is not repair.
--
-- Idempotent and guarded: a fresh database already matches and this is a no-op.
DO $$
DECLARE
  duplicates INTEGER;
BEGIN
  IF to_regclass('public.workspace_secrets') IS NULL THEN
    RETURN;
  END IF;

  -- EXACTLY (workspace_id, kind), because that is what inference requires. A
  -- partial index (`indpred`) cannot serve an unqualified ON CONFLICT either,
  -- so it does not count as the index being present.
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = to_regclass('public.workspace_secrets')
      AND i.indisunique
      AND i.indpred IS NULL
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE k.ord <= i.indnkeyatts
      ) = ARRAY['kind', 'workspace_id']
  ) THEN
    RETURN;
  END IF;

  -- LOUD RATHER THAN ARBITRARY. Two rows for one (workspace_id, kind) means two
  -- different sealed values claiming to be the same secret, and no migration is
  -- entitled to pick one. Every read already assumes a single row, so this is a
  -- database somebody has to look at.
  SELECT count(*) INTO duplicates FROM (
    SELECT workspace_id, kind FROM workspace_secrets GROUP BY workspace_id, kind HAVING count(*) > 1
  ) AS d;
  IF duplicates > 0 THEN
    RAISE EXCEPTION '073: workspace_secrets holds % (workspace_id, kind) pair(s) with more than one row; the unique key cannot be restored until one row per pair remains', duplicates;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_secrets_kind
    ON workspace_secrets(workspace_id, kind);
  RAISE NOTICE '073: restored idx_workspace_secrets_kind on workspace_secrets(workspace_id, kind)';
END $$;
