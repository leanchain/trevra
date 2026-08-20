import { MarketingScreen } from './MarketingScreen';

// `?.` on `import.meta.env` itself, not just the property: this module is
// also imported by scripts/prerender-marketing.tsx under plain tsx/Node,
// where nothing defines `import.meta.env` and it is `undefined` rather than
// `{}`. Vite always provides the object, so this is a no-op there.
const HOSTED_APP_URL = import.meta.env?.VITE_HOSTED_APP_URL?.trim() ?? '';
const GITHUB_URL = import.meta.env?.VITE_GITHUB_URL?.trim() ?? '';

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Public-site entry point. The marketing build owns this surface exclusively. */
export function MarketingApp() {
  return (
    <MarketingScreen
      hostedAppUrl={HOSTED_APP_URL}
      githubUrl={GITHUB_URL}
      onGetStarted={() =>
        document
          .getElementById('hosted')
          ?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' })
      }
    />
  );
}
