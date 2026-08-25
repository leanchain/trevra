import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
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
              Back to campaign
            </button>
          </div>
          <p className="li-hint">
            Saving here updates the reusable workflow. If the campaign is already running, its live
            steps stay locked until you pause and resume it.
          </p>
          <LinkedInManagerWorkflowConfig
            initialWorkflowId={workflowId}
            setToast={setToast}
            onChanged={async () => undefined}
          />
        </div>
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
