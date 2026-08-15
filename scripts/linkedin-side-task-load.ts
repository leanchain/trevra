/**
 * HOW MANY TIMES A DAY AN IDLE SEAT TOUCHES LINKEDIN, counted rather than
 * asserted.
 *
 * Replays a full week of 60-second worker ticks through the REAL visit and
 * cadence functions and counts the navigations each visit would make. Run it
 * after changing a band, so "much less" is a number:
 *
 *   npx tsx scripts/linkedin-side-task-load.ts
 */

import { visitsForDay } from '../src/server/linkedin/pacing.js';
import {
  SIDE_TASKS_NEEDING_IDENTITY,
  VISIT_MARKER,
  dueSideTasks,
  visitAt,
  type SideTaskName,
  type SideTaskRuns,
  type SideTaskSeat
} from '../src/server/linkedin/side-tasks.js';

/** The default seat: Mon-Fri, 08:00-18:00, UTC. */
const SEAT: SideTaskSeat = {
  workspaceId: 'ws_load_model',
  seatKey: 'owner',
  timezone: 'UTC',
  workingDays: [1, 2, 3, 4, 5],
  workStartMinute: 8 * 60,
  workEndMinute: 18 * 60
};

/**
 * Navigations each job makes on an IDLE account -- empty inbox, no pending
 * invites, no queued withdrawals, no lead sources. This is the floor: the
 * number Trevra costs when it has nothing to do, which is the number that got
 * the account restricted.
 */
const NAVIGATIONS: Record<SideTaskName, number> = {
  inbox: 1, // /messaging/ -- plus one per conversation, of which there are none
  pending_invites: 1, // /mynetwork/invitation-manager/sent/
  acceptance: 0, // opens a profile per vanished invite; none
  withdrawals: 0, // drains a queue; empty
  lead_sources: 0 // walks pending sources; none
};

/** `warmUpSession`: the feed, plus a notifications/My Network glance ~55% of the time. */
const ARRIVAL_NAVIGATIONS = 1.55;
/** `confirmSeatAccount` -> `readSeat`, which is now one page and not two. */
const IDENTITY_NAVIGATIONS = 1;
/** `about:blank` at the end of the visit. Not a LinkedIn page load. */
const DEPARTURE_NAVIGATIONS = 0;

const TICK_MS = 60_000;
const DAYS = 7;
const START = new Date('2026-08-03T00:00:00.000Z'); // a Monday

const runs: SideTaskRuns = new Map();
let ticksInAVisit = 0;
let workingVisits = 0;
let navigations = 0;
let identityLoads = 0;
const perTask: Record<string, number> = {};
const seenVisits = new Set<string>();

for (let tick = 0; tick < (DAYS * 24 * 60 * 60_000) / TICK_MS; tick += 1) {
  const now = new Date(START.getTime() + tick * TICK_MS);
  const { visit, startedAt } = visitAt(SEAT, now);
  if (!visit || !startedAt) continue;
  ticksInAVisit += 1;
  seenVisits.add(`${now.toISOString().slice(0, 10)}#${visit.index}`);

  // ONE PASS PER VISIT, exactly as `runLinkedInSideTasks` enforces it.
  const lastVisit = runs.get(VISIT_MARKER);
  if (lastVisit && lastVisit.getTime() === startedAt.getTime()) continue;

  const due = dueSideTasks(SEAT, runs, now);
  runs.set(VISIT_MARKER, startedAt);
  if (due.length === 0) continue;

  workingVisits += 1;
  navigations += ARRIVAL_NAVIGATIONS + DEPARTURE_NAVIGATIONS;
  if (due.some((task) => SIDE_TASKS_NEEDING_IDENTITY.has(task))) {
    identityLoads += 1;
    navigations += IDENTITY_NAVIGATIONS;
  }
  for (const task of due) {
    perTask[task] = (perTask[task] ?? 0) + 1;
    navigations += NAVIGATIONS[task];
    runs.set(task, now);
  }
}

/** What the same week cost before: five jobs, every tick, round the clock. */
const BEFORE_PER_TICK = 6;
const beforeWeek = BEFORE_PER_TICK * ((DAYS * 24 * 60 * 60_000) / TICK_MS);

/**
 * THE SAME DAY WITH SENDING IN IT, which is the point of unifying the two.
 *
 * The planner places its slots inside these same visits and the visits stretch
 * to hold them, so an outreach day is not "reads in three bursts plus sends on
 * a metronome" -- it is the same three bursts, longer.
 */
const STEADY_DAILY_INVITES = 18;
const sendingDay = visitsForDay(`${SEAT.workspaceId}:${SEAT.seatKey}`, { year: 2026, month: 8, day: 4 }, { startMinute: 480, endMinute: 1080 }, { actions: STEADY_DAILY_INVITES });
const sendingMinutes = sendingDay.reduce((total, visit) => total + (visit.endMinute - visit.startMinute), 0);
const idleDay = visitsForDay(`${SEAT.workspaceId}:${SEAT.seatKey}`, { year: 2026, month: 8, day: 4 }, { startMinute: 480, endMinute: 1080 });
const idleMinutes = idleDay.reduce((total, visit) => total + (visit.endMinute - visit.startMinute), 0);

process.stdout.write(`One idle seat, ${DAYS} days of 60s ticks, Mon-Fri 08:00-18:00 UTC\n\n`);
process.stdout.write(`  visits scheduled             : ${seenVisits.size}  (${(seenVisits.size / 5).toFixed(1)} per working day)\n`);
process.stdout.write(`  visits that did any work     : ${workingVisits}\n`);
process.stdout.write(`  minutes with LinkedIn open   : ${ticksInAVisit}  (${(ticksInAVisit / 5).toFixed(1)} per working day)\n`);
process.stdout.write(`  /in/me/ identity loads       : ${identityLoads}\n`);
process.stdout.write(`  connections-page loads       : 0\n`);
process.stdout.write(`  TOTAL navigations            : ${navigations.toFixed(0)}  (${(navigations / DAYS).toFixed(1)}/day)\n\n`);
for (const task of Object.keys(perTask).sort()) {
  process.stdout.write(`  ${task.padEnd(16)} ran ${perTask[task]} times\n`);
}
process.stdout.write(`\n  before this change           : ${beforeWeek} navigations (${beforeWeek / DAYS}/day)\n`);
process.stdout.write(`  reduction                    : ${(100 - (navigations / beforeWeek) * 100).toFixed(2)}%\n`);

process.stdout.write(`\nOne day's visits, reading only vs sending ${STEADY_DAILY_INVITES} invites -- SAME visits, longer:\n\n`);
process.stdout.write(`  reading only  : ${idleDay.length} visits, ${idleMinutes} minutes open\n`);
for (const visit of idleDay) {
  process.stdout.write(`      ${clock(visit.startMinute)}-${clock(visit.endMinute)}\n`);
}
process.stdout.write(`  sending too   : ${sendingDay.length} visits, ${sendingMinutes} minutes open\n`);
for (const visit of sendingDay) {
  process.stdout.write(`      ${clock(visit.startMinute)}-${clock(visit.endMinute)}  ${visit.actions} invite(s)\n`);
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
