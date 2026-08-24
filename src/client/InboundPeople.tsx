import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Briefcase,
  Inbox,
  ListPlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  Undo2,
  UserRound
} from 'lucide-react';
import {
  createLinkedInManagerLeadList,
  createOpportunity,
  createSuppression,
  getCaptureSources,
  getInboundPeople,
  getInboundSubmissions,
  getLinkedInManagerLeadLists,
  getOpportunities,
  getRankedAccounts,
  getSuppressions,
  importLinkedInManagerLeadCsv,
  liftSuppression,
  type CaptureSourceSummary,
  type InboundPerson,
  type InboundSubmission,
  type RankedAccount,
  type SuppressionSummary
} from './api';
import type { LinkedInLeadList } from '../server/linkedin/lead-lists';
import type { OpportunityRecord } from '../shared/types';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { Select } from './ui/primitives';
import './lead-capture.css';

/**
 * WHAT AN INBOUND SUBMISSION IS FOR.
 *
 * A submission is immutable evidence: it is never edited here. What this screen
 * owes an operator is the DECISION that follows it -- pursue it, work it, or
 * refuse it -- and each of those is a write to a record that already exists
 * elsewhere, not a new kind of state on the submission itself.
 *
 *   * Pursue  -> an Opportunity keyed to the canonical Person.
 *   * Work    -> a row on a LinkedIn lead list.
 *   * Refuse  -> a suppression, so outreach stops proposing them.
 *
 * The card shows the current answer for each, so a decision already taken reads
 * as taken rather than offering itself again.
 */

/**
 * The lead CSV reader requires first name, last name AND company, and rejects a
 * row missing any of them. Inbound forms frequently carry only an email, so the
 * button is gated on the row being importable rather than letting the operator
 * discover the refusal after the click.
 */
const LEAD_HEADERS = ['firstName', 'lastName', 'company', 'email', 'phone'] as const;
const LEAD_MAPPING = {
  firstName: 'firstName',
  lastName: 'lastName',
  company: 'company',
  email: 'email',
  phone: 'phone'
} as const;

type LeadRow = {
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  phone: string;
};

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.normalize('NFKC').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function leadRowFor(
  submission: InboundSubmission,
  person: InboundPerson | undefined,
  accountName: string | null
): { row: LeadRow } | { blocked: string } {
  const { firstName, lastName } = splitName(submission.person.name || person?.name || '');
  const company = submission.company?.name || submission.company?.domain || accountName || '';
  const missing = [
    !firstName && 'a first name',
    !lastName && 'a last name',
    !company && 'a company'
  ].filter(Boolean);
  if (missing.length > 0)
    return { blocked: `A lead list row needs ${missing.join(', ')}. This submission has none.` };
  return {
    row: {
      firstName,
      lastName,
      company,
      email: submission.person.email || person?.email || '',
      phone: submission.person.phone || person?.phone || ''
    }
  };
}

function leadCsv(row: LeadRow): string {
  const values = LEAD_HEADERS.map((header) => csvCell(row[header]));
  return `${LEAD_HEADERS.join(',')}\n${values.join(',')}\n`;
}

