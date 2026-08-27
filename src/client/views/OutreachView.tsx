import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { getLinkedInManagedCampaigns, getLinkedInManagerWorkflows } from '../api';
import { errorMessage } from '../LinkedInSafety';
import type { ManagedCampaign } from '../../server/linkedin/managed-campaigns';
import { AccountsScreen } from '../AccountsScreen';
import { LinkedInCompanionAttention } from '../LinkedInCompanion';
import { OutreachInbox } from '../LinkedInInbox';
import { SharedConversations } from '../SharedConversations';
import { OutreachLeads } from '../LinkedInLeads';
import { OutreachManagerBuilder } from '../LinkedInManagerBuilder';
import { OutreachManagerRead } from '../LinkedInManagerRead';
import { LinkedInManagerWorkflowConfig } from '../LinkedInManagerWorkflowConfig';
import { LinkedInPosts } from '../LinkedInPosts';
import { InboundPeople } from '../InboundPeople';
import { Opportunities } from '../Opportunities';
import { ActionMenu } from '../ui/action-menu';
import type { Route } from '../ui/route';

/**
 * `/outreach/workflow/<workflowId>/<campaignId>`.
 *
 * WITH A CAMPAIGN IN THE PATH THIS EDITS THAT CAMPAIGN'S OWN STEPS. It used to
 * open the shared library workflow and tell the operator that saving "updates
 * the reusable workflow", and that a running campaign would pick the change up
 * once it was paused and resumed. Both halves were wrong in the same
 * direction: the edit rewrote a template every other campaign draws from, and
 * it never reached this campaign at all -- the runner walks the campaign's own
 * snapshot, and resuming does not rewrite that. Only an explicit "Apply
 * workflow vN" ever did.
 *
 * Without a campaign in the path it is still the library builder, which is what
 * the Advanced builder's "Manage workflows" opens.
 */
function OutreachStepsRoute({
  workflowId,
  campaignId,
  setToast,
  onNavigate
}: {
  workflowId: string;
  campaignId: string;
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [campaign, setCampaign] = useState<ManagedCampaign | null>(null);
  const [workflowName, setWorkflowName] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(campaignId));
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!campaignId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [campaigns, workflows] = await Promise.all([
        getLinkedInManagedCampaigns(),
        getLinkedInManagerWorkflows()
      ]);
      const found = campaigns.find((candidate) => candidate.id === campaignId) ?? null;
      setCampaign(found);
      setWorkflowName(
        workflows.find((candidate) => candidate.id === (found?.workflowId ?? workflowId))?.name ??
          null
      );
      setError(found ? '' : 'That campaign no longer exists.');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read this campaign.'));
    } finally {
      setLoading(false);
    }
  }, [campaignId, workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page-stack">
      <div className="builder-back">
        <button
          className="ghost-button"
          type="button"
          onClick={() =>
            onNavigate(
              campaignId ? '/outreach/campaign/' + encodeURIComponent(campaignId) : '/outreach'
            )
          }
        >
          {campaignId ? 'Back to campaign' : 'Back to campaigns'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="empty-copy">Reading this campaign…</p>}

      {campaignId && campaign && (
        <>
          <p className="li-hint">
            {campaign.sequenceCustomized
              ? `These steps were edited for this campaign${workflowName ? ` and no longer track “${workflowName}”` : ''}. The workflow library is unchanged.`
              : `These steps came from ${workflowName ? `“${workflowName}”` : 'a saved workflow'}. Editing them here changes this campaign only — the saved workflow and every other campaign using it stay as they are.`}
          </p>
          <LinkedInManagerWorkflowConfig
            campaign={campaign}
            setToast={setToast}
            onChanged={async () => undefined}
            onCampaignSaved={(next) => setCampaign(next)}
          />
        </>
      )}

      {!campaignId && (
        <>
          <p className="li-hint">
            This is the reusable workflow every campaign built from it draws on. Campaigns already
            running keep the steps they started with; to change one campaign alone, edit its steps
            from the campaign itself.
          </p>
          <LinkedInManagerWorkflowConfig
            initialWorkflowId={workflowId}
            setToast={setToast}
            onChanged={async () => undefined}
          />
        </>
      )}
    </div>
  );
}

const OUTREACH_TABS: ReadonlyArray<{
  sub: string;
  path: string;
  label: string;
  mobile: 'main' | 'more';
}> = [
  { sub: '', path: '/outreach', label: 'Campaigns', mobile: 'main' },
  { sub: 'inbound', path: '/outreach/inbound', label: 'Inbound', mobile: 'more' },
  { sub: 'inbox', path: '/outreach/inbox', label: 'Messages', mobile: 'main' },
  {
    sub: 'opportunities',
    path: '/outreach/opportunities',
    label: 'Opportunities',
    mobile: 'main'
  },
  { sub: 'posts', path: '/outreach/posts', label: 'Posts', mobile: 'more' }
];

