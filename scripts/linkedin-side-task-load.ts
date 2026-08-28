/**
 * Sanity-check the LinkedIn background-maintenance floor.
 *
 * An idle but connected seat is allowed one thing autonomously: a bounded inbox
 * read so replies do not disappear from Trevra. This replays a week of 60s
 * worker ticks through the real visit/cadence functions and proves that the
 * result is a handful of visits, not the old every-minute polling loop.
 *
 * Run after changing side-task scheduling:
 *   npx tsx scripts/linkedin-side-task-load.ts
 */

import {
  SIDE_TASK_NAMES,
  VISIT_MARKER,
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
const START = new Date('2026-08-03T00:00:00.000Z');
const runs: SideTaskRuns = new Map();
let ticksInVisits = 0;
let maintenancePasses = 0;
let inboxRuns = 0;
let linkedinNavigations = 0;

for (let tick = 0; tick < (DAYS * 24 * 60 * 60_000) / TICK_MS; tick += 1) {
  const now = new Date(START.getTime() + tick * TICK_MS);
  const { visit, startedAt } = visitAt(SEAT, now);
  if (!visit || !startedAt) continue;
  ticksInVisits += 1;

  if (runs.get(VISIT_MARKER)?.getTime() === startedAt.getTime()) continue;
  const due = dueSideTasks(SEAT, runs, now);
  runs.set(VISIT_MARKER, startedAt);
  if (due.length === 0) continue;

  maintenancePasses += 1;
  // Lower bound for an empty inbox: one lightweight identity check and the
  // messaging rail. Browser arrival/departure are deliberately not counted as
  // LinkedIn page loads here.
  linkedinNavigations += 2;
  for (const task of due) {
    if (task === 'inbox') inboxRuns += 1;
    runs.set(task, now);
  }
}

const OLD_NAVIGATIONS_PER_TICK = 6;
const oldWeek = OLD_NAVIGATIONS_PER_TICK * ((DAYS * 24 * 60 * 60_000) / TICK_MS);
const maxWorkingVisits = 5 * 3;

process.stdout.write(`One connected idle seat, ${DAYS} days of 60s worker ticks\n\n`);
process.stdout.write(`  autonomous tasks               : ${SIDE_TASK_NAMES.join(', ')}\n`);
process.stdout.write(`  ticks inside visit windows     : ${ticksInVisits}\n`);
process.stdout.write(`  background maintenance passes  : ${maintenancePasses}\n`);
process.stdout.write(`  inbox syncs                    : ${inboxRuns}\n`);
process.stdout.write(`  LinkedIn navigation floor      : ${linkedinNavigations}\n`);
process.stdout.write(`  historical pre-hardening model : ${oldWeek} navigations/week\n`);

if (SIDE_TASK_NAMES.join(',') !== 'inbox') throw new Error('Only inbox may poll autonomously.');
if (inboxRuns < 1 || maintenancePasses > maxWorkingVisits)
  throw new Error('Inbox maintenance escaped the bounded visit model.');
if (linkedinNavigations >= oldWeek / 100)
  throw new Error('Background LinkedIn traffic is still too close to the historical polling loop.');
