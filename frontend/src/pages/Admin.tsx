import { useCallback, useEffect, useState } from 'react';
import { api, type OwnedFile } from '../lib/api';
import { Alert, Icon, Spinner, useNow, useToast } from '../components/ui';
import { StatusBadge } from './MyFiles';
import { formatBytes, formatShortDate } from '../lib/format';

interface Stats {
  totalFiles: number; storedBytes: number; activeFiles: number; expiredAwaitingDeletion: number;
  deletionsPending: number; deletionFailures: number; uploadsInProgress: number; users: number; totalDownloads: number;
  storage: { provider: string; usedBytes: number; quotaBytes: number };
  recentErrors: { id: string; source: string; message: string; at: string; context?: any }[];
}
interface Settings {
  maxFileBytes: number; allowedRetentionKeys: string[]; allowAnonymous: boolean; allowRegistration: boolean;
  storageQuotaBytes: number; uploadsPerHour: number; blockedExtensions: string[];
}
const RETENTION = [['1h', '1 hour'], ['6h', '6 hours'], ['12h', '12 hours'], ['1d', '1 day'], ['3d', '3 days'], ['7d', '7 days'], ['14d', '14 days'], ['30d', '30 days']];
const TABS = ['Overview', 'Files', 'Settings', 'Activity'] as const;
type Tab = (typeof TABS)[number];

export default function Admin() {
  const [tab, setTab] = useState<Tab>('Overview');
  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-10 sm:px-6">
      <h1 className="text-xl font-semibold tracking-tight">Administration</h1>
      <div className="relative mt-5 flex gap-1 border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors duration-150 ${tab === t ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}>{t}</button>
        ))}
      </div>
      <div key={tab} className="mt-6 animate-fade-up">
        {tab === 'Overview' && <Overview />}
        {tab === 'Files' && <Files />}
        {tab === 'Settings' && <SettingsForm />}
        {tab === 'Activity' && <Activity />}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'danger' | 'warn' }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : ''}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>}
    </div>
  );
}

function Overview() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const { show, toast } = useToast();
  const load = useCallback(() => api<Stats>('/api/admin/stats').then(setS).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  if (err) return <Alert>{err}</Alert>;
  if (!s) return <div className="flex h-40 items-center justify-center text-ink-muted"><Spinner className="h-5 w-5" /></div>;
  const pct = Math.min(100, (s.storage.usedBytes / s.storage.quotaBytes) * 100);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total files" value={s.totalFiles} sub={`${s.activeFiles} active`} />
        <Stat label="Stored" value={formatBytes(s.storedBytes)} sub={`via ${s.storage.provider}`} />
        <Stat label="Uploads in progress" value={s.uploadsInProgress} />
        <Stat label="Downloads" value={s.totalDownloads} sub={`${s.users} accounts`} />
        <Stat label="Expired, awaiting delete" value={s.expiredAwaitingDeletion} tone={s.expiredAwaitingDeletion > 0 ? 'warn' : undefined} />
        <Stat label="Deletions pending" value={s.deletionsPending} />
        <Stat label="Deletion failures" value={s.deletionFailures} tone={s.deletionFailures > 0 ? 'danger' : undefined} sub={s.deletionFailures ? 'retrying with backoff' : 'none'} />
        <div className="card flex items-center justify-center p-4">
          <button className="btn-secondary" disabled={running} onClick={async () => {
            setRunning(true);
            try { const r = await api<any>('/api/admin/cleanup/run', { method: 'POST' }); show(`Cleanup: ${r.deleted} deleted, ${r.failed} failed`); await load(); } catch (e: any) { show(e.message); } finally { setRunning(false); }
          }}>{running ? <Spinner /> : <Icon name="refresh" />} Run cleanup now</button>
        </div>
      </div>

      <div className="card p-5">
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <p className="font-medium">Storage usage</p>
          <p className="tabular-nums text-ink-muted">{formatBytes(s.storage.usedBytes)} of {formatBytes(s.storage.quotaBytes, 0)} ({pct.toFixed(pct < 10 ? 1 : 0)}%)</p>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-stone-100"><div className={`h-full rounded-full transition-[width] duration-700 ${pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.max(0.8, pct)}%` }} /></div>
      </div>

      <div className="card overflow-hidden">
        <p className="border-b border-line px-5 py-3 text-sm font-medium">Recent system errors</p>
        {s.recentErrors.length === 0 ? <p className="px-5 py-8 text-center text-sm text-ink-muted">No errors recorded.</p> : (
          <ul className="divide-y divide-line">
            {s.recentErrors.slice(0, 8).map((e) => (
              <li key={e.id} className="px-5 py-3 text-sm"><span className="badge mr-2 border-line bg-paper text-ink-muted">{e.source}</span>{e.message}<span className="ml-2 text-xs text-ink-muted">{formatShortDate(e.at)}</span></li>
            ))}
          </ul>
        )}
      </div>
      {toast}
    </div>
  );
}

