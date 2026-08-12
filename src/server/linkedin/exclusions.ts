import { id, type Db } from '../db.js';

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
 * resolves it against LinkedIn, so matching is textual: trimmed, case-folded,
 * and otherwise literal -- the same rule `resolveLocalContact()` applies to
 * community handles, and the reason 025 indexes LOWER(target_ref).
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

/** The comparison key. Everything in this module folds through it exactly once. */
function normalize(targetRef: string): string {
  return targetRef.trim().toLowerCase();
}

export async function listExclusions(db: Db, workspaceId: string, limit = 500): Promise<LinkedInExclusion[]> {
  const rows = await db.prepare(`
    SELECT id, target_ref, reason, source, created_at FROM linkedin_exclusions
    WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?
  `).all<ExclusionRow>(workspaceId, Math.max(1, Math.min(limit, 5000)));
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

    const row = await db.prepare(`
      INSERT INTO linkedin_exclusions (id, workspace_id, target_ref, reason, source, created_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT (workspace_id, LOWER(target_ref)) DO UPDATE SET
        reason = EXCLUDED.reason,
        source = EXCLUDED.source
      RETURNING id, target_ref, reason, source, created_at, (xmax = 0) AS inserted
    `).get<ExclusionRow & { inserted: boolean }>(
      id('lexc'),
      workspaceId,
      targetRef,
      entry.reason?.trim() ?? '',
      entry.source ?? 'manual',
      timestamp
    );
    if (!row) continue;
    if (row.inserted) added += 1; else updated += 1;
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
 * One query for the whole list rather than one per target: an import is 500
 * rows, and 500 round trips to answer "is this person on a list of twelve" is
 * the kind of loop that only shows up in production.
 */
export async function filterExcluded(db: Db, workspaceId: string, targets: readonly string[]): Promise<ExclusionSplit> {
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

  const placeholders = candidates.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT LOWER(target_ref) AS key, reason FROM linkedin_exclusions
    WHERE workspace_id=? AND LOWER(target_ref) IN (${placeholders})
  `).all<{ key: string; reason: string }>(workspaceId, ...candidates.map(normalize));

  const reasons = new Map(rows.map((row) => [row.key, row.reason]));
  for (const target of candidates) {
    const reason = reasons.get(normalize(target));
    if (reason === undefined) kept.push(target);
    else excluded.push({ targetRef: target, reason });
  }
  return { kept, excluded };
}
