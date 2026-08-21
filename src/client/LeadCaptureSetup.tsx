import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  RefreshCw
} from 'lucide-react';
import {
  createCaptureSource,
  getCaptureSources,
  getPublicConfig,
  rotateCaptureSourceSecret,
  setCaptureSourceStatus,
  type CaptureSourceSummary
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { Button, Field, Input, Select } from './ui/primitives';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import './lead-capture.css';

const SOURCE_KINDS: Array<{ value: CaptureSourceSummary['kind']; label: string }> = [
  { value: 'website', label: 'Website' },
  { value: 'form', label: 'Form' },
  { value: 'signup', label: 'Signup' },
  { value: 'partner', label: 'Partner' },
  { value: 'integration', label: 'Integration' }
];

function recipe(
  kind: 'cloudflare' | 'next' | 'curl',
  apiBaseUrl: string,
  sourceId: string
): string {
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/api/intake/v1/submissions`;
  if (kind === 'curl') {
    return `# Sign <timestamp>.<idempotency-key>.<exact raw JSON> with HMAC-SHA256\n# using a server-side TREVRA_CAPTURE_SECRET environment variable\ncurl -X POST '${endpoint}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Trevra-Source: ${sourceId}' \\\n  -H 'X-Trevra-Timestamp: <unix-seconds>' \\\n  -H 'X-Trevra-Idempotency-Key: <stable-key>' \\\n  -H 'X-Trevra-Signature: sha256=<hex-hmac>' \\\n  --data-binary '{"kind":"demo_request","person":{"email":"ada@example.com"}}'`;
  }
  if (kind === 'cloudflare') {
    return `// Cloudflare Worker /api/lead\nconst raw = JSON.stringify(payload);\nconst timestamp = Math.floor(Date.now() / 1000).toString();\nconst idempotencyKey = formSubmissionId; // generate once; reuse for every retry\nconst input = new TextEncoder().encode(timestamp + "." + idempotencyKey + "." + raw);\nconst key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TREVRA_CAPTURE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);\nconst bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));\nconst signature = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");\nreturn fetch("${endpoint}", {\n  method: "POST",\n  headers: {\n    "content-type": "application/json",\n    "x-trevra-source": "${sourceId}",\n    "x-trevra-timestamp": timestamp,\n    "x-trevra-idempotency-key": idempotencyKey,\n    "x-trevra-signature": "sha256=" + signature\n  },\n  body: raw\n});`;
  }
  return `// Next.js / Vercel route handler (server only)\nimport { createHmac } from "node:crypto";\n\nconst raw = JSON.stringify(payload);\nconst timestamp = Math.floor(Date.now() / 1000).toString();\nconst idempotencyKey = formSubmissionId; // generate once; reuse for every retry\nconst signature = createHmac("sha256", process.env.TREVRA_CAPTURE_SECRET!)\n  .update(timestamp + "." + idempotencyKey + "." + raw)\n  .digest("hex");\n\nawait fetch("${endpoint}", {\n  method: "POST",\n  headers: {\n    "content-type": "application/json",\n    "x-trevra-source": "${sourceId}",\n    "x-trevra-timestamp": timestamp,\n    "x-trevra-idempotency-key": idempotencyKey,\n    "x-trevra-signature": "sha256=" + signature\n  },\n  body: raw\n});`;
}