export function InboundPeople({
  setToast,
  onNavigate
}: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [people, setPeople] = useState<InboundPerson[]>([]);
  const [submissions, setSubmissions] = useState<InboundSubmission[]>([]);
  const [sources, setSources] = useState<CaptureSourceSummary[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityRecord[]>([]);
  const [suppressions, setSuppressions] = useState<SuppressionSummary[]>([]);
  const [leadLists, setLeadLists] = useState<LinkedInLeadList[]>([]);
  const [accounts, setAccounts] = useState<RankedAccount[]>([]);
  const [listChoice, setListChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // THE THREE INBOUND READS ARE STRICT; THE REST ARE NOT. Lead lists need a
      // LinkedIn seat and ranked accounts need an account import, and neither is
      // a precondition for reading inbound. A workspace without them still sees
      // its submissions -- it just sees fewer actions on them.
      const [nextPeople, nextSubmissions, nextSources] = await Promise.all([
        getInboundPeople(),
        getInboundSubmissions(),
        getCaptureSources()
      ]);
      const [nextOpportunities, nextSuppressions, nextLists, nextAccounts] = await Promise.all([
        getOpportunities().catch(() => [] as OpportunityRecord[]),
        getSuppressions().catch(() => [] as SuppressionSummary[]),
        getLinkedInManagerLeadLists().catch(() => [] as LinkedInLeadList[]),
        getRankedAccounts({ limit: 500 }).catch(() => [] as RankedAccount[])
      ]);
      setPeople(nextPeople);
      setSubmissions(nextSubmissions);
      setSources(nextSources);
      setOpportunities(nextOpportunities);
      setSuppressions(nextSuppressions);
      setLeadLists(nextLists);
      setAccounts(nextAccounts);
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
  // `RankedAccount` wraps the account in a score envelope; only the record is
  // wanted here.
  const accountsById = useMemo(
    () => new Map(accounts.map((ranked) => [ranked.account.id, ranked.account])),
    [accounts]
  );
  const opportunityByPerson = useMemo(() => {
    const map = new Map<string, OpportunityRecord>();
    for (const opportunity of opportunities)
      if (opportunity.personId && !map.has(opportunity.personId))
        map.set(opportunity.personId, opportunity);
    return map;
  }, [opportunities]);
  // A SUPPRESSION MAY BE HELD BY PERSON OR BY ADDRESS, and inbound arrives with
  // both, so both are indexed. `liftedAt` is the lift, not a delete.
  const suppressionByPerson = useMemo(() => {
    const map = new Map<string, SuppressionSummary>();
    for (const entry of suppressions) {
      if (entry.liftedAt || !entry.personId) continue;
      if (!map.has(entry.personId)) map.set(entry.personId, entry);
    }
    return map;
  }, [suppressions]);
  const suppressionByEmail = useMemo(() => {
    const map = new Map<string, SuppressionSummary>();
    for (const entry of suppressions) {
      if (entry.liftedAt || !entry.email) continue;
      const key = entry.email.toLowerCase();
      if (!map.has(key)) map.set(key, entry);
    }
    return map;
  }, [suppressions]);

  const addOpportunity = useCallback(
    async (submission: InboundSubmission, who: string, org: string | null) => {
      setBusy(`opportunity:${submission.id}`);
      try {
        await createOpportunity({
          personId: submission.contactId,
          accountId: submission.accountId,
          title: org ? `${org} — ${who}` : who,
          stage: 'new',
          nextAction: `Reply to ${submission.kind.replace(/[._-]+/g, ' ')}`
        });
        setOpportunities(await getOpportunities());
        setToast('Opportunity created.');
      } catch (error) {
        setToast(errorMessage(error, 'Could not create the opportunity.'));
      } finally {
        setBusy('');
      }
    },
    [setToast]
  );

  const addToLeadList = useCallback(
    async (submission: InboundSubmission, row: LeadRow) => {
      setBusy(`lead:${submission.id}`);
      try {
        let listId = listChoice[submission.id] || leadLists[0]?.id || '';
        if (!listId) {
          const created = await createLinkedInManagerLeadList({
            name: 'Inbound',
            sourceKind: 'csv'
          });
          listId = created.id;
          setListChoice((prev) => ({ ...prev, [submission.id]: created.id }));
        }
        // ONE ROW THROUGH THE CSV READER, not a second insert path. The scrub,
        // the dedupe key and the Person convergence a pasted list gets are the
        // ones an inbound lead has to get too, and they live in that reader.
        const file = new File([leadCsv(row)], `inbound-${submission.id}.csv`, { type: 'text/csv' });
        const result = await importLinkedInManagerLeadCsv(listId, file, { ...LEAD_MAPPING });
        setLeadLists(await getLinkedInManagerLeadLists().catch(() => leadLists));
        if (result.inserted > 0) setToast(`${row.firstName} added to the lead list.`);
        else if (result.rejected.length > 0) setToast(result.rejected[0].reason);
        else setToast('Already on a lead list in this workspace.');
      } catch (error) {
        setToast(errorMessage(error, 'Could not add this person to a lead list.'));
      } finally {
        setBusy('');
      }
    },
    [leadLists, listChoice, setToast]
  );

  const suppress = useCallback(
    async (submission: InboundSubmission, email: string) => {
      setBusy(`suppress:${submission.id}`);
      try {
        await createSuppression({
          channel: 'all',
          personId: submission.contactId,
          email: email || null,
          reason: 'Marked not a lead from Inbound'
        });
        setSuppressions(await getSuppressions());
        setToast('Marked not a lead. Outreach will skip them.');
      } catch (error) {
        setToast(errorMessage(error, 'Could not suppress this person.'));
      } finally {
        setBusy('');
      }
    },
    [setToast]
  );

  const restore = useCallback(
    async (submission: InboundSubmission, suppressionId: string) => {
      setBusy(`suppress:${submission.id}`);
      try {
        await liftSuppression(suppressionId);
        setSuppressions(await getSuppressions());
        setToast('Suppression lifted.');
      } catch (error) {
        setToast(errorMessage(error, 'Could not lift the suppression.'));
      } finally {
        setBusy('');
      }
    },
    [setToast]
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
              const account = submission.accountId
                ? (accountsById.get(submission.accountId) ?? null)
                : null;
              const utm = Object.entries(submission.attribution).filter(
                ([, value]) => value !== undefined && value !== null && String(value)
              );
              const who =
                submitted.name ||
                submitted.email ||
                submitted.phone ||
                person?.name ||
                person?.email ||
                person?.phone ||
                'Person';
              const email = submitted.email || person?.email || '';
              const org =
                submission.company?.name || submission.company?.domain || account?.name || null;
              const opportunity = opportunityByPerson.get(submission.contactId) ?? null;
              const suppression =
                suppressionByPerson.get(submission.contactId) ??
                (email ? (suppressionByEmail.get(email.toLowerCase()) ?? null) : null);
              const lead = leadRowFor(submission, person, account?.name ?? null);
              const opportunityBusy = busy === `opportunity:${submission.id}`;
              const leadBusy = busy === `lead:${submission.id}`;
              const suppressBusy = busy === `suppress:${submission.id}`;
              return (
                <article key={submission.id} className="capture-submission-card">
                  <header>
                    <div>
                      <strong>{who}</strong>
                      <span>{submission.kind.replace(/[._-]+/g, ' ')}</span>
                    </div>
                    <time>{relativeTime(submission.receivedAt)}</time>
                  </header>
                  <div className="capture-submission-meta">
                    <span>
                      <UserRound size={13} />{' '}
                      {email || submitted.phone || person?.phone || submission.contactId}
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
                  <div className="capture-actions">
                    {opportunity ? (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => onNavigate('/outreach/opportunities')}
                      >
                        <Briefcase size={13} /> Opportunity · {opportunity.stage}
                      </button>
                    ) : (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={opportunityBusy}
                        onClick={() => void addOpportunity(submission, who, org)}
                      >
                        {opportunityBusy ? (
                          <LoaderCircle className="spin" size={13} />
                        ) : (
                          <Plus size={13} />
                        )}{' '}
                        Create opportunity
                      </button>
                    )}

                    {'blocked' in lead ? (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled
                        title={lead.blocked}
                      >
                        <ListPlus size={13} /> Add to lead list
                      </button>
                    ) : (
                      <span className="capture-action-group">
                        {leadLists.length > 0 && (
                          <Select
                            aria-label={`Lead list for ${who}`}
                            value={listChoice[submission.id] ?? leadLists[0].id}
                            onChange={(event) =>
                              setListChoice((prev) => ({
                                ...prev,
                                [submission.id]: event.target.value
                              }))
                            }
                          >
                            {leadLists.map((list) => (
                              <option key={list.id} value={list.id}>
                                {list.name}
                              </option>
                            ))}
                          </Select>
                        )}
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={leadBusy}
                          title={
                            leadLists.length > 0
                              ? undefined
                              : 'No lead list yet — this creates one called Inbound.'
                          }
                          onClick={() => void addToLeadList(submission, lead.row)}
                        >
                          {leadBusy ? (
                            <LoaderCircle className="spin" size={13} />
                          ) : (
                            <ListPlus size={13} />
                          )}{' '}
                          Add to lead list
                        </button>
                      </span>
                    )}

                    {suppression ? (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={suppressBusy}
                        onClick={() => void restore(submission, suppression.id)}
                      >
                        {suppressBusy ? (
                          <LoaderCircle className="spin" size={13} />
                        ) : (
                          <Undo2 size={13} />
                        )}{' '}
                        Not a lead · undo
                      </button>
                    ) : (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={suppressBusy}
                        onClick={() => void suppress(submission, email)}
                      >
                        {suppressBusy ? (
                          <LoaderCircle className="spin" size={13} />
                        ) : (
                          <Ban size={13} />
                        )}{' '}
                        Not a lead
                      </button>
                    )}
                  </div>
                  <details className="capture-record">
                    <summary>Person and account record</summary>
                    <dl>
                      <dt>Person</dt>
                      <dd>{person?.name || submitted.name || '—'}</dd>
                      <dt>Person id</dt>
                      <dd>{submission.contactId}</dd>
                      <dt>Email</dt>
                      <dd>{person?.email || submitted.email || '—'}</dd>
                      <dt>Phone</dt>
                      <dd>{person?.phone || submitted.phone || '—'}</dd>
                      <dt>Role</dt>
                      <dd>{person?.role || submitted.role || '—'}</dd>
                      <dt>Account</dt>
                      <dd>
                        {account
                          ? `${account.name}${account.domain ? ` (${account.domain})` : ''}`
                          : submission.accountId || 'Not linked to an account'}
                      </dd>
                    </dl>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onNavigate('/outreach/opportunities')}
                    >
                      Open in Opportunities
                    </button>
                  </details>
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
