import type { Db } from './db.js';
import { assertNoLegacySeatProxyPlaintext, migrateLegacySeatProxies } from './linkedin/seats.js';

export interface HostedDataMigrationResult {
  migratedLegacySeatProxies: number;
}

/** Data transforms that require TREVRA_SECRETS_KEY and cannot live in SQL. */
export async function completeHostedDataMigrations(
  db: Db,
  env: NodeJS.ProcessEnv = process.env
): Promise<HostedDataMigrationResult> {
  const migratedLegacySeatProxies = await migrateLegacySeatProxies(db, env);
  await assertHostedDataReady(db, env);
  return { migratedLegacySeatProxies };
}

/**
 * Hosted boot invariant: no deferred tenant-isolation work and no credential-
 * bearing legacy proxy values left in plaintext.
 */
export async function assertHostedDataReady(
  db: Db,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (env.TREVRA_DEPLOYMENT_MODE !== 'hosted') return;

  const debt = await db.prepare(`
    SELECT item,table_name,detail
    FROM schema_hardening_deferred
    ORDER BY item,table_name
  `).all<{ item: string; table_name: string; detail: string }>();
  if (debt.length > 0) {
    const summary = debt.slice(0, 8).map((row) => `${row.item}:${row.table_name}`).join(', ');
    const extra = debt.length > 8 ? ` (+${debt.length - 8} more)` : '';
    throw new Error(
      `Hosted startup refused: ${debt.length} tenant-isolation hardening item(s) are still deferred (${summary}${extra}). `
      + 'Resolve the statements recorded in schema_hardening_deferred and rerun the migration job before serving traffic.'
    );
  }

  await assertNoLegacySeatProxyPlaintext(db, env);
}
