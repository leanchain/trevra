import 'dotenv/config';
import { runMigrations } from './db.js';

/**
 * The migration job: `npm run db:migrate` in development,
 * `node dist-server/server/migrate-job.js` in the shipped image.
 *
 * SEPARATE FROM BOOT ON PURPOSE. A hosted, multi-tenant Trevra runs this ONCE
 * per rollout -- as a Cloud Run job, a Kubernetes Job, a release phase -- and
 * its pods then verify the schema and refuse to start if it is behind (see
 * `openDatabase` in db.ts). Every replica racing to apply the same schema change
 * during its own health check is how a slow migration becomes a rolling
 * crashloop with nothing applied.
 *
 * It lives under src/server rather than scripts/ for one practical reason: the
 * runtime image is pruned of dev dependencies, so it has no `tsx` and can only
 * run what tsconfig.server.json compiled into dist-server.
 *
 * Safe to run twice, and safe to run while the previous build is still serving:
 * applied files are recorded in `schema_migrations` and the runner holds a
 * session-scoped advisory lock, so a second copy waits for the first and then
 * finds nothing to do.
 *
 * A self-hoster never needs it -- `npm start`, `npm run dev` and the test
 * harness all migrate on the way up unless TREVRA_DEPLOYMENT_MODE=hosted.
 */
const started = Date.now();
const { applied } = await runMigrations();
if (applied.length === 0) console.log('Trevra schema is current; nothing to apply.');
else console.log(`Trevra schema migrated in ${Date.now() - started}ms (${applied.length}): ${applied.join(', ')}`);
