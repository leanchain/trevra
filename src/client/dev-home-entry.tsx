import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// DEV ONLY. Reached solely through vite.config.ts's `trevra-dev-home-marketing`
// plugin, which serves this entry at `/` on the ordinary development server so
// the landing page and its login hand-off can be clicked end to end without a
// build. Production never loads this file: there, `/` is the prerendered
// marketing index.html (scripts/prerender-marketing.tsx) served by Express.
import { MarketingScreen } from './MarketingScreen';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MarketingScreen
      hostedAppUrl="/login"
      onGetStarted={() => document.getElementById('hosted')?.scrollIntoView()}
    />
  </StrictMode>
);
