import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { EXECUTION_ACTION_TYPES, executePreparedPlaybookAction } from './execution.js';

describe('GTM prepared-action boundary', () => {
  it('exposes the named GTM execution actions', () => {
    expect(EXECUTION_ACTION_TYPES).toEqual(['email.send', 'community.reply', 'crm.log-activity']);
  });
  it('validates the GTM email payload before touching a connection', async () => {
    await expect(
      executePreparedPlaybookAction({} as Db, {
        workspaceId: 'ws_test',
        actionType: 'email.send',
        payload: { recipient: 'not-an-email', subject: '', body: '' },
        payloadHash: 'c'.repeat(64)
      })
    ).rejects.toThrow();
  });
});
