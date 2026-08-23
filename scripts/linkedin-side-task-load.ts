/**
 * Sanity-check the LinkedIn background-maintenance floor.
 *
 * An idle seat must produce zero LinkedIn browser work. The unattended
 * scheduler only considers withdrawals that were already explicitly queued by
 * an operator/workflow; inbox, pending-invite, acceptance and lead-source reads
 * are operator-triggered only.
 *
 * Run after changing side-task scheduling:
 *
 *   npx tsx scripts/linkedin-side-task-load.ts
 */

import {
  dueSideTasks,
  visitAt,
  type SideTaskRuns,
  type SideTaskSeat
} from '../src/server/linkedin/side-tasks.js';

const SEAT: SideTaskSeat = {
  workspaceId: 'ws_load_model',
  seatKey: 'owner',
  timezone: 'UTC',
  workingDays: [1, 2, 3, 4, 5],
  workStartMinute: 8 * 60,
  workEndMinute: 18 * 60
};

const TICK_MS = 60_000;
const DAYS = 7;
const START = new Date('2026-08-03T00:00:00.000Z'); // Monday
const runs: SideTaskRuns = new Map();

// This script models an IDLE account: there is no explicitly queued withdrawal.
const queuedWithdrawals = 0;
let ticksInsideConfiguredWindow = 0;
let eligibleMaintenancePasses = 0;
let linkedinNavigations = 0;

for (let tick = 0; tick < (DAYS * 24 * 60 * 60_000) / TICK_MS; tick += 1) {
  const now = new Date(START.getTime() + tick * TICK_MS);
  const { visit } = visitAt(SEAT, now);
  if (!visit) continue;
  ticksInsideConfiguredWindow += 1;

  const due = dueSideTasks(SEAT, runs, now).filter(
    (task) => task !== 'withdrawals' || queuedWithdrawals > 0
  );
  if (due.length === 0) continue;

  // `runLinkedInSideTasks` opens a browser only after this same queue check.
  eligibleMaintenancePasses += 1;
  linkedinNavigations += 1; // conservative lower bound: the requested LinkedIn surface
  for (const task of due) runs.set(task, now);
}

const OLD_NAVIGATIONS_PER_TICK = 6;
const oldWeek = OLD_NAVIGATIONS_PER_TICK * ((DAYS * 24 * 60 * 60_000) / TICK_MS);

process.stdout.write(`One idle seat, ${DAYS} days of 60s worker ticks\n\n`);
process.stdout.write(`  ticks inside configured window : ${ticksInsideConfiguredWindow}\n`);
process.stdout.write(`  queued withdrawals             : ${queuedWithdrawals}\n`);
process.stdout.write(`  background browser passes      : ${eligibleMaintenancePasses}\n`);
process.stdout.write(`  LinkedIn navigations            : ${linkedinNavigations}\n`);
process.stdout.write(`  historical pre-hardening model  : ${oldWeek} navigations/week\n`);

if (eligibleMaintenancePasses !== 0 || linkedinNavigations !== 0) {
  throw new Error('Idle LinkedIn maintenance must produce zero browser work.');
}
