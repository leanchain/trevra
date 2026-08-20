import { useEffect, useState } from 'react';
import { Ban, LoaderCircle } from 'lucide-react';
import {
  addLinkedInExclusions,
  getLinkedInExclusions,
  type LinkedInExclusion,
  type LinkedInLimitConfidence
} from './api';
import { errorMessage, useOutreachRefresh } from './LinkedInSafety';

/**
 * LinkedIn outreach (docs/linkedin-outreach-plan.md section 6).
 *
 * What is left here is `/setup/limits` -- the never-contact list. Seat
 * identity, credentials, the local worker, the operating dashboard and
 * pending-invite withdrawal all moved to Outreach -> Settings
 * (`src/client/LinkedInAccounts.tsx`), and `/setup/seat` is now a redirect
 * there (`SetupView` in App.tsx) rather than a screen of its own. Two things
 * that were true of the whole surface stay true of what is left:
 *
 * 1. THE STOP IS ALWAYS REACHABLE -- and it is not here. The kill switch used
 *    to sit above the tab strip because the one moment it is needed is the
 *    moment something else has already gone wrong, and a switch somebody has
 *    to navigate to is a switch they find too late. That argument was always
 *    for a control ONE LEVEL UP, so it lives there: `StopBar` in the app
 *    shell, on every route, stopping the agent in the same breath.
 * 2. NO SCREEN SENDS ANYTHING. There is no route that would let one. What
 *    reaches LinkedIn reaches it through a file the operator downloads and
 *    runs in their own tool, or through the self-hosted worker driving a
 *    browser they logged into by hand.
 */

/**
 * `2 hours ago`. For the one timestamp an operator reads as a duration -- how
 * stale the signed-in session is -- where an absolute clock time answers a
 * question nobody asked. The seat card keeps its absolute dates.
 */
export const relativeTime = (iso: string) => {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12]
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit);
    value /= size;
  }
  return format.format(Math.round(value), 'year');
};

/**
 * Where a number came from, in a sentence instead of a file path.
 *
 * The server ships its own internal document reference as the provenance of
 * every ceiling. That reference is true and it is unreadable: nobody deciding
 * whether to trust a daily limit can open `docs/…md 1.4`. The claim the tag
 * makes -- published by LinkedIn, or measured by practitioners -- is the part
 * that changes the decision, so that is the part that is rendered, and the
 * paths stay out of the interface entirely.
 */
export const sourceNote = (confidence: LinkedInLimitConfidence) =>
  confidence === 'HARD FACT'
    ? 'Published by LinkedIn, or a term of its own contract.'
    : 'Measured by people running LinkedIn outreach, not published by LinkedIn. Directionally right, never a guarantee.';

/* -------------------------------------------------------------------------
 * `/setup/limits` -- the never-contact list.
 * ---------------------------------------------------------------------- */

/**
 * Set once, and its own copy says so: there is no removal button, because
 * removing an entry is a database operation. That is not a screen an operator
 * returns to, which is why it sits under Setup beside the automation rules
 * rather than in the pipeline it constrains.
 */
export function LinkedInExclusions({ setToast }: { setToast: (message: string) => void }) {
  const [exclusions, setExclusions] = useState<LinkedInExclusion[]>([]);
  const [targets, setTargets] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setExclusions(await getLinkedInExclusions());
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to load the exclusion list'));
    }
  };

  useEffect(() => {
    void load();
  }, []);
  useOutreachRefresh(load);

  const add = async () => {
    const list = targets
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (list.length === 0) {
      setError('Add at least one handle or profile URL.');
      return;
    }
    setBusy(true);
    try {
      const result = await addLinkedInExclusions(
        list.map((targetRef) => ({ targetRef, reason: reason.trim() }))
      );
      setToast(`${result.added} added, ${result.updated} already on the list and updated.`);
      setTargets('');
      setReason('');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to add those exclusions'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Never contact</h3>
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="li-form-grid">
          <label className="li-span-2">
            Handles or profile URLs, one per line
            <textarea
              rows={4}
              value={targets}
              onChange={(event) => setTargets(event.target.value)}
            />
          </label>
          <label className="li-span-2">
            Reason
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Asked to be left alone"
            />
          </label>
        </div>
        <div className="panel-footer">
          <span>
            There is no Remove button here — taking somebody off this list is a database change, on
            purpose.
          </span>
          <button className="primary-button" disabled={busy} onClick={() => void add()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Ban size={15} />} Add to the list
          </button>
        </div>
      </section>

      <section className="page-panel">
        {exclusions.length > 0 && (
          <div className="li-table-scroll">
            <table className="li-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Reason</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {exclusions.map((entry) => (
                  <tr key={entry.id}>
                    <td className="li-target">{entry.targetRef}</td>
                    <td>{entry.reason || '—'}</td>
                    <td>{new Date(entry.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
