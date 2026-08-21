import { describe, expect, it } from 'vitest';
import { SERVER_LOCAL_BROWSER_DISABLED_REASON, serverLocalBrowserDisabledReason } from './local.js';

describe('server-local browser ownership', () => {
  it('exposes only the architectural refusal, not a Chromium launcher', () => {
    expect(serverLocalBrowserDisabledReason()).toBe(SERVER_LOCAL_BROWSER_DISABLED_REASON);
    expect(SERVER_LOCAL_BROWSER_DISABLED_REASON).toMatch(
      /Server-local browser launches are disabled/
    );
  });
});