function Files() {
  const [state, setState] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: OwnedFile[]; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow();
  const load = useCallback(() => api<{ items: OwnedFile[]; total: number }>(`/api/admin/files?state=${state}&page=${page}&pageSize=20`).then(setData).catch((e) => setErr(e.message)), [state, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {['all', 'active', 'expired', 'failed', 'uploading'].map((s) => (
          <button key={s} onClick={() => { setState(s); setPage(1); }} className={`badge capitalize transition-colors ${state === s ? 'border-accent bg-accent-soft text-accent-hover' : 'border-line-strong bg-white text-ink-muted hover:text-ink'}`}>{s === 'failed' ? 'deletion failures' : s}</button>
        ))}
      </div>
      {err && <Alert className="mb-3">{err}</Alert>}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-line bg-paper text-xs uppercase tracking-wide text-ink-muted">
            <tr><th className="px-4 py-2.5 font-medium">File</th><th className="px-4 py-2.5 font-medium">Size</th><th className="px-4 py-2.5 font-medium">Uploaded</th><th className="px-4 py-2.5 font-medium">Dl</th><th className="px-4 py-2.5 font-medium">Status</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {!data ? <tr><td colSpan={6} className="px-4 py-10 text-center text-ink-muted"><Spinner /></td></tr> : data.items.length === 0 ? <tr><td colSpan={6} className="px-4 py-10 text-center text-ink-muted">No files.</td></tr> :
              data.items.map((f) => (
                <tr key={f.fileId} className="hover:bg-paper/70">
                  <td className="max-w-[240px] truncate px-4 py-3 font-medium" title={f.name}>{f.name}</td>
                  <td className="px-4 py-3 tabular-nums text-ink-soft">{formatBytes(f.size)}</td>
                  <td className="px-4 py-3 text-ink-soft">{formatShortDate(f.uploadedAt)}</td>
                  <td className="px-4 py-3 tabular-nums text-ink-soft">{f.downloadCount}</td>
                  <td className="px-4 py-3" title={f.deletion.lastError ?? undefined}><StatusBadge f={f} now={now} /></td>
                  <td className="px-4 py-3 text-right">
                    <button className="btn-ghost !p-1.5 hover:!text-danger" aria-label="Delete" disabled={f.deletion.status === 'deleted'} onClick={async () => { if (confirm(`Delete “${f.name}” permanently?`)) { await api(`/api/admin/files/${f.fileId}`, { method: 'DELETE' }).catch((e) => setErr(e.message)); load(); } }}><Icon name="trash" /></button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {data && data.total > 20 && (
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn-secondary !py-1" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <button className="btn-secondary !py-1" disabled={page * 20 >= data.total} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6 py-3">
      <span><span className="block text-sm font-medium">{label}</span>{hint && <span className="text-xs text-ink-muted">{hint}</span>}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${checked ? 'bg-accent' : 'bg-stone-300'}`}>
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </label>
  );
}

function SettingsForm() {
  const [s, setS] = useState<Settings | null>(null);
  const [blocked, setBlocked] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { show, toast } = useToast();
  useEffect(() => { api<Settings>('/api/admin/settings').then((r) => { setS(r); setBlocked(r.blockedExtensions.join(', ')); }).catch((e) => setErr(e.message)); }, []);
  if (!s) return err ? <Alert>{err}</Alert> : <div className="flex h-40 items-center justify-center"><Spinner className="h-5 w-5" /></div>;
  const GB = 1024 ** 3, MB = 1024 ** 2;
  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const body = { ...s, blockedExtensions: blocked.split(/[\s,]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean) };
      setS(await api<Settings>('/api/admin/settings', { method: 'PUT', json: body }));
      show('Settings saved');
    } catch (e: any) { setErr(e.details ? `${e.message}: ${JSON.stringify(e.details)}` : e.message); } finally { setSaving(false); }
  };
  return (
    <div className="card max-w-2xl divide-y divide-line">
      <div className="space-y-1 p-5">
        <Toggle label="Allow anonymous uploads" hint="When off, only signed-in users can upload." checked={s.allowAnonymous} onChange={(v) => setS({ ...s, allowAnonymous: v })} />
        <Toggle label="Allow new registrations" checked={s.allowRegistration} onChange={(v) => setS({ ...s, allowRegistration: v })} />
      </div>
      <div className="grid gap-4 p-5 sm:grid-cols-3">
        <div><label className="label">Max file size (MB)</label><input type="number" min={1} max={3072} className="input" value={Math.round(s.maxFileBytes / MB)} onChange={(e) => setS({ ...s, maxFileBytes: Math.min(3 * GB, Number(e.target.value) * MB) })} /><p className="mt-1 text-xs text-ink-muted">Hard ceiling: 3072 MB.</p></div>
        <div><label className="label">Storage quota (GB)</label><input type="number" min={1} className="input" value={Math.round(s.storageQuotaBytes / GB)} onChange={(e) => setS({ ...s, storageQuotaBytes: Number(e.target.value) * GB })} /></div>
        <div><label className="label">Uploads / client / hour</label><input type="number" min={1} className="input" value={s.uploadsPerHour} onChange={(e) => setS({ ...s, uploadsPerHour: Number(e.target.value) })} /></div>
      </div>
      <div className="p-5">
        <p className="label">Available retention periods</p>
        <div className="flex flex-wrap gap-2">
          {RETENTION.map(([k, l]) => {
            const on = s.allowedRetentionKeys.includes(k);
            return <button key={k} type="button" aria-pressed={on} onClick={() => setS({ ...s, allowedRetentionKeys: on ? s.allowedRetentionKeys.filter((x) => x !== k) : [...s.allowedRetentionKeys, k] })} className={`badge transition-colors ${on ? 'border-accent bg-accent-soft text-accent-hover' : 'border-line-strong text-ink-muted'}`}>{l}</button>;
          })}
        </div>
        <p className="mt-2 text-xs text-ink-muted">The maximum retention is fixed at 30 days and cannot be raised.</p>
      </div>
      <div className="p-5">
        <label className="label" htmlFor="blk">Blocked extensions</label>
        <input id="blk" className="input" placeholder="scr, pif, com" value={blocked} onChange={(e) => setBlocked(e.target.value)} />
        <p className="mt-1 text-xs text-ink-muted">Comma separated. Everything else is accepted.</p>
      </div>
      <div className="flex items-center justify-between gap-4 p-5">
        {err ? <p className="text-sm text-danger">{err}</p> : <span />}
        <button className="btn-primary" onClick={save} disabled={saving || s.allowedRetentionKeys.length === 0}>{saving && <Spinner />}Save changes</button>
      </div>
      {toast}
    </div>
  );
}

function Activity() {
  const [audit, setAudit] = useState<any[] | null>(null);
  const [errors, setErrors] = useState<any[] | null>(null);
  useEffect(() => {
    api<{ items: any[] }>('/api/admin/audit').then((r) => setAudit(r.items)).catch(() => setAudit([]));
    api<{ items: any[] }>('/api/admin/errors').then((r) => setErrors(r.items)).catch(() => setErrors([]));
  }, []);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="card overflow-hidden">
        <p className="border-b border-line px-5 py-3 text-sm font-medium">Admin audit log</p>
        {!audit ? <div className="p-8 text-center"><Spinner /></div> : audit.length === 0 ? <p className="px-5 py-8 text-center text-sm text-ink-muted">No actions yet.</p> :
          <ul className="max-h-[480px] divide-y divide-line overflow-auto">{audit.map((a) => (
            <li key={a._id} className="px-5 py-3 text-sm"><p><span className="font-medium">{a.action}</span> <span className="text-ink-muted">{a.target}</span></p><p className="text-xs text-ink-muted">{a.actorEmail} · {formatShortDate(a.at)}</p></li>))}</ul>}
      </section>
      <section className="card overflow-hidden">
        <p className="border-b border-line px-5 py-3 text-sm font-medium">System errors</p>
        {!errors ? <div className="p-8 text-center"><Spinner /></div> : errors.length === 0 ? <p className="px-5 py-8 text-center text-sm text-ink-muted">No errors recorded.</p> :
          <ul className="max-h-[480px] divide-y divide-line overflow-auto">{errors.map((e) => (
            <li key={e.id} className="px-5 py-3 text-sm"><p><span className="badge mr-2 border-line bg-paper text-ink-muted">{e.source}</span>{e.message}</p><p className="mt-1 text-xs text-ink-muted">{formatShortDate(e.at)}{e.context?.fileId ? ` · file ${String(e.context.fileId).slice(0, 8)}…` : ''}</p></li>))}</ul>}
      </section>
    </div>
  );
}
