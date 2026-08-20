import { useEffect, useRef, useState } from 'react';
import { AccountsScreen } from '../AccountsScreen';
import { LinkedInAccounts } from '../LinkedInAccounts';
import { LinkedInCompanionAttention } from '../LinkedInCompanion';
import { OutreachInbox } from '../LinkedInInbox';
import { OutreachLeads } from '../LinkedInLeads';
import { OutreachManagerBuilder } from '../LinkedInManagerBuilder';
import { OutreachManagerRead } from '../LinkedInManagerRead';
import { LinkedInManagerWorkflowConfig } from '../LinkedInManagerWorkflowConfig';
import { LinkedInPosts } from '../LinkedInPosts';
import { replaceNavigate, type Route } from '../ui/route';
import { scrollToId } from '../ui/scrollToId';

const OUTREACH_TABS: ReadonlyArray<{ sub: string; path: string; label: string }> = [
  { sub: '', path: '/outreach', label: 'Campaigns' },
  { sub: 'inbox', path: '/outreach/inbox', label: 'Messages' },
  { sub: 'posts', path: '/outreach/posts', label: 'Posts' },
  { sub: 'settings', path: '/outreach/settings', label: 'Settings' }
];

/** Old addresses, and where each one now lives. */
const OUTREACH_LEGACY_REDIRECTS: Record<string, string> = {
  manager: '/outreach',
  campaigns: '/outreach',
  plan: '/outreach',
  activity: '/outreach',
  leads: '/outreach',
  accounts: '/outreach'
};

/** Legacy addresses whose content is now a fold on the Campaigns screen. */
const OUTREACH_LEGACY_ANCHORS: Record<string, string> = {
  leads: 'leads',
  accounts: 'accounts'
};

/** Which tab owns the screen being shown. Legacy subs are mid-redirect and own none. */
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
    // `/outreach/manager/new` was the builder's address.
    replaceNavigate(sub === 'manager' && route.id === 'new' ? '/outreach/new' : target);
  }, [sub, route.id]);

  useEffect(() => {
    if (!anchor) return;
    const node = document.getElementById(anchor.id);
    if (node instanceof HTMLDetailsElement) node.open = true;
    return scrollToId(anchor.id);
  }, [anchor]);

  const current = activeSub(sub);
  const [workflowId, campaignId] = sub === 'workflow' ? (route.id ?? '').split('/') : ['', ''];

  return (
    <div className="page-stack outreach-simple li-polished">
      <LinkedInCompanionAttention setToast={setToast} />
      <nav className="outreach-nav" aria-label="Outreach sections">
        {OUTREACH_TABS.map((tab) => (
          <button
            key={tab.path}
            type="button"
            className={tab.sub === current ? 'is-active' : undefined}
            aria-current={tab.sub === current ? 'page' : undefined}
            onClick={() => onNavigate(tab.path)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {sub === 'inbox' && <OutreachInbox setToast={setToast} />}
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
                  campaignId ? `/outreach/campaign/${encodeURIComponent(campaignId)}` : '/outreach'
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
