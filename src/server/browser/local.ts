/**
 * Server-local browser execution is intentionally unavailable.
 *
 * Browser binaries, profile locks, display probing and Playwright launch calls
 * belong to Companion devices. The server may keep Playwright/Patchright as a
 * protocol client, but no code under `src/server` may use this module to launch
 * Chrome or Chromium.
 */
export const SERVER_LOCAL_BROWSER_DISABLED_REASON =
  'Server-local browser launches are disabled. Pair a Companion device or configure a remote browser provider.';

export function serverLocalBrowserDisabledReason(): string {
  return SERVER_LOCAL_BROWSER_DISABLED_REASON;
}
