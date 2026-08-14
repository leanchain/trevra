import { useEffect, useRef, useState } from 'react';
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
export function ConfidenceTag({ confidence, source, compact }: {
  confidence: LinkedInLimitConfidence;
  source?: string;
  compact?: boolean;
}) {
  const hard = confidence === 'HARD FACT';
  return <span
    className={`li-tag ${hard ? 'li-tag-hard' : 'li-tag-reported'} ${compact ? 'li-tag-compact' : ''}`}
    title={hard
      ? `Published by LinkedIn or a contractual term. Source: ${source ?? 'docs/linkedin-outreach-plan.md'}`
      : `Practitioner telemetry, not published by LinkedIn. Directionally right, never a guarantee. Source: ${source ?? 'docs/linkedin-outreach-plan.md'}`}
  >
    {hard ? <ShieldCheck size={11} /> : <CircleAlert size={11} />}
    {confidence}
    {source && !compact && <small>{source}</small>}
  </span>;
}

export function LiStat({ label, value, detail, tone }: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  tone?: 'ok' | 'warn' | 'danger' | 'mute';
}) {
  return <div className={`li-stat ${tone ? `li-stat-${tone}` : ''}`}>
    <p>{label}</p>
    <strong>{value}</strong>
    {detail && <span>{detail}</span>}
  </div>;
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
  return <small className="li-hint"><b>{term}</b> — {children}</small>;
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

export function WindowPicker({ days, onDaysChange, loading, standalone }: {
  days: number;
  onDaysChange: (days: number) => void;
  loading?: boolean;
  /** True at the top of a screen, false when it sits inside a panel above its chart. */
  standalone?: boolean;
}) {
  return <div
    className={`li-filter-row${standalone ? ' li-filter-standalone' : ''}`}
    role="group"
    aria-label="Days of history to chart"
  >
    <span className="li-filter-label">Window</span>
    {SERIES_RANGES.map((range) => <button
      key={range}
      type="button"
      className={`li-range ${days === range ? 'is-active' : ''}`}
      aria-pressed={days === range}
      onClick={() => onDaysChange(range)}
    >{range} days</button>)}
    {loading && <LoaderCircle className="spin" size={14} aria-label="Reloading the series" />}
  </div>;
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
function useFrameWidth(fallback: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.round(entries[0].contentRect.width);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/* -------------------------------------------------------------------------
 * Geometry helpers.
 * ---------------------------------------------------------------------- */

/** A column with a 4px rounded cap and a square baseline, per the mark spec. */
function columnPath(x: number, y: number, width: number, height: number, radius = 4): string {
  if (height <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  return `M${x} ${y + height} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} L${x + width - r} ${y} Q${x + width} ${y} ${x + width} ${y + r} L${x + width} ${y + height} Z`;
}

/** Clean axis ticks: 0, then two or three round steps to the top of the data. */
function ticksFor(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(Math.round(value * 100) / 100);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function isWeekendDate(date: string): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * One bucket of the daily series, named.
 *
 * TWO DECISIONS THAT LOOK ALIKE AND ARE NOT. The LOCALE was 'en-GB' -- one
 * operator's day-before-month order and English month names shipped to every
 * reader -- and it is now the browser's, which spells and orders the date the
 * way the person reading the chart writes it.
 *
 * `timeZone: 'UTC'` STAYS, AND POINTING IT AT THE SEAT'S ZONE WOULD MAKE THIS
 * LABEL LIE. `date` is not an instant: it is a UTC CALENDAR BUCKET the server
 * has already grouped by -- `linkedinAnalytics` in
 * src/server/linkedin/campaigns.ts buckets on COALESCE(recorded_at,
 * planned_for, created_at) in UTC -- so what arrives here is one total per day
 * and not the moments inside it. Re-rendering that bucket in Australia/Sydney
 * would move the LABEL a day for a far-eastern zone while the NUMBER under it
 * stayed in the bucket it was counted in: a caption naming the wrong column,
 * which is worse than a caption naming a zone that is not yours. The noon
 * anchor is what keeps label and bucket equal for every zone this can be read
 * in.
 *
 * Seat-local buckets would be the real improvement and they are a SERVER
 * change: the route would have to group in the seat's zone, or hand back the
 * instants for the client to group itself. Until it does, the chart says which
 * day it means -- the note under it in LinkedInSafety carries that sentence.
 */
const dayLabel = (date: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  .format(new Date(`${date}T12:00:00Z`));

/* -------------------------------------------------------------------------
 * The volume chart.
 * ---------------------------------------------------------------------- */

export interface VolumePoint {
  /** 'YYYY-MM-DD', UTC -- the bucket the analytics series uses. */
  date: string;
  /** Actions that provably went out that day: sent + accepted + replied. */
  volume: number;
  /** Planned but not yet out. Context only; it is not plotted as a second series. */
  planned: number;
}

interface VolumeBand {
  lower: number;
  upper: number;
  /** The previous business day this band was derived from. Null on the first day and at weekends. */
  anchor: number | null;
}

/**
 * The band, computed exactly the way the engine computes its clamp.
 *
 * `previousBusinessDayCount` in pacing.ts skips weekend buckets on purpose --
 * WEEKEND_FACTOR is 0, so seeding Monday from Sunday would reset the ramp every
 * week and manufacture the weekly sawtooth the engine exists to avoid. The
 * chart has to skip them for the same reason, or it would draw a band nobody is
 * ever measured against.
 */
function varianceBands(points: readonly VolumePoint[], maxDelta: number, minRampStep: number): VolumeBand[] {
  return points.map((point, index) => {
    if (isWeekendDate(point.date)) return { lower: 0, upper: 0, anchor: null };
    let anchor: number | null = null;
    for (let back = index - 1; back >= 0; back -= 1) {
      if (isWeekendDate(points[back].date)) continue;
      anchor = points[back].volume;
      break;
    }
    if (anchor === null) return { lower: 0, upper: 0, anchor: null };
    // MIN_RAMP_STEP is in the ceiling for a reason a chart must not drop: a
    // ratio clamp cannot leave zero (0 x 1.35 = 0) and cannot move integers
    // near it, so a cold seat would be frozen forever and every first action
    // would be drawn as a breach. Going from 0 to 1 is an integer, not a surge.
    return {
      lower: anchor * (1 - maxDelta),
      upper: Math.max(anchor * (1 + maxDelta), anchor + minRampStep),
      anchor
    };
  });
}

/**
 * Daily volume with the day-over-day variance band drawn on it.
 *
 * The band is the point of the chart, not decoration: plan 1.3 says detection
 * is behavioural, so 20/20/20/0/0/0/20 is more dangerous than a flat 12/day
 * even though every day is under the cap. A column that leaves the band is the
 * shape that gets accounts restricted, and it is drawn in the danger tone for
 * exactly that reason -- it is a state, not a series.
 */
export function VolumeChart({ points, maxDelta, minRampStep, caption }: {
  points: readonly VolumePoint[];
  maxDelta: number;
  /** The absolute floor on a step up, so a cold ledger is not drawn as frozen. */
  minRampStep: number;
  caption: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [frameRef, frameWidth] = useFrameWidth(760);
  // `.li-chart` caps the drawn chart at 760px, so the intrinsic width is capped
  // to match it: a viewBox wider than the box it lands in is exactly what
  // shrinks a 13px axis label to nine.
  const width = Math.max(300, Math.min(760, frameWidth));
  const height = 210;
  const padding = { top: 14, right: 12, bottom: 30, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const bands = varianceBands(points, maxDelta, minRampStep);
  const peak = Math.max(1, ...points.map((point) => point.volume), ...bands.map((band) => band.upper));
  const ticks = ticksFor(peak);
  const top = ticks[ticks.length - 1];
  const y = (value: number) => padding.top + plotHeight - (value / top) * plotHeight;
  const slot = plotWidth / Math.max(1, points.length);
  const barWidth = Math.max(3, Math.min(24, slot - 2));

  const breaches = points.filter((point, index) => {
    const band = bands[index];
    return band.anchor !== null && (point.volume > band.upper + 0.001 || point.volume < band.lower - 0.001);
  }).length;

  const hovered = hover === null ? null : points[hover];
  const hoveredBand = hover === null ? null : bands[hover];

  return <figure className="li-figure">
    <figcaption>
      <span>{caption}</span>
      <span className="li-key">
        <i className="li-key-band" /> ±{Math.round(maxDelta * 100)}% of the previous business day
        <i className="li-key-dot" /> actions that went out
        {breaches > 0 && <><i className="li-key-dot li-key-danger" /> outside the band</>}
      </span>
    </figcaption>
    <div className="li-chart-frame" ref={frameRef}>
      <svg viewBox={`0 0 ${width} ${height}`} className="li-chart" role="img"
        aria-label={`Daily LinkedIn volume across ${points.length} days: ${points.reduce((sum, point) => sum + point.volume, 0)} actions went out, `
          + `busiest day ${Math.max(0, ...points.map((point) => point.volume))}. `
          + `The shaded band is ±${Math.round(maxDelta * 100)} percent of the previous business day, and `
          + `${breaches === 0 ? 'no day falls outside it' : `${breaches} day(s) fall outside it`}.`}>
        {ticks.map((tick) => <g key={tick}>
          <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} className="li-grid" />
          <text x={padding.left - 7} y={y(tick) + 3} className="li-axis li-axis-y">{tick}</text>
        </g>)}

        {/* The band, stepped per day: it is re-derived from a different anchor
            every morning, so a smooth ribbon would be a nicer lie. */}
        {bands.map((band, index) => band.anchor === null ? null : (
          <g key={`band-${points[index].date}`}>
            <rect
              x={padding.left + index * slot}
              width={slot}
              y={y(band.upper)}
              height={Math.max(1, y(band.lower) - y(band.upper))}
              className="li-band" />
            {/* The ceiling of the band, drawn as a hairline so it stays legible
                where a column sits on top of the wash. This is the edge the
                clamp actually enforces -- a day may not exceed it. */}
            <line x1={padding.left + index * slot} x2={padding.left + (index + 1) * slot}
              y1={y(band.upper)} y2={y(band.upper)} className="li-band-line" />
          </g>
        ))}

        {points.map((point, index) => {
          const band = bands[index];
          const outside = band.anchor !== null && (point.volume > band.upper + 0.001 || point.volume < band.lower - 0.001);
          const barHeight = padding.top + plotHeight - y(point.volume);
          const x = padding.left + index * slot + (slot - barWidth) / 2;
          return <g key={point.date}>
            {point.volume > 0 && <path
              d={columnPath(x, y(point.volume), barWidth, barHeight)}
              className={outside ? 'li-column li-column-danger' : 'li-column'} />}
            {/* Hit target spans the full slot height, so a 1-action day is as
                easy to hover as a 20-action one. */}
            <rect x={padding.left + index * slot} y={padding.top} width={slot} height={plotHeight}
              className="li-hit" tabIndex={0}
              onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(index)} onBlur={() => setHover(null)}>
              <title>{`${dayLabel(point.date)}: ${point.volume} out${band.anchor === null ? '' : `, band ${band.lower.toFixed(1)}-${band.upper.toFixed(1)}`}`}</title>
            </rect>
          </g>;
        })}

        {points.map((point, index) => index % 5 === 0 || index === points.length - 1
          ? <text key={`tick-${point.date}`} x={padding.left + index * slot + slot / 2} y={height - 10} className="li-axis">{dayLabel(point.date)}</text>
          : null)}
      </svg>
      {hovered && hoveredBand && <div className="li-tooltip" style={{ left: `${((hover! + 0.5) / points.length) * 100}%` }}>
        <strong>{dayLabel(hovered.date)}</strong>
        <span>{hovered.volume} went out</span>
        {hovered.planned > 0 && <span>{hovered.planned} still planned</span>}
        <span>{hoveredBand.anchor === null
          ? isWeekendDate(hovered.date) ? 'Weekend — no band; weekends are left empty' : 'No previous business day to measure against'
          : `Band ${hoveredBand.lower.toFixed(1)}–${hoveredBand.upper.toFixed(1)} (prev. business day ${hoveredBand.anchor})`}</span>
      </div>}
    </div>
    <details className="li-table-view">
      <summary>Table view</summary>
      <div className="li-table-scroll">
        <table className="li-table">
          <thead><tr><th>Day</th><th>Went out</th><th>Planned</th><th>Band</th></tr></thead>
          <tbody>{points.map((point, index) => <tr key={point.date}>
            <td>{point.date}</td>
            <td className="li-num">{point.volume}</td>
            <td className="li-num">{point.planned}</td>
            <td className="li-num">{bands[index].anchor === null ? '—' : `${bands[index].lower.toFixed(1)}–${bands[index].upper.toFixed(1)}`}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </figure>;
}

/* -------------------------------------------------------------------------
 * The warm-up ramp.
 * ---------------------------------------------------------------------- */

/**
 * The ramp curve, with the seat's current week emphasised.
 *
 * Emphasis rather than eight colours: the story is "you are here", so one week
 * carries the accent and the rest recede. The multipliers are REPORTED, and the
 * caller renders the tag beside the chart.
 */
export function WarmupRamp({ multipliers, currentWeek, weeks }: {
  multipliers: readonly number[];
  currentWeek: number;
  weeks: number;
}) {
  const columns = [
    ...multipliers.map((multiplier, index) => ({ label: `Week ${index + 1}`, value: multiplier, week: index + 1 })),
    { label: `Week ${weeks + 1}+`, value: 1, week: weeks + 1 }
  ];
  const [frameRef, frameWidth] = useFrameWidth(320);
  // `.li-figure-small .li-chart` caps the drawn chart at 340px, so the intrinsic
  // width is capped to match it: a viewBox wider than the box it lands in is
  // exactly what shrinks a 9px axis label to five.
  const width = Math.max(200, Math.min(340, frameWidth));
  const height = 140;
  const padding = { top: 16, right: 8, bottom: 26, left: 8 };
  const plotHeight = height - padding.top - padding.bottom;
  const slot = (width - padding.left - padding.right) / columns.length;
  const barWidth = Math.min(24, slot - 10);

  const current = columns.find((column) => column.week === Math.min(currentWeek, weeks + 1));

  return <figure className="li-figure li-figure-small">
    <div className="li-chart-frame" ref={frameRef}>
      <svg viewBox={`0 0 ${width} ${height}`} className="li-chart" role="img"
        aria-label={`Warm-up ramp. This seat is in week ${currentWeek} of ${weeks}, so its active kinds are multiplied by ×${current?.value ?? 1}. `
          + `The full ramp is ${columns.map((column) => `${column.label} ×${column.value}`).join(', ')}.`}>
        <line x1={padding.left} x2={width - padding.right} y1={padding.top + plotHeight} y2={padding.top + plotHeight} className="li-grid" />
        {columns.map((column, index) => {
          const barHeight = column.value * plotHeight;
          const x = padding.left + index * slot + (slot - barWidth) / 2;
          const here = current?.week === column.week;
          return <g key={column.label}>
            <path d={columnPath(x, padding.top + plotHeight - barHeight, barWidth, barHeight)}
              className={here ? 'li-column' : 'li-column-mute'} />
            <text x={x + barWidth / 2} y={padding.top + plotHeight - barHeight - 6} className={`li-axis ${here ? 'li-axis-strong' : ''}`}>×{column.value}</text>
            <text x={x + barWidth / 2} y={height - 8} className={`li-axis ${here ? 'li-axis-strong' : ''}`}>{column.label}</text>
          </g>;
        })}
      </svg>
    </div>
  </figure>;
}

/* -------------------------------------------------------------------------
 * The acceptance meter.
 * ---------------------------------------------------------------------- */

/**
 * Live acceptance against the throttle floor.
 *
 * A meter, not a chart: one number against one threshold. The fill carries the
 * state, the track is a lighter step of the same ramp so the whole bar reads at
 * a glance, and the floor is a labelled tick rather than a colour change alone.
 *
 * A null rate renders as "nothing decided yet" and never as 0%: an unanswered
 * invite is not a refusal, and a 0% that means "no data" would be the single
 * most alarming false number on the screen.
 */
export function AcceptanceMeter({ rate, floor, decided, accepted, windowDays, throttled }: {
  rate: number | null;
  floor: number;
  decided: number;
  accepted: number;
  windowDays: number;
  throttled: boolean;
}) {
  const percent = rate === null ? 0 : Math.max(0, Math.min(1, rate));
  return <div className="li-meter-block">
    <div className="li-meter-head">
      <strong className={rate === null ? 'li-meter-unknown' : throttled ? 'li-meter-danger' : 'li-meter-ok'}>
        {rate === null ? 'No decided invites yet' : `${Math.round(rate * 100)}%`}
      </strong>
      <span>{accepted} accepted of {decided} decided, last {windowDays} days</span>
    </div>
    <div className="li-meter" role="img"
      aria-label={rate === null
        ? `Acceptance rate unknown: no invite has been decided in the last ${windowDays} days. Throttle floor ${Math.round(floor * 100)} percent.`
        : `Acceptance rate ${Math.round(rate * 100)} percent against a ${Math.round(floor * 100)} percent throttle floor.`}>
      {rate !== null && <i className={throttled ? 'li-meter-fill li-meter-fill-danger' : 'li-meter-fill'} style={{ width: `${percent * 100}%` }} />}
      <b className="li-meter-floor" style={{ left: `${floor * 100}%` }} />
    </div>
    <div className="li-meter-scale">
      <span>0%</span>
      <span className="li-meter-floor-label" style={{ left: `${floor * 100}%` }}>{Math.round(floor * 100)}% throttle floor</span>
      <span>100%</span>
    </div>
  </div>;
}

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
  return <div className="li-funnel">
    {stages.map((stage, index) => {
      const share = stage.value / peak;
      const inside = share > 0.22;
      return <div className="li-funnel-row" key={stage.label}>
        <span className="li-funnel-label">{stage.label}{stage.hint && <small>{stage.hint}</small>}</span>
        <div className="li-funnel-track">
          <i className={`li-funnel-bar li-funnel-${index + 1}`} style={{ width: `${Math.max(share * 100, stage.value > 0 ? 1.5 : 0)}%` }}>
            {inside && <em>{stage.value}</em>}
          </i>
          {!inside && <em className="li-funnel-outside" style={{ left: `${Math.max(share * 100, 0)}%` }}>{stage.value}</em>}
        </div>
      </div>;
    })}
  </div>;
}