async function signBrowser(secret: string, timestamp: string, idempotencyKey: string, raw: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const input = new TextEncoder().encode(`${timestamp}.${idempotencyKey}.${raw}`);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function LeadCaptureSetup({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  const [sources, setSources] = useState<CaptureSourceSummary[]>([]);
  const [name, setName] = useState('Website');
  const [kind, setKind] = useState<CaptureSourceSummary['kind']>('website');
  const [selectedId, setSelectedId] = useState('');
  const [revealed, setRevealed] = useState<{ sourceId: string; secret: string } | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const [recipeKind, setRecipeKind] = useState<'cloudflare' | 'next' | 'curl'>('cloudflare');

  const load = async () => {
    const [nextSources, config] = await Promise.all([getCaptureSources(), getPublicConfig()]);
    setSources(nextSources);
    setApiBaseUrl(config.apiBaseUrl || window.location.origin);
    setSelectedId((current) => current || nextSources[0]?.id || '');
  };

  useEffect(() => {
    void load().catch((error) => setProblem(errorMessage(error, 'Unable to load lead capture.')));
  }, []);

  const selected = sources.find((source) => source.id === selectedId) ?? sources[0] ?? null;
  const visibleSecret =
    revealed && selected && revealed.sourceId === selected.id ? revealed.secret : '';
  const integrationRecipe = useMemo(
    () => (selected ? recipe(recipeKind, apiBaseUrl || window.location.origin, selected.id) : ''),
    [selected, recipeKind, apiBaseUrl]
  );

  const create = async () => {
    setBusy('create');
    setProblem('');
    try {
      const created = await createCaptureSource({ name, kind });
      setSources((current) => [created.source, ...current]);
      setSelectedId(created.source.id);
      setRevealed({ sourceId: created.source.id, secret: created.secret });
      setToast('Capture source created. Copy the signing secret now.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to create capture source.'));
    } finally {
      setBusy('');
    }
  };

  const toggle = async (source: CaptureSourceSummary) => {
    setBusy(source.id);
    setProblem('');
    try {
      const next = await setCaptureSourceStatus(
        source.id,
        source.status === 'active' ? 'disabled' : 'active'
      );
      setSources((current) => current.map((item) => (item.id === next.id ? next : item)));
      setToast(next.status === 'active' ? 'Capture source enabled.' : 'Capture source disabled.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to change capture source.'));
    } finally {
      setBusy('');
    }
  };

  const rotate = async (source: CaptureSourceSummary) => {
    setBusy(`rotate:${source.id}`);
    setProblem('');
    try {
      const rotated = await rotateCaptureSourceSecret(source.id);
      setSources((current) =>
        current.map((item) => (item.id === source.id ? rotated.source : item))
      );
      setRevealed({ sourceId: source.id, secret: rotated.secret });
      setToast('Signing secret rotated. The previous secret remains valid briefly.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to rotate the signing secret.'));
    } finally {
      setBusy('');
    }
  };

  const test = async () => {
    if (!selected || !visibleSecret) return;
    setBusy('test');
    setProblem('');
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const idempotencyKey = `test-${crypto.randomUUID()}`;
      const raw = JSON.stringify({
        kind: 'demo_request',
        person: {
          name: 'Trevra capture test',
          email: `capture-test+${Date.now()}@example.com`
        },
        properties: { trevra_test: true }
      });
      const signature = await signBrowser(visibleSecret, timestamp, idempotencyKey, raw);
      const response = await fetch('/api/intake/v1/submissions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-trevra-source': selected.id,
          'x-trevra-timestamp': timestamp,
          'x-trevra-idempotency-key': idempotencyKey,
          'x-trevra-signature': `sha256=${signature}`
        },
        body: raw
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Test failed (${response.status})`);
      }
      setToast('Signed test submission accepted.');
      await load();
    } catch (error) {
      setProblem(errorMessage(error, 'Test submission failed.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="page-stack capture-setup">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3>Lead capture</h3>
            <p>Connect a landing page or website backend to this workspace.</p>
          </div>
          <KeyRound size={20} />
        </div>
        {problem && <div className="error-box">{problem}</div>}
        {isOwner && (
          <div className="capture-create-row">
            <Field label="Source name">
              <Input
                value={name}
                maxLength={120}
                placeholder="Website"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Type">
              <Select
                value={kind}
                onChange={(event) => setKind(event.target.value as CaptureSourceSummary['kind'])}
              >
                {SOURCE_KINDS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              variant="primary"
              disabled={!name.trim() || busy === 'create'}
              onClick={() => void create()}
            >
              {busy === 'create' ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <KeyRound size={15} />
              )}
              Add source
            </Button>
          </div>
        )}
      </section>

      <section className="page-panel capture-source-grid">
        <div className="capture-source-list">
          {sources.length === 0 ? (
            <div className="empty-state">
              <h4>No capture sources yet</h4>
              <p>Create one to connect your website.</p>
            </div>
          ) : (
            sources.map((source) => (
              <button
                key={source.id}
                type="button"
                className={`capture-source-card ${selected?.id === source.id ? 'is-active' : ''}`}
                onClick={() => {
                  setSelectedId(source.id);
                  setRevealed((current) => (current?.sourceId === source.id ? current : null));
                }}
              >
                <span>
                  <strong>{source.name}</strong>
                  <small>
                    {source.kind} · {source.status}
                  </small>
                </span>
                <span>
                  <strong>{source.acceptedCount}</strong>
                  <small>accepted</small>
                </span>
              </button>
            ))
          )}
        </div>

        {selected && (
          <div className="capture-source-detail">
            <div className="section-heading">
              <div>
                <h3>{selected.name}</h3>
                <p>{selected.id}</p>
              </div>
              <span className={`status-pill ${selected.status === 'active' ? 'ok' : ''}`}>
                {selected.status}
              </span>
            </div>
            <div className="capture-metrics">
              <span>
                <strong>{selected.acceptedCount}</strong>
                <small>Accepted</small>
              </span>
              <span>
                <strong>{selected.rejectedCount}</strong>
                <small>Rejected</small>
              </span>
              <span>
                <strong>{selected.lastSeenAt ? relativeTime(selected.lastSeenAt) : 'Never'}</strong>
                <small>Last received</small>
              </span>
            </div>

            {visibleSecret ? (
              <div className="capture-secret">
                <strong>Signing secret — shown only now</strong>
                <code>{visibleSecret}</code>
                <div className="capture-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(visibleSecret)
                        .then(() => setToast('Secret copied.'))
                    }
                  >
                    <Copy size={14} /> Copy secret
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy === 'test'}
                    onClick={() => void test()}
                  >
                    {busy === 'test' ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <Check size={14} />
                    )}{' '}
                    Send signed test
                  </button>
                </div>
              </div>
            ) : (
              <p className="li-hint">
                Stored signing secrets are write-only. Rotate to receive a new secret.
              </p>
            )}

            <div className="capture-actions">
              {isOwner && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy === selected.id}
                  onClick={() => void toggle(selected)}
                >
                  {selected.status === 'active' ? (
                    <PauseCircle size={14} />
                  ) : (
                    <PlayCircle size={14} />
                  )}{' '}
                  {selected.status === 'active' ? 'Disable' : 'Enable'}
                </button>
              )}
              {isOwner && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy === `rotate:${selected.id}`}
                  onClick={() => void rotate(selected)}
                >
                  {busy === `rotate:${selected.id}` ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <RefreshCw size={14} />
                  )}{' '}
                  Rotate secret
                </button>
              )}
            </div>

            <div className="capture-recipes">
              <nav aria-label="Integration recipes">
                {(['cloudflare', 'next', 'curl'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={recipeKind === value ? 'is-active' : undefined}
                    onClick={() => setRecipeKind(value)}
                  >
                    {value === 'next'
                      ? 'Next.js / Vercel'
                      : value === 'cloudflare'
                        ? 'Cloudflare Worker'
                        : 'curl / raw HTTP'}
                  </button>
                ))}
              </nav>
              <pre>
                <code>{integrationRecipe}</code>
              </pre>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(integrationRecipe)
                    .then(() => setToast('Recipe copied.'))
                }
              >
                <Copy size={14} /> Copy recipe
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
