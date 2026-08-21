import { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox, LoaderCircle, RefreshCw, UserRound } from 'lucide-react';
import {
  getCaptureSources,
  getInboundPeople,
  getInboundSubmissions,
  type CaptureSourceSummary,
  type InboundPerson,
  type InboundSubmission
} from './api';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import './lead-capture.css';

export function InboundPeople({ setToast }: { setToast: (message: string) => void }) {
  const [people, setPeople] = useState<InboundPerson[]>([]);
  const [submissions, setSubmissions] = useState<InboundSubmission[]>([]);
  const [sources, setSources] = useState<CaptureSourceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextPeople, nextSubmissions, nextSources] = await Promise.all([
        getInboundPeople(),
        getInboundSubmissions(),
        getCaptureSources()
      ]);
      setPeople(nextPeople);
      setSubmissions(nextSubmissions);
      setSources(nextSources);
      setProblem('');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to load inbound leads.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const sourcesById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources]
  );

  return (
    <div className="page-stack inbound-people">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3>Inbound</h3>
            <p>People and GTM submissions captured from connected sources.</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => void load().then(() => setToast('Inbound refreshed.'))}
          >
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{' '}
            Refresh
          </button>
        </div>
        {problem && <div className="error-box">{problem}</div>}
        {!loading && submissions.length === 0 && (
          <div className="empty-state">
            <Inbox size={26} />
            <h4>No inbound submissions yet</h4>
            <p>Connect a source in Setup → Lead capture.</p>
          </div>
        )}
        {submissions.length > 0 && (
          <div className="capture-submission-list">
            {submissions.map((submission) => {
              const person = peopleById.get(submission.contactId);
              const source = sourcesById.get(submission.captureSourceId);
              const submitted = submission.person;
              const utm = Object.entries(submission.attribution).filter(
                ([, value]) => value !== undefined && value !== null && String(value)
              );
              return (
                <article key={submission.id} className="capture-submission-card">
                  <header>
                    <div>
                      <strong>
                        {submitted.name ||
                          submitted.email ||
                          submitted.phone ||
                          person?.name ||
                          person?.email ||
                          person?.phone ||
                          'Person'}
                      </strong>
                      <span>{submission.kind.replace(/[._-]+/g, ' ')}</span>
                    </div>
                    <time>{relativeTime(submission.receivedAt)}</time>
                  </header>
                  <div className="capture-submission-meta">
                    <span>
                      <UserRound size={13} />{' '}
                      {submitted.email ||
                        submitted.phone ||
                        person?.email ||
                        person?.phone ||
                        submission.contactId}
                    </span>
                    <span>Source: {source?.name || submission.captureSourceId}</span>
                    {submission.company && (
                      <span>Company: {submission.company.name || submission.company.domain}</span>
                    )}
                    {submission.accountId && <span>Account linked</span>}
                    {submission.pageUrl && <span>Page: {submission.pageUrl}</span>}
                    {submission.sourceEventId && (
                      <span>Source event: {submission.sourceEventId}</span>
                    )}
                  </div>
                  {submission.message && <p className="capture-message">{submission.message}</p>}
                  {utm.length > 0 && (
                    <div className="capture-tags">
                      {utm.map(([key, value]) => (
                        <span key={key}>
                          {key}={String(value)}
                        </span>
                      ))}
                    </div>
                  )}
                  {Object.keys(submission.properties).length > 0 && (
                    <details>
                      <summary>Submitted properties</summary>
                      <pre>
                        <code>{JSON.stringify(submission.properties, null, 2)}</code>
                      </pre>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
