import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { AccountsScreen } from '../AccountsScreen';
import { LinkedInAccounts } from '../LinkedInAccounts';
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
import { replaceNavigate, type Route } from '../ui/route';
import { scrollToId } from '../ui/scrollToId';

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
  { sub: 'posts', path: '/outreach/posts', label: 'Posts', mobile: 'more' },
  { sub: 'settings', path: '/outreach/settings', label: 'Settings', mobile: 'more' }
];

const OUTREACH_LEGACY_REDIRECTS: Record<string, string> = {
  manager: '/outreach',
  campaigns: '/outreach',
  plan: '/outreach',
  activity: '/outreach',
  leads: '/outreach',
  accounts: '/outreach'
};

const OUTREACH_LEGACY_ANCHORS: Record<string, string> = {
  leads: 'leads',
  accounts: 'accounts'
};

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
  const [anchor, setAnchor] = useState<{ id: string; seq: number } | null>(null);
  const anchorSeq = useRef(0);
  const [openFolds, setOpenFolds] = useState<{ leads: boolean; accounts: boolean }>({
    leads: false,
    accounts: false
  });

  useEffect(() => {
    const target = OUTREACH_LEGACY_REDIRECTS[sub];
    if (!target) return;
    const anchorId = OUTREACH_LEGACY_ANCHORS[sub];
    if (anchorId) setAnchor({ id: anchorId, seq: ++anchorSeq.current });
    replaceNavigate(sub === 'manager' && route.id === 'new' ? '/outreach/new' : target);
  }, [sub, route.id]);

  useEffect(() => {
    if (!anchor) return;
    const node = document.getElementById(anchor.id);
    if (node instanceof HTMLDetailsElement) node.open = true;
    return scrollToId(anchor.id);
  }, [anchor]);

  const current = activeSub(sub);
  const moreTabs = OUTREACH_TABS.filter((tab) => tab.mobile === 'more');
  const activeMore = moreTabs.find((tab) => tab.sub === current) ?? null;
  const [workflowId, campaignId] = sub === 'workflow' ? (route.id ?? '').split('/') : ['', ''];

  return (
    <div className="page-stack outreach-simple li-polished">
      {sub !== 'inbound' && <LinkedInCompanionAttention setToast={setToast} />}
      <nav className="outreach-nav" aria-label="Outreach sections">
        {OUTREACH_TABS.map((tab) => (
          <button
            key={tab.path}
            type="button"
            className={
              'outreach-tab ' +
              (tab.mobile === 'more' ? 'outreach-tab-more' : 'outreach-tab-main') +
              (tab.sub === current ? ' is-active' : '')
            }
            aria-current={tab.sub === current ? 'page' : undefined}
            onClick={() => onNavigate(tab.path)}
          >
            {tab.label}
          </button>
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

      {sub === 'inbound' && <InboundPeople setToast={setToast} />}
      {sub === 'inbox' && (
        <div className="page-stack">
          <SharedConversations />
          <OutreachInbox setToast={setToast} />
        </div>
      )}
      {sub === 'opportunities' && <Opportunities setToast={setToast} />}
      {sub === 'posts' && <LinkedInPosts setToast={setToast} />}
      {sub === 'settings' && <LinkedInAccounts setToast={setToast} />}
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
