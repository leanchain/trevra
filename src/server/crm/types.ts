/**
 * CRM write-back contract.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: Trevra writes ACTIVITY, never
 * RECORDS. It appends a note saying what happened and links the evidence. It
 * does not create contacts, move deal stages, edit properties, or own any CRM
 * object -- because the team's CRM is the system of record for those and a
 * second writer is how two systems start disagreeing.
 *
 * That constraint is what makes this safe to turn on in a workspace where 30
 * salespeople already work. The worst case is a note nobody wanted; there is
 * no path here that mutates their pipeline.
 *
 * Adapters follow the same shape as `channels/` and `research/`: registered by
 * key, first registration wins, each one stating what it can actually do.
 */

/** Minimal proxy over one connected CRM. Implemented with the Nango proxy; stubbed in tests. */
export interface CrmProxy {
  post<T = unknown>(endpoint: string, data: unknown): Promise<T>;
  get<T = unknown>(endpoint: string, params?: Record<string, string>): Promise<T>;
}

/** Whatever we know about who a piece of work concerned. */
export interface ContactHint {
  /** The strongest signal. CRMs index on it and it is the only one they all share. */
  email?: string | null;
  /** Platform handle, e.g. a GitHub login. Resolved locally, never sent to the CRM as a query. */
  handle?: string | null;
  /** Which platform `handle` belongs to. */
  handleProvider?: string | null;
  domain?: string | null;
}

export interface CrmContactRef {
  /** The CRM's own record id. */
  externalId: string;
  /** For the audit trail and the operator's sanity. */
  label: string;
}

export interface CrmActivity {
  /** One line, e.g. `Replied on GitHub: acme/acme#412`. */
  subject: string;
  /** The note body. Plain text; adapters escape as their API requires. */
  body: string;
  /** Where the thing being reported lives, appended to the note so it is clickable. */
  url?: string | null;
  /** ISO-8601. CRMs timestamp notes and will default to now if omitted. */
  occurredAt: string;
}

export interface CrmAdapter {
  /** Matches the `connections.provider` value. */
  key: string;
  name: string;
  docsUrl: string;
  /**
   * Exactly what this adapter is able to write, for the connect screen. Keep it
   * honest and keep it short -- a user reading it should be able to predict
   * every mutation Trevra can make in their CRM.
   */
  writes: readonly string[];
  /** Look up a contact. Returns null when the CRM has nobody matching -- not an error. */
  findContact(hint: ContactHint, proxy: CrmProxy): Promise<CrmContactRef | null>;
  /** Append a note to `contact`. Returns the CRM's id for it. */
  logActivity(contact: CrmContactRef, activity: CrmActivity, proxy: CrmProxy): Promise<string>;
}
