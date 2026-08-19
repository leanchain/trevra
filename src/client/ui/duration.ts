/**
 * One vocabulary for every duration in the app.
 *
 * There were three formatters saying the same things three ways -- how long a
 * step took, how often a job repeats, how stale a session is -- so the same
 * span of time read differently depending on which screen you were on. These
 * are the three questions; each has exactly one answer here.
 */

/** How long something took: "820ms", "1.4s", "2m 10s", "1h 04m". */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** How often something repeats, said the way a person says it. */
export function formatEvery(minutes: number): string {
  const ladder: Array<[size: number, one: string, many: (count: number) => string]> = [
    [10080, 'Once a week', (count) => `Every ${count} weeks`],
    [1440, 'Once a day', (count) => `Every ${count} days`],
    [60, 'Every hour', (count) => `Every ${count} hours`]
  ];
  for (const [size, one, many] of ladder) {
    if (minutes > 0 && minutes % size === 0) {
      const count = minutes / size;
      return count === 1 ? one : many(count);
    }
  }
  return `Every ${minutes} minutes`;
}
