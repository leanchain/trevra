import { id, type Db } from '../db.js';
import { canonicalProfileUrl } from './driver-scrape.js';

/**
 * The LinkedIn blacklist: people this workspace will not contact again.
 *
 * WHERE IT IS APPLIED IS THE WHOLE DESIGN. Exclusions are consulted before a
 * plan is produced and before a campaign starts, never at send time. An
 * exclusion enforced later would still have put the person into a payload a
 * founder read, approved and hash-bound -- so the person would have been
 * "excluded" from a campaign that already had their name in it, and the
 * approval record would say otherwise.
 *
 * `target_ref` is the same opaque handle-or-URL the ledger stores. Trevra never
 * resolves it against LinkedIn, so matching is textual, not a lookup -- but
 * "textual" cannot mean "literal" for a LinkedIn URL, because a harvested href
 * carries `?miniProfileUrn=...` every single time and an operator typing an
 * exclusion by hand never does. `normalize()` folds a target through the same
 * `canonicalProfileUrl` the scraper and `leads.ts`'s suppression check use, so
 * `linkedin.com/in/jonas` and a harvested `.../in/jonas/?trk=x` are one row --
 * only a ref that is not a LinkedIn handle-or-URL at all falls back to plain
 * trim-and-lowercase, the same rule `resolveLocalContact()` applies to
 * community handles.
 *
 * There is no removal route, and that is deliberate rather than unfinished.
 * The list's main population is people who asked to be left alone, and a
 * person who asked does not stop having asked. Removing one is a database
 * operation somebody has to mean.
 */

export interface LinkedInExclusion {
  id: string;
  targetRef: string;
  reason: string;
  source: string;
  createdAt: string;
}

interface ExclusionRow {
  id: string;
  target_ref: string;
  reason: string;
  source: string;
  created_at: string;
}

function toExclusion(row: ExclusionRow): LinkedInExclusion {
  return {
    id: row.id,
    targetRef: row.target_ref,
    reason: row.reason,
    source: row.source,
    createdAt: row.created_at
  };
}

/**
 * The comparison key. Everything in this module folds through it exactly once.
 *
 * `canonicalProfileUrl` expands a bare handle and drops a URL's query and
 * fragment -- the same reduction `leads.ts` applies before checking a
 * harvested profile against this same table (see `refSet` there). Routing
 * both sides of every comparison here through it is what makes a plain
 * `linkedin.com/in/jonas` exclusion catch a harvested
 * `.../in/jonas/?trk=x&miniProfileUrn=...` variant of the same profile. A ref
 * that is not a LinkedIn handle-or-URL -- another platform's handle, say --
 * canonicalizes to null and falls back to plain trim-and-lowercase, which is
 * the whole of what this function used to do.
 */
function normalize(targetRef: string): string {
  const trimmed = targetRef.trim();
  return (canonicalProfileUrl(trimmed) ?? trimmed).toLowerCase();
}

export async function listExclusions(
  db: Db,
  workspaceId: string,
  limit = 500
): Promise<LinkedInExclusion[]> {
  const rows = await db
    .prepare(
      `
    SELECT id, target_ref, reason, source, created_at FROM linkedin_exclusions
    WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?
  `
    )
    .all<ExclusionRow>(workspaceId, Math.max(1, Math.min(limit, 5000)));
  return rows.map(toExclusion);
}

export interface ExclusionInput {
  targetRef: string;
  reason?: string;
  source?: string;
}

/**
 * Add targets to the list.
 *
 * Re-adding an existing target UPDATES its reason rather than writing a second
 * row: the list is a set of people, not a log of decisions, and two rows for
 * one person is two rows to keep in agreement. `added` counts rows that were
 * new, so a caller can tell "3 excluded" from "3 already were".
 */
export async function addExclusions(
  db: Db,
  workspaceId: string,
  entries: readonly ExclusionInput[],
  now: Date
): Promise<{ exclusions: LinkedInExclusion[]; added: number; updated: number }> {
  const timestamp = now.toISOString();
  const seen = new Set<string>();
  const exclusions: LinkedInExclusion[] = [];
  let added = 0;
  let updated = 0;

  for (const entry of entries) {
    const targetRef = entry.targetRef.trim();
    if (!targetRef) continue;
    // Two spellings of one handle inside one request are one exclusion; the
    // unique index would otherwise make the second one an error rather than a
    // no-op, because ON CONFLICT cannot see a row this same statement inserted.
    const key = normalize(targetRef);
    if (seen.has(key)) continue;
    seen.add(key);

    const row = await db
      .prepare(
        `
      INSERT INTO linkedin_exclusions (id, workspace_id, target_ref, reason, source, created_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT (workspace_id, LOWER(target_ref)) DO UPDATE SET
        reason = EXCLUDED.reason,
        source = EXCLUDED.source
      RETURNING id, target_ref, reason, source, created_at, (xmax = 0) AS inserted
    `
      )
      .get<ExclusionRow & { inserted: boolean }>(
        id('lexc'),
        workspaceId,
        targetRef,
        entry.reason?.trim() ?? '',
        entry.source ?? 'manual',
        timestamp
      );
    if (!row) continue;
    if (row.inserted) added += 1;
    else updated += 1;
    exclusions.push(toExclusion(row));
  }

  return { exclusions, added, updated };
}

export interface ExclusionSplit {
  /** Targets that survive, in the order they arrived, de-duplicated. */
  kept: string[];
  /** Targets that are on the list, with the reason an operator gave. */
  excluded: Array<{ targetRef: string; reason: string }>;
}

/**
 * Split a target list against the blacklist.
 *
 * ONE QUERY FOR THE WHOLE LIST, not a `WHERE ... IN (...)` keyed on the
 * literal text: a SQL-side `LOWER(target_ref)` compare cannot undo
 * `canonicalProfileUrl`'s query-stripping, so it would miss exactly the
 * tracking-param variant this match rule exists to catch. The list is
 * bounded the same way `listExclusions` treats it -- people who asked to be
 * left alone, not a row per action -- so reading it whole and comparing
 * normalized forms in JS is the same trade `leads.ts`'s `suppressionSets`
 * makes against this identical table.
 */
export async function filterExcluded(
  db: Db,
  workspaceId: string,
  targets: readonly string[]
): Promise<ExclusionSplit> {
  const kept: string[] = [];
  const excluded: Array<{ targetRef: string; reason: string }> = [];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const target of targets) {
    const trimmed = target.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(trimmed);
  }
  if (candidates.length === 0) return { kept, excluded };

  const rows = await db
    .prepare('SELECT target_ref, reason FROM linkedin_exclusions WHERE workspace_id=?')
    .all<{ target_ref: string; reason: string }>(workspaceId);

  const reasons = new Map<string, string>();
  for (const row of rows) {
    const raw = row.target_ref?.trim();
    if (!raw) continue;
    reasons.set(normalize(raw), row.reason);
  }

  for (const target of candidates) {
    const reason = reasons.get(normalize(target));
    if (reason === undefined) kept.push(target);
    else excluded.push({ targetRef: target, reason });
  }
  return { kept, excluded };
}
