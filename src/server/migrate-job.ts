import 'dotenv/config';
import { openDatabase, runMigrations, type Db } from './db.js';
import { backfillWorkspaceOrganizations, closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { completeHostedDataMigrations } from './hosted-readiness.js';

/**
 * The release migration job. Hosted app/worker containers never mutate schema
 * on boot; this job owns application SQL, Better Auth schema, one-time
 * key-backed data transforms, and the legacy workspace→organization backfill.
 */
const started = Date.now();
let db: Db | null = null;
try {
  const { applied } = await runMigrations();
  await migrateAuthDatabase();

  db = await openDatabase({ seedDemo: false, autoMigrate: false });
  const data = await completeHostedDataMigrations(db);
  const authBackfill = await backfillWorkspaceOrganizations(db);

  if (applied.length === 0) console.log('Trevra schema is current; nothing to apply.');
  else console.log(`Trevra schema migrated in ${Date.now() - started}ms (${applied.length}): ${applied.join(', ')}`);
  if (data.migratedLegacySeatProxies > 0) {
    console.log(`Encrypted and cleared ${data.migratedLegacySeatProxies} legacy LinkedIn seat proxy credential(s).`);
  }
  if (authBackfill.created > 0 || authBackfill.skipped > 0) {
    console.log(`Better Auth organization backfill: created=${authBackfill.created}, skipped=${authBackfill.skipped}.`);
  }
} finally {
  await Promise.all([db?.close(), closeAuthDatabase()]);
}
