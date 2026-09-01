/**
 * Run every LinkedIn read the product performs, ONCE each, in ONE browser
 * sitting, and print what each one came back with.
 *
 * WHY IT EXISTS. Every one of these jobs is a claim about a page LinkedIn
 * serves today, and the suite can only check them against fakes written from
 * the same assumptions -- which is how a signed-in session came to be read as
 * signed out for a whole day. This is the cheapest honest answer: one sitting,
 * one pass per job, small caps, nothing sent.
 *
 *   docker exec <container> sh -lc 'npx tsx scripts/linkedin-action-check.mts <workspaceId>'
 *
 * READS ONLY, and deliberately so: the invite withdrawal job is included
 * because a sweep with nothing due is exactly the read it performs, and this
 * account has no pending invites. Nothing here composes, sends, connects or
 * follows.
 */
import { openDatabase } from '../src/server/db.js';
import { linkedInWorkerConfig } from '../src/server/config.js';
import { closeLinkedInBrowser } from '../src/server/linkedin/local-worker.js';
import {
  detectLinkedInAcceptances,
  runLinkedInLeadSources,
  runLinkedInWithdrawals,
  syncLinkedInConnections,
  syncLinkedInInbox,
  syncLinkedInPendingInvites
} from '../src/server/linkedin/jobs.js';

const workspaceId = process.argv[2];
if (!workspaceId) {
  console.error('usage: tsx scripts/linkedin-action-check.mts <workspaceId> [seatKey]');
  process.exit(2);
}
const seatKey = process.argv[3] ?? 'owner';

const db = await openDatabase({ seedDemo: false });
const config = linkedInWorkerConfig();
const log = (message: string) => console.log('   [worker]', message.slice(0, 180));
const shared = { workspaceId, seatKey, log };

const runs: Array<[string, () => Promise<unknown>]> = [
  ['inbox', () => syncLinkedInInbox(db, config, { ...shared, maxThreads: 3 })],
  ['pending invites', () => syncLinkedInPendingInvites(db, config, shared)],
  ['connections', () => syncLinkedInConnections(db, config, shared)],
  ['acceptance', () => detectLinkedInAcceptances(db, config, shared)],
  ['withdrawals', () => runLinkedInWithdrawals(db, config, { ...shared, maxActions: 1 })],
  ['lead sources', () => runLinkedInLeadSources(db, config, { ...shared, maxSources: 1 })]
];

let failures = 0;
for (const [name, run] of runs) {
  console.log(`\n== ${name}`);
  try {
    const result = (await run()) as { blocked?: string | null };
    console.log('  ', JSON.stringify(result));
    if (result?.blocked) failures += 1;
  } catch (error) {
    failures += 1;
    console.log('   THREW:', error instanceof Error ? error.message.slice(0, 200) : String(error));
  }
}

await closeLinkedInBrowser();
await db.close();
console.log(`\n${failures === 0 ? 'ALL CLEAR' : `${failures} job(s) blocked`}`);
process.exit(failures === 0 ? 0 : 1);
