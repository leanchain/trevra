import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import {
  createOpportunity,
  getInboundPeople,
  getOpportunities,
  getRankedAccounts,
  updateOpportunity,
  type InboundPerson,
  type RankedAccount
} from './api';
import type { OpportunityRecord, OpportunityStage } from '../shared/types';
import { errorMessage } from './LinkedInSafety';
import { Select } from './ui/primitives';

const STAGES: ReadonlyArray<{ id: OpportunityStage; label: string }> = [
  { id: 'new', label: 'New' },
  { id: 'qualified', label: 'Qualified' },
  { id: 'meeting', label: 'Meeting' },
  { id: 'proposal', label: 'Proposal' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' }
];

function localDateTime(value: string | null): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function isoOrNull(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function Opportunities({ setToast }: { setToast: (message: string) => void }) {
  const [opportunities, setOpportunities] = useState<OpportunityRecord[]>([]);
  const [people, setPeople] = useState<InboundPerson[]>([]);
  const [accounts, setAccounts] = useState<RankedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [personId, setPersonId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [stage, setStage] = useState<OpportunityStage>('new');
  const [nextAction, setNextAction] = useState('');
  const [nextActionAt, setNextActionAt] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextOpportunities, nextPeople, nextAccounts] = await Promise.all([
        getOpportunities(),
        getInboundPeople(500),
        getRankedAccounts({ limit: 500 })
      ]);
      setOpportunities(nextOpportunities);
      setPeople(nextPeople);
      setAccounts(nextAccounts);
      setProblem('');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to read opportunities.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byStage = useMemo(() => {
    const map = new Map<OpportunityStage, OpportunityRecord[]>(STAGES.map((item) => [item.id, []]));
    for (const opportunity of opportunities) map.get(opportunity.stage)?.push(opportunity);
    return map;
  }, [opportunities]);

  const create = async () => {
    if (!title.trim() || (!personId && !accountId)) return;
    setBusy('create');
    setProblem('');
    try {
      await createOpportunity({
        title: title.trim(),
        personId: personId || null,
        accountId: accountId || null,
        stage,
        nextAction: nextAction.trim() || null,
        nextActionAt: isoOrNull(nextActionAt)
      });
      setTitle('');
      setPersonId('');
      setAccountId('');
      setStage('new');
      setNextAction('');
      setNextActionAt('');
      setCreating(false);
      setToast('Opportunity added.');
      await load();
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to add that opportunity.'));
    } finally {
      setBusy('');
    }
  };

  const patch = async (
    opportunity: OpportunityRecord,
    input: Parameters<typeof updateOpportunity>[1]
  ) => {
    setBusy(opportunity.id);
    setProblem('');
    try {
      await updateOpportunity(opportunity.id, input);
      await load();
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to update that opportunity.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="page-stack opportunity-lite">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3>Opportunities</h3>
            <p>
              Only the GTM progression Trevra needs: who, where it stands, and what happens next. No
              amounts, forecasts, quotes, or custom CRM objects.
            </p>
          </div>
          <div className="button-row">
            <button
              className="secondary-button"
              type="button"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{' '}
              Refresh
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => setCreating((value) => !value)}
            >
              <Plus size={14} /> Add opportunity
            </button>
          </div>
        </div>

        {problem && <div className="error-banner">{problem}</div>}

        {creating && (
          <div className="opportunity-create">
            <label>
              Title
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Pilot / discovery / proposal"
              />
            </label>
            <label>
              Person
              <Select value={personId} onChange={(event) => setPersonId(event.target.value)}>
                <option value="">None</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name || person.email || person.id}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Account
              <Select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="">None</option>
                {accounts.map(({ account }) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Stage
              <Select
                value={stage}
                onChange={(event) => setStage(event.target.value as OpportunityStage)}
              >
                {STAGES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Next action
              <input
                value={nextAction}
                onChange={(event) => setNextAction(event.target.value)}
                placeholder="Book discovery call"
              />
            </label>
            <label>
              Due
              <input
                type="datetime-local"
                value={nextActionAt}
                onChange={(event) => setNextActionAt(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={busy === 'create' || !title.trim() || (!personId && !accountId)}
              onClick={() => void create()}
            >
              {busy === 'create' ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Check size={14} />
              )}{' '}
              Save
            </button>
          </div>
        )}

        {!loading && opportunities.length === 0 && !creating && (
          <div className="empty-state">
            <h4>No opportunities yet</h4>
            <p>
              Qualify a Person or Account when there is a real commercial next step. Trevra does not
              need a deal record for every lead.
            </p>
          </div>
        )}

        <div className="opportunity-stage-list">
          {STAGES.map((stageDef) => {
            const rows = byStage.get(stageDef.id) ?? [];
            if (!rows.length) return null;
            return (
              <section key={stageDef.id} className="opportunity-stage">
                <header>
                  <strong>{stageDef.label}</strong>
                  <span className="status-pill">{rows.length}</span>
                </header>
                {rows.map((opportunity) => (
                  <article key={opportunity.id} className="opportunity-row">
                    <div className="opportunity-main">
                      <strong>{opportunity.title}</strong>
                      <span>
                        {[
                          opportunity.personName || opportunity.personEmail,
                          opportunity.accountName
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'GTM opportunity'}
                      </span>
                    </div>
                    <label>
                      Stage
                      <Select
                        disabled={busy === opportunity.id}
                        value={opportunity.stage}
                        onChange={(event) =>
                          void patch(opportunity, { stage: event.target.value as OpportunityStage })
                        }
                      >
                        {STAGES.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label>
                      Next action
                      <input
                        disabled={busy === opportunity.id}
                        defaultValue={opportunity.nextAction ?? ''}
                        onBlur={(event) => {
                          const value = event.currentTarget.value.trim();
                          if (value !== (opportunity.nextAction ?? ''))
                            void patch(opportunity, { nextAction: value || null });
                        }}
                        placeholder="What happens next?"
                      />
                    </label>
                    <label>
                      Due
                      <input
                        disabled={busy === opportunity.id}
                        type="datetime-local"
                        defaultValue={localDateTime(opportunity.nextActionAt)}
                        onBlur={(event) => {
                          const value = isoOrNull(event.currentTarget.value);
                          if (value !== opportunity.nextActionAt)
                            void patch(opportunity, { nextActionAt: value });
                        }}
                      />
                    </label>
                    <span className="opportunity-owner">
                      {opportunity.ownerName ? `Owner: ${opportunity.ownerName}` : 'Unassigned'}
                    </span>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}
