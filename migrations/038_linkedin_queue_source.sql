-- An approved campaign queued for the local worker: `source = 'campaign'`.
--
-- WHY THIS MIGRATION CHANGES NO SCHEMA, which is the whole of it.
--
-- 022 created `linkedin_actions.source` as a plain `TEXT NOT NULL` and
-- documented its values in a comment -- 'export' | 'manual' | 'aggregator' --
-- with no CHECK. That was checked before this value was added rather than
-- assumed: there is no constraint on `source` to widen, so the only thing that
-- needs updating is the documentation the next reader will trust.
--
-- The same call 023 made about `provider`, 032 about the eighth `status`, 034
-- about three more `kind`s and 035 about `thread_urn`: this family's
-- enumerations live in TypeScript plus the comments that document the columns,
-- and adding a constraint to a live ledger whose history nobody has re-read is
-- a different and much riskier change than the one being made.
--
-- WHY 'campaign' IS NOT 'export', since both come from one approval. An
-- 'export' row was handed to a tool Trevra does not drive: it counts against
-- every ceiling the moment it is written (actions.ts COUNTED) precisely because
-- nobody will ever come back to confirm it. A 'campaign' row is one THIS
-- deployment intends to perform itself -- it is written 'planned', consumes no
-- budget yet, and gets a real `recorded_at` from `settleSent` when the worker
-- actually sends it. Filing both as 'export' would leave the ledger unable to
-- answer "what did this machine actually do", which is the question the whole
-- subsystem exists to answer, and it would mislabel a row rather than merely
-- lose a distinction.
--
-- NO NEW INDEX. Nothing filters on `source`; every query in this subsystem is
-- keyed by (workspace, seat, kind) plus a timestamp, and those are served by
-- idx_linkedin_actions_window and idx_linkedin_actions_claimable already.

COMMENT ON COLUMN linkedin_actions.source IS
  'export | manual | aggregator | campaign. Records who put the row here, so a '
  'ledger that later gains an aggregator stays readable. export = handed to the '
  'operator''s own tool (export.ts); manual = an operator action such as a '
  'queued inbox reply (inbox.ts); campaign = an approved campaign queued for '
  'this deployment''s own local worker (queue.ts). Not CHECK-constrained, on '
  'purpose: see migration 038, 034 and 023.';
