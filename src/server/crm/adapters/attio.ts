import type { CrmAdapter, CrmActivity, CrmContactRef, CrmProxy, ContactHint } from '../types.js';

/**
 * Attio.
 *
 * Endpoints, current as of 2026-08-03:
 * - Query people: POST /v2/objects/people/records/query
 *   https://developers.attio.com/reference/post_v2-objects-object-records-query
 * - Create note:  POST /v2/notes
 *   https://developers.attio.com/reference/post_v2-notes
 *
 * Attio's note body is plain text when `format: 'plaintext'`, so unlike HubSpot
 * nothing needs escaping.
 */

interface AttioQueryResponse {
  data?: Array<{
    id?: { record_id?: unknown };
    values?: Record<string, unknown>;
  }>;
}

function firstValue(values: Record<string, unknown> | undefined, attribute: string, key: string): string | null {
  const entries = values?.[attribute];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const value = (entries[0] as Record<string, unknown>)?.[key];
  return typeof value === 'string' && value ? value : null;
}

export const attioCrmAdapter: CrmAdapter = {
  key: 'attio',
  name: 'Attio',
  docsUrl: 'https://developers.attio.com/reference/post_v2-notes',
  writes: ['note on an existing person record'],

  async findContact(hint: ContactHint, proxy: CrmProxy): Promise<CrmContactRef | null> {
    const email = hint.email?.trim().toLowerCase();
    if (!email) return null;

    const response = await proxy.post<AttioQueryResponse>('/v2/objects/people/records/query', {
      filter: { email_addresses: { email_address: email } },
      limit: 1
    });

    const hit = response.data?.[0];
    const recordId = hit?.id?.record_id;
    if (!recordId) return null;
    return { externalId: String(recordId), label: firstValue(hit?.values, 'name', 'full_name') ?? email };
  },

  async logActivity(contact: CrmContactRef, activity: CrmActivity, proxy: CrmProxy): Promise<string> {
    const content = activity.url ? `${activity.body}\n\n${activity.url}` : activity.body;
    const response = await proxy.post<{ data?: { id?: { note_id?: unknown } } }>('/v2/notes', {
      data: {
        parent_object: 'people',
        parent_record_id: contact.externalId,
        title: activity.subject,
        format: 'plaintext',
        content,
        created_at: activity.occurredAt
      }
    });
    const noteId = response.data?.id?.note_id;
    if (!noteId) throw new Error('Attio accepted the note but returned no id');
    return String(noteId);
  }
};
