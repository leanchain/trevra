import type { CrmAdapter, CrmActivity, CrmContactRef, CrmProxy, ContactHint } from '../types.js';

/**
 * HubSpot.
 *
 * Endpoints, current as of 2026-08-03:
 * - Search contacts: POST /crm/v3/objects/contacts/search
 *   https://developers.hubspot.com/docs/api/crm/search
 * - Create note:     POST /crm/v3/objects/notes
 *   https://developers.hubspot.com/docs/api/crm/notes
 *
 * Reached through the Nango proxy, so no Nango action script has to be deployed
 * for this to work -- a fresh install with a connected HubSpot can write on day
 * one.
 *
 * Scopes required on the HubSpot app: `crm.objects.contacts.read` and
 * `crm.objects.notes.write`. Deliberately NOT `crm.objects.contacts.write`:
 * this adapter must not be able to edit a contact even if a future bug asked
 * it to.
 */

/** HubSpot's association type id for note -> contact. Defined by HubSpot, not by us. */
const NOTE_TO_CONTACT_ASSOCIATION = 202;

interface HubspotSearchResponse {
  results?: Array<{ id?: unknown; properties?: Record<string, unknown> }>;
}

export const hubspotCrmAdapter: CrmAdapter = {
  key: 'hubspot',
  name: 'HubSpot',
  docsUrl: 'https://developers.hubspot.com/docs/api/crm/notes',
  writes: ['note on an existing contact'],

  async findContact(hint: ContactHint, proxy: CrmProxy): Promise<CrmContactRef | null> {
    const email = hint.email?.trim().toLowerCase();
    // Email only. Searching HubSpot by a GitHub handle would either miss or,
    // worse, fuzzy-match the wrong person and attach outreach to their record.
    if (!email) return null;

    const response = await proxy.post<HubspotSearchResponse>('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email', 'firstname', 'lastname'],
      limit: 1
    });

    const hit = response.results?.[0];
    if (!hit?.id) return null;
    const properties = hit.properties ?? {};
    const name = [properties.firstname, properties.lastname].filter((part) => typeof part === 'string' && part).join(' ');
    return { externalId: String(hit.id), label: name || email };
  },

  async logActivity(contact: CrmContactRef, activity: CrmActivity, proxy: CrmProxy): Promise<string> {
    const body = activity.url ? `${activity.subject}\n\n${activity.body}\n\n${activity.url}` : `${activity.subject}\n\n${activity.body}`;
    const response = await proxy.post<{ id?: unknown }>('/crm/v3/objects/notes', {
      properties: {
        // HubSpot renders this as HTML, so a plain-text body needs its newlines
        // converted or the note arrives as one run-on paragraph.
        hs_note_body: escapeHtml(body).replaceAll('\n', '<br>'),
        hs_timestamp: activity.occurredAt
      },
      associations: [
        {
          to: { id: contact.externalId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT_ASSOCIATION }]
        }
      ]
    });
    if (!response.id) throw new Error('HubSpot accepted the note but returned no id');
    return String(response.id);
  }
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
