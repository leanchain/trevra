import { useEffect, useRef, useState } from 'react';
import { AccountsScreen } from '../AccountsScreen';
import { LinkedInAccounts, LinkedInCompanionAttention } from '../LinkedInAccounts';
import { OutreachInbox } from '../LinkedInInbox';
import { OutreachLeads } from '../LinkedInLeads';
import { OutreachManagerBuilder } from '../LinkedInManagerBuilder';
import { OutreachManagerRead } from '../LinkedInManagerRead';
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
  if (sub === 'new') return '';
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

  return (
    <div className="page-stack outreach-simple">
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
      {sub === '' && (
        <>
          <OutreachManagerRead setToast={setToast} onNavigate={onNavigate} />
          <details className="mgr-inputs" id="leads">
            <summary>Find people</summary>
            <div className="mgr-inputs-body">
              <OutreachLeads setToast={setToast} />
            </div>
          </details>
          <details className="mgr-inputs" id="accounts">
            <summary>Target accounts</summary>
            <div className="mgr-inputs-body">
              <AccountsScreen setToast={setToast} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
