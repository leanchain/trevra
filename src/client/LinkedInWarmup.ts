import type { LinkedInLimitsReport } from './api';

export function accountWarmupLabel(report: LinkedInLimitsReport | null): string | null {
  if (!report) return null;
  if (report.seat.warmupOverride) return 'account warm-up skipped';
  if (report.seat.warmupWeek > report.seat.warmupWeeks) return 'account warm-up complete';
  return `account warm-up week ${report.seat.warmupWeek}/${report.seat.warmupWeeks} · ${Math.round(report.seat.warmupMultiplier * 100)}% active outreach`;
}
