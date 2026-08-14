# Migrations

Every `*.sql` file in this directory is applied once, in filename order, and
recorded in `schema_migrations`. The runner is `runMigrations()` in
`src/server/db.ts`; the job that calls it is `npm run db:migrate`.

## What the runner does

- **One transaction per file.** A file either lands whole or not at all, and a
  failure at file 9 leaves 1-8 applied and recorded. Do not rely on a previous
  file in this run still being uncommitted -- it is not.
- **No statement timeout.** The migration connection is its own connection with
  `statement_timeout = 0`, so a data-rewriting pass over millions of rows is
  allowed to take as long as it takes. Request pools still cap statements at 30s.
- **A short `lock_timeout`** (`DATABASE_MIGRATION_LOCK_TIMEOUT_MS`, default 10s).
  A migration that cannot get its `AccessExclusiveLock` fails instead of
  queueing, because a waiting `ALTER TABLE` blocks every query that arrives
  behind it. Retry it in a quieter minute rather than raising this.
- **A session-scoped advisory lock**, so several replicas or two copies of the
  job can start at once and only one applies anything.

## The non-transactional lane

Some statements cannot run inside a transaction block at all. The important one
is `CREATE INDEX CONCURRENTLY`, which is the only way to add an index to a live
multi-tenant table without blocking writes on it for the duration of the build.

A file opts out of its transaction with **a line of its own, anywhere in the
file**:

```sql
-- trevra:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_seat_due
  ON linkedin_actions (workspace_id, seat_key, planned_for);
```

The marker must match `^[ \t]*--[ \t]*trevra:no-transaction[ \t]*$` exactly --
no trailing prose on the same line. The file is then split at top-level
semicolons and each statement is sent on its own round trip, with no `BEGIN`
around any of them. (Several statements in one message would still be run inside
an implicit transaction block, and `CREATE INDEX CONCURRENTLY` would still be
refused.)

Rules for files in this lane, because **nothing here is rolled back**:

1. **Every statement must be idempotent.** `IF NOT EXISTS` on creates, `IF
   EXISTS` on drops. A file that fails halfway leaves its earlier statements
   applied and records nothing, so the retry runs the file again from the top.
2. **Index builds and similar, not data rewrites.** A half-applied `UPDATE`
   backfill has no transaction to undo it. Put the backfill in an ordinary
   transactional migration and the `CREATE INDEX CONCURRENTLY` in its own file.
3. **Do not put the marker on a file that does not need it.** The transaction is
   the safe default.
4. **A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind.**
   `IF NOT EXISTS` will then find it and skip -- so drop it (`DROP INDEX IF
   EXISTS ...`) as the first statement of the same file, or give the retry a new
   name.

Dollar-quoted bodies (`DO $$ ... $$`), nested `/* */` comments and semicolons
inside string literals are all handled by the splitter, so a `DO` block in this
lane is fine.

## Writing a migration for a hosted deployment

- Additive first: add nullable columns and new tables in one release, backfill in
  the next, add the `NOT NULL` or the unique index in a third. An old pod is
  still serving while the job runs.
- A unique index on a large live table belongs in the non-transactional lane
  (`CREATE UNIQUE INDEX CONCURRENTLY`).
- Long backfills should be written so a retry is cheap -- guard them on the
  state they set, rather than rewriting every row a second time.
