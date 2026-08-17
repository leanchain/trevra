import { MarketingScreen } from './MarketingScreen';

const HOSTED_APP_URL = import.meta.env.VITE_HOSTED_APP_URL?.trim() ?? '';
const GITHUB_URL = import.meta.env.VITE_GITHUB_URL?.trim() ?? '';

const reducedMotion = () => typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Public-site entry point. The marketing build owns this surface exclusively. */
export function MarketingApp() {
  return <MarketingScreen
    hostedAppUrl={HOSTED_APP_URL}
    githubUrl={GITHUB_URL}
    onGetStarted={() => document.getElementById('hosted')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' })}
  />;
}
