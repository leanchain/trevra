import { CircleAlert, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { LinkedInLimitConfidence } from './api';

/**
 * The LinkedIn screen's visual primitives.
 *
 * Hand-rolled SVG and CSS, no charting library, and every mark follows one set
 * of rules so four charts read as one system: thin marks, a 2px surface gap
 * between neighbours, hairline solid grid, values labelled selectively rather
 * than on every point, and a table view under every chart so no number is
 * reachable only by hovering. Colour is carried by the mark; text always wears
 * an ink token.
 *
 * The palette is the app's own green, stepped into a five-tone ordinal ramp for
 * the funnel and validated against a white surface (monotone lightness, >=0.06
 * OKLCH steps between neighbours, single hue, light end clearing 2:1). Red and
 * amber appear only where they MEAN something -- a breached variance band, an
 * acceptance rate under the floor -- never as "series 4".
 */

/**
 * The honesty rule, as a component.
 *
 * Every ceiling on this screen arrives from the server with a confidence tag
 * and a source, and this is the only thing that renders one. The operator is
 * betting their LinkedIn account on these numbers; a REPORTED number dressed as
 * a guarantee is the failure mode the whole screen exists to avoid, so the tag
 * travels with the number rather than sitting in a footnote.
 */
export function ConfidenceTag({
  confidence,
  source,
  compact
}: {
  confidence: LinkedInLimitConfidence;
  source?: string;
  compact?: boolean;
}) {
  const hard = confidence === 'HARD FACT';
  return (
    <span
      className={`li-tag ${hard ? 'li-tag-hard' : 'li-tag-reported'} ${compact ? 'li-tag-compact' : ''}`}
      title={
        hard
          ? `Published by LinkedIn or a contractual term. Source: ${source ?? 'docs/linkedin-outreach-plan.md'}`
          : `Practitioner telemetry, not published by LinkedIn. Directionally right, never a guarantee. Source: ${source ?? 'docs/linkedin-outreach-plan.md'}`
      }
    >
      {hard ? <ShieldCheck size={11} /> : <CircleAlert size={11} />}
      {confidence}
      {source && !compact && <small>{source}</small>}
    </span>
  );
}

export function LiStat({
  label,
  value,
  detail,
  tone
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  tone?: 'ok' | 'warn' | 'danger' | 'mute';
}) {
  return (
    <div className={`li-stat ${tone ? `li-stat-${tone}` : ''}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

/**
 * A word this product invented, defined where it is first met.
 *
 * RENDERED, not hovered. `title` is invisible on touch, invisible to most
 * screen readers, and invisible to anyone who does not already suspect there is
 * something under the cursor -- which is everyone meeting the word for the
 * first time. `Paced kind`, `posture`, `band ceiling` and `day-over-day clamp`
 * are terms an operator is betting a LinkedIn account on, so each one costs a
 * line of visible copy the first time it appears.
 */
export function Define({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <small className="li-hint">
      <b>{term}</b> — {children}
    </small>
  );
}

/* -------------------------------------------------------------------------
 * The window, shared.
 * ---------------------------------------------------------------------- */

/**
 * The windows the daily series may be read through.
 *
 * One list, in one place, because Safety and Analytics chart the SAME series
 * from the same route. A window that existed on one screen only was two
 * different answers to "how many days am I looking at".
 */
export const SERIES_RANGES = [7, 30, 90] as const;

export function WindowPicker({
  days,
  onDaysChange,
  loading,
  standalone
}: {
  days: number;
  onDaysChange: (days: number) => void;
  loading?: boolean;
  /** True at the top of a screen, false when it sits inside a panel above its chart. */
  standalone?: boolean;
}) {
  return (
    <div
      className={`li-filter-row${standalone ? ' li-filter-standalone' : ''}`}
      role="group"
      aria-label="Days of history to chart"
    >
      <span className="li-filter-label">Window</span>
      {SERIES_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          className={`li-range ${days === range ? 'is-active' : ''}`}
          aria-pressed={days === range}
          onClick={() => onDaysChange(range)}
        >
          {range} days
        </button>
      ))}
      {loading && <LoaderCircle className="spin" size={14} aria-label="Reloading the series" />}
    </div>
  );
}

/**
 * The chart's own box, measured, in CSS pixels.
 *
 * The SVG is then drawn at THAT width rather than at a fixed viewBox stretched
 * to fit, so one user unit is one CSS pixel and a 9px axis label renders at
 * 9px. A 760-unit viewBox in a 420px column is why axis text on this screen
 * came out at around five, and no amount of CSS on `.li-axis` fixes it from
 * the outside -- the whole coordinate system is being scaled, text with it.
 */

/* -------------------------------------------------------------------------
 * The funnel.
 * ---------------------------------------------------------------------- */

export interface FunnelStage {
  label: string;
  value: number;
  hint?: string;
}

/**
 * planned -> exported -> sent -> accepted -> replied.
 *
 * Horizontal bars on one baseline, not a trapezoid: a funnel drawing encodes
 * magnitude as a shape whose area nobody can compare, and the stages here are
 * an ordered scale, so they take an ordinal ramp of one hue rather than five
 * identities. The value rides the bar tip when it fits and sits outside it when
 * it does not -- a clipped label is worse than no label.
 */
export function FunnelBars({ stages }: { stages: readonly FunnelStage[] }) {
  const peak = Math.max(1, ...stages.map((stage) => stage.value));
  return (
    <div className="li-funnel">
      {stages.map((stage, index) => {
        const share = stage.value / peak;
        const inside = share > 0.22;
        return (
          <div className="li-funnel-row" key={stage.label}>
            <span className="li-funnel-label">
              {stage.label}
              {stage.hint && <small>{stage.hint}</small>}
            </span>
            <div className="li-funnel-track">
              <i
                className={`li-funnel-bar li-funnel-${index + 1}`}
                style={{ width: `${Math.max(share * 100, stage.value > 0 ? 1.5 : 0)}%` }}
              >
                {inside && <em>{stage.value}</em>}
              </i>
              {!inside && (
                <em className="li-funnel-outside" style={{ left: `${Math.max(share * 100, 0)}%` }}>
                  {stage.value}
                </em>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