function activeSub(sub: string): string {
  if (sub === 'new' || sub === 'campaign' || sub === 'workflow') return '';
  return OUTREACH_TABS.some((tab) => tab.sub === sub) ? sub : '';
}

export function OutreachView({
  route,
  setToast,
  onNavigate
}: {
  route: Route;
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const sub = route.sub;
  const [messageView, setMessageView] = useState<'conversations' | 'linkedin'>('conversations');
  const [openFolds, setOpenFolds] = useState<{ leads: boolean; accounts: boolean }>({
    leads: false,
    accounts: false
  });

  const current = activeSub(sub);
  const moreTabs = OUTREACH_TABS.filter((tab) => tab.mobile === 'more');
  const activeMore = moreTabs.find((tab) => tab.sub === current) ?? null;
  const [workflowId, campaignId] = sub === 'workflow' ? (route.id ?? '').split('/') : ['', ''];

  return (
    <div className="page-stack outreach-simple li-polished">
      {sub !== 'inbound' && <LinkedInCompanionAttention setToast={setToast} />}
      <nav className="outreach-nav" aria-label="Outreach sections">
        {/*
          Each tab is the ADDRESS of a screen, so it is an anchor: cmd-click
          opens Messages in a second tab, `aria-current="page"` is finally on
          an element that has a page, and the shell's one link interceptor
          (`ui/route.ts`) still navigates without a reload.
        */}
        {OUTREACH_TABS.map((tab) => (
          <a
            key={tab.path}
            href={tab.path}
            className={
              'outreach-tab ' +
              (tab.mobile === 'more' ? 'outreach-tab-more' : 'outreach-tab-main') +
              (tab.sub === current ? ' is-active' : '')
            }
            aria-current={tab.sub === current ? 'page' : undefined}
          >
            {tab.label}
          </a>
        ))}
        <ActionMenu
          className={'outreach-more-menu' + (activeMore ? ' is-active' : '')}
          label="More outreach sections"
          triggerContent={
            <span className="outreach-more-label">
              {activeMore?.label ?? 'More'} <ChevronDown size={14} aria-hidden="true" />
            </span>
          }
          items={moreTabs.map((tab) => ({
            label: tab.label,
            active: tab.sub === current,
            onSelect: () => onNavigate(tab.path)
          }))}
        />
      </nav>

      {sub === 'inbound' && <InboundPeople setToast={setToast} onNavigate={onNavigate} />}
      {sub === 'inbox' && (
        <div className="page-stack">
          <div className="outreach-message-switch" role="group" aria-label="Message view">
            <button
              type="button"
              className={`li-range${messageView === 'conversations' ? ' is-active' : ''}`}
              aria-pressed={messageView === 'conversations'}
              onClick={() => setMessageView('conversations')}
            >
              Conversations
            </button>
            <button
              type="button"
              className={`li-range${messageView === 'linkedin' ? ' is-active' : ''}`}
              aria-pressed={messageView === 'linkedin'}
              onClick={() => setMessageView('linkedin')}
            >
              LinkedIn inbox
            </button>
          </div>
          {messageView === 'conversations' ? (
            <SharedConversations onOpenLinkedInInbox={() => setMessageView('linkedin')} />
          ) : (
            <OutreachInbox setToast={setToast} />
          )}
        </div>
      )}
      {sub === 'opportunities' && <Opportunities setToast={setToast} />}
      {sub === 'posts' && <LinkedInPosts setToast={setToast} />}
      {sub === 'new' && <OutreachManagerBuilder setToast={setToast} onNavigate={onNavigate} />}
      {sub === 'campaign' && route.id && (
        <OutreachManagerRead
          setToast={setToast}
          onNavigate={onNavigate}
          initialCampaignId={route.id}
        />
      )}
      {sub === 'workflow' && workflowId && (
        <OutreachStepsRoute
          workflowId={workflowId}
          campaignId={campaignId}
          setToast={setToast}
          onNavigate={onNavigate}
        />
      )}
      {sub === '' && (
        <>
          <OutreachManagerRead setToast={setToast} onNavigate={onNavigate} />
          <details
            className="mgr-inputs"
            id="leads"
            onToggle={(event) => {
              const opened = event.currentTarget.open;
              setOpenFolds((current) => ({
                ...current,
                leads: current.leads || opened
              }));
            }}
          >
            <summary>Find people</summary>
            <div className="mgr-inputs-body">
              {openFolds.leads && <OutreachLeads setToast={setToast} />}
            </div>
          </details>
          <details
            className="mgr-inputs"
            id="accounts"
            onToggle={(event) => {
              const opened = event.currentTarget.open;
              setOpenFolds((current) => ({
                ...current,
                accounts: current.accounts || opened
              }));
            }}
          >
            <summary>Target accounts</summary>
            <div className="mgr-inputs-body">
              {openFolds.accounts && <AccountsScreen setToast={setToast} />}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
