import { useEffect, useState } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { App } from './App';
import { LinkedInManager } from './LinkedInManager';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return hash;
}

/**
 * App.tsx owns a very large five-section shell. The manager is mounted here so
 * its rollout does not require replacing that file wholesale through GitHub's
 * contents API. Once the shell is split into smaller route modules this can
 * move into its normal Outreach tab switch without changing the URL.
 */
export function ClientRoot() {
  const hash = useHash();
  const managerOpen = hash === '#/outreach/manager' || hash.startsWith('#/outreach/manager/');
  const outreachOpen = hash === '#/outreach' || hash.startsWith('#/outreach/');

  if (managerOpen) {
    return <main style={{ minHeight: '100vh', padding: '24px', background: 'var(--background, #f7f7f5)' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <a href="#/outreach" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 14, color: 'inherit', textDecoration: 'none' }}>
          <ArrowLeft size={16} /> Back to Outreach
        </a>
        <LinkedInManager />
      </div>
    </main>;
  }

  return <>
    <App />
    {outreachOpen && <a
      href="#/outreach/manager"
      aria-label="Open LinkedIn outreach manager"
      style={{
        position: 'fixed', right: 20, bottom: 20, zIndex: 40,
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '10px 14px', borderRadius: 999,
        border: '1px solid var(--border)', background: 'var(--surface)',
        color: 'inherit', textDecoration: 'none', boxShadow: '0 8px 28px rgba(0,0,0,.12)'
      }}
    >
      <Settings2 size={16} /> Manager
    </a>}
  </>;
}
