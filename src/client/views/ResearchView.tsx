import { useEffect, useState } from 'react';
import { CircleAlert, LoaderCircle, MessageSquare, Newspaper } from 'lucide-react';
import type { ConnectionSummary, SkillRun } from '../../shared/types';
import { getOutreachThreads, getSkillRuns, type FeedThread } from '../api';
import { ResearchScreen } from '../ResearchScreen';
import { EvidenceList } from './inspector';

/*
 * `/research` -- one feed over three sources that never shared a screen:
 * the outreach_threads table (LinkedIn/Reddit/HN/GitHub/etc, scored,
 * previously had NO reader at all), gtm.research-brief skill-run output
 * (company-level findings, already queryable but never rendered as a feed),
 * and the pre-existing Reddit corpus screen (relocated in unchanged).
 *
 * See docs/superpowers/specs/2026-08-18-research-hub-design.md.
 */

const PLATFORM_LABELS: Record<string, string> = {
  all: 'All',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  github: 'GitHub',
  devto: 'Dev.to',
  lobsters: 'Lobsters',
  mastodon: 'Mastodon',
  stackoverflow: 'Stack Overflow'
};
const PLATFORM_FILTERS = Object.keys(PLATFORM_LABELS);

interface ResearchBriefOutput {
  domain: string | null;
  topFinding: string;
  findingDetail: string;
}

/** `SkillRun.output` is `unknown` -- a research brief is only ever rendered once these fields are confirmed present. */
function asResearchBrief(output: unknown): ResearchBriefOutput | null {
  if (!output || typeof output !== 'object') return null;
  const value = output as Record<string, unknown>;
  if (typeof value.topFinding !== 'string' || typeof value.findingDetail !== 'string') return null;
  return {
    domain: typeof value.domain === 'string' ? value.domain : null,
    topFinding: value.topFinding,
    findingDetail: value.findingDetail
  };
}

export function ResearchView({
  connections,
  setToast
}: {
  connections: ConnectionSummary[];
  setToast: (message: string) => void;
}) {
  const [platform, setPlatform] = useState('all');
  const [threads, setThreads] = useState<FeedThread[]>([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [threadsError, setThreadsError] = useState(false);
  const [briefs, setBriefs] = useState<SkillRun[]>([]);
  const [briefsLoaded, setBriefsLoaded] = useState(false);
  const [briefsError, setBriefsError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThreadsLoaded(false);
    getOutreachThreads(platform === 'all' ? {} : { platform })
      .then((rows) => {
        if (cancelled) return;
        setThreads(rows);
        setThreadsError(false);
        setThreadsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setThreads([]);
        setThreadsError(true);
        setThreadsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    let cancelled = false;
    getSkillRuns({ skillId: 'gtm.research-brief', status: 'ok', limit: 50 })
      .then((runs) => {
        if (cancelled) return;
        setBriefs(runs);
        setBriefsError(false);
        setBriefsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBriefsError(true);
        setBriefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const renderableBriefs = briefs
    .map((run) => ({ run, brief: asResearchBrief(run.output) }))
    .filter(
      (entry): entry is { run: SkillRun; brief: ResearchBriefOutput } => entry.brief !== null
    );

  const showBriefs = platform === 'all' || platform === 'linkedin';
  const showRedditCorpus = platform === 'all' || platform === 'reddit';

  return (
    <div className="page-stack">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h2>Research</h2>
            <p>
              Everything discovered or drafted from community and company research, across every
              connected platform.
            </p>
          </div>
        </div>
        <div className="li-filter-row" role="group" aria-label="Platform">
          <span className="li-filter-label">Platform</span>
          {PLATFORM_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={`li-range ${platform === key ? 'is-active' : ''}`}
              aria-pressed={platform === key}
              onClick={() => setPlatform(key)}
            >
              {PLATFORM_LABELS[key]}
            </button>
          ))}
        </div>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Discovered threads</h3>
            <p>Community threads scouted and scored for reply-worthiness.</p>
          </div>
        </div>
        <div className="client-table">
          {threadsLoaded &&
            !threadsError &&
            threads.map(({ row }) => (
              <article className="client-card-large" key={row.id}>
                <span className="client-avatar large">
                  {(PLATFORM_LABELS[row.platform] ?? row.platform).slice(0, 1)}
                </span>
                <div>
                  <h3>
                    <a href={row.url} target="_blank" rel="noreferrer">
                      {row.title}
                    </a>
                  </h3>
                  <p>
                    {row.community ? `${row.community} · ` : ''}
                    {row.author ? `by ${row.author} · ` : ''}score {row.score}
                  </p>
                  <span className="client-status">
                    {PLATFORM_LABELS[row.platform] ?? row.platform}
                  </span>
                </div>
              </article>
            ))}
          {!threadsLoaded && (
            <div className="empty-state">
              <LoaderCircle className="spin" size={26} />
              <h4 aria-level={3}>Loading…</h4>
              <p>One moment.</p>
            </div>
          )}
          {threadsLoaded && threadsError && (
            <div className="empty-state">
              <CircleAlert size={26} />
              <h4 aria-level={3}>Couldn't load discovered threads</h4>
              <p>Something went wrong fetching this. Try reloading the page.</p>
            </div>
          )}
          {threadsLoaded && !threadsError && threads.length === 0 && (
            <div className="empty-state">
              <MessageSquare size={26} />
              <h4 aria-level={3}>No threads discovered yet</h4>
              <p>Scouting runs on its own schedule; check back once it has run.</p>
            </div>
          )}
        </div>
      </section>

      {showBriefs && (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>Company research</h3>
              <p>Findings drawn from company audits and enrichment, used to draft outreach.</p>
            </div>
          </div>
          <div className="client-table">
            {briefsLoaded &&
              !briefsError &&
              renderableBriefs.map(({ run, brief }) => (
                <article className="client-card-large" key={run.id}>
                  <span className="client-avatar large">
                    {(brief.domain ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <h3>{brief.domain ?? 'Unknown domain'}</h3>
                    <p>{brief.findingDetail}</p>
                    <span className="client-status">{brief.topFinding}</span>
                    {run.evidence.length > 0 && <EvidenceList entries={run.evidence} />}
                  </div>
                </article>
              ))}
            {!briefsLoaded && (
              <div className="empty-state">
                <LoaderCircle className="spin" size={26} />
                <h4 aria-level={3}>Loading…</h4>
                <p>One moment.</p>
              </div>
            )}
            {briefsLoaded && briefsError && (
              <div className="empty-state">
                <CircleAlert size={26} />
                <h4 aria-level={3}>Couldn't load research briefs</h4>
                <p>Something went wrong fetching this. Try reloading the page.</p>
              </div>
            )}
            {briefsLoaded && !briefsError && renderableBriefs.length === 0 && (
              <div className="empty-state">
                <Newspaper size={26} />
                <h4 aria-level={3}>No research briefs yet</h4>
                <p>These are generated when a company is researched for outreach.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {showRedditCorpus && <ResearchScreen connections={connections} setToast={setToast} />}
    </div>
  );
}
