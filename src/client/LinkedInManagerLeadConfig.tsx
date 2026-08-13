import { useState } from 'react';
import { FileUp, LoaderCircle, Plus } from 'lucide-react';
import {
  createLinkedInManagerLeadList,
  previewLinkedInManagerLeadCsv,
  type LinkedInLeadCsvPreview
} from './api';
import type { LeadListSourceKind } from '../server/linkedin/lead-lists';
import { errorMessage } from './LinkedInSafety';

const SOURCE_OPTIONS: Array<{ value: LeadListSourceKind; label: string }> = [
  { value: 'csv', label: 'CSV upload' },
  { value: 'linkedin_search', label: 'LinkedIn people search' },
  { value: 'sales_navigator', label: 'Sales Navigator people search' },
  { value: 'post_keyword', label: 'Post/comment keyword discovery' }
];

export function LinkedInManagerLeadConfig({ onChanged, setToast }: { onChanged: () => Promise<void>; setToast: (message: string) => void }) {
  const [name, setName] = useState('');
  const [sourceKind, setSourceKind] = useState<LeadListSourceKind>('csv');
  const [sourceRef, setSourceRef] = useState('');
  const [preview, setPreview] = useState<LinkedInLeadCsvPreview | null>(null);
  const [busy, setBusy] = useState<'create' | 'preview' | null>(null);
  const [error, setError] = useState('');

  const previewFile = async (file: File | null) => {
    if (!file) return;
    setBusy('preview');
    setError('');
    try {
      const result = await previewLinkedInManagerLeadCsv(file);
      setPreview(result);
      setToast(`${result.acceptedCount} valid row(s), ${result.rejectedCount} rejected. Preview stored nothing.`);
    } catch (err) {
      setError(errorMessage(err, 'Unable to preview that CSV.'));
    } finally { setBusy(null); }
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy('create');
    setError('');
    try {
      const list = await createLinkedInManagerLeadList({
        name: name.trim(),
        sourceKind,
        sourceRef: sourceRef.trim() || null
      });
      setName('');
      setSourceRef('');
      setToast(`Lead list “${list.name}” created. No LinkedIn action was queued.`);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Unable to create that lead list.'));
    } finally { setBusy(null); }
  };

  return <section className="page-panel">
    <div className="section-heading"><div><h3 aria-level={2}>Create a lead list</h3><p>Persistent list metadata is separate from lead-source scraping. Search URLs are stored as provenance; this form does not fetch them.</p></div></div>
    {error && <div className="error-banner">{error}</div>}
    <div className="li-form-grid">
      <label>List name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Q3 founders" /></label>
      <label>Source<select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as LeadListSourceKind)}>{SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {(sourceKind === 'linkedin_search' || sourceKind === 'sales_navigator') && <label>Search URL<input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} placeholder={sourceKind === 'sales_navigator' ? 'https://www.linkedin.com/sales/search/people/…' : 'https://www.linkedin.com/search/results/people/…'} /></label>}
    </div>
    {sourceKind === 'csv' && <div className="li-filter-row">
      <label className="secondary-button"><FileUp size={14} /> {busy === 'preview' ? 'Reading CSV…' : 'Preview CSV fields'}<input type="file" accept=".csv,text/csv" hidden disabled={busy !== null} onChange={(event) => void previewFile(event.target.files?.[0] ?? null)} /></label>
      {preview && <span>{preview.acceptedCount} valid · {preview.rejectedCount} rejected · {Object.keys(preview.mapping).length} mapped field(s)</span>}
    </div>}
    {preview && <div className="li-degraded"><strong>Automatched fields</strong><p>{Object.entries(preview.mapping).map(([field, header]) => `${field} ← ${header}`).join(' · ') || 'No fields matched.'}</p>{preview.rejected.length > 0 && <p>{preview.rejected.slice(0, 5).map((row) => `Row ${row.row}: ${row.reason}`).join(' · ')}</p>}<p>This endpoint is a preview only. It deliberately writes no lead row.</p></div>}
    <div className="panel-footer"><span>First name, last name and company are mandatory when leads are persisted.</span><button className="primary-button" type="button" disabled={busy !== null || !name.trim() || ((sourceKind === 'linkedin_search' || sourceKind === 'sales_navigator') && !sourceRef.trim())} onClick={() => void create()}>{busy === 'create' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Create list</button></div>
  </section>;
}
