import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type OwnedFile } from '../lib/api';
import { Alert, copyText, ExtBadge, Icon, Spinner, useNow, useToast } from '../components/ui';
import { formatBytes, formatShortDate, remaining, shareUrl } from '../lib/format';

export function StatusBadge({ f, now }: { f: OwnedFile; now: number }) {
  const d = f.deletion.status;
  let tone = 'border-ok/30 bg-ok-soft text-ok';
  let text = 'Active';
  if (f.uploadStatus === 'uploading') [tone, text] = ['border-line bg-paper text-ink-muted', 'Uploading'];
  else if (d === 'failed') [tone, text] = ['border-danger-line bg-danger-soft text-danger', 'Deletion failed · retrying'];
  else if (d === 'pending' || d === 'in_progress') [tone, text] = ['border-warn-line bg-warn-soft text-warn', 'Deleting'];
  else if (d === 'deleted' || f.uploadStatus === 'deleted') [tone, text] = ['border-line bg-paper text-ink-muted', 'Deleted'];
  else if (new Date(f.expiresAt).getTime() <= now) [tone, text] = ['border-line bg-paper text-ink-muted', 'Expired'];
  else if (new Date(f.expiresAt).getTime() - now < 3600_000) [tone, text] = ['border-warn-line bg-warn-soft text-warn', 'Expiring soon'];
  return <span className={`badge ${tone}`}>{text}</span>;
}

export default function MyFiles() {
  const [items, setItems] = useState<OwnedFile[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { show, toast } = useToast();
  const now = useNow();
  const size = 15;

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: OwnedFile[]; total: number }>(`/api/user/files?page=${page}&pageSize=${size}`);
      setItems(r.items);
      setTotal(r.total);
    } catch (e: any) {
      setErr(e.message);
    }
  }, [page]);
  useEffect(() => { load(); }, [load]);

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/files/${id}`, { method: 'DELETE' });
      show('File deleted');
      setConfirm(null);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-10 sm:px-6">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">My files</h1>
          <p className="text-sm text-ink-muted">Files you uploaded while signed in.</p>
        </div>
        <Link to="/" className="btn-primary"><Icon name="plus" /> New upload</Link>
      </div>
      {err && <Alert className="mb-4">{err}</Alert>}

      {items === null ? (
        <div className="card flex h-40 items-center justify-center text-ink-muted"><Spinner className="h-5 w-5" /></div>
      ) : items.length === 0 ? (
        <div className="card animate-fade-up px-6 py-16 text-center">
          <p className="font-medium">Nothing here yet</p>
          <p className="mt-1 text-sm text-ink-muted">Files you upload while signed in will appear here.</p>
        </div>
      ) : (
        <div className="card animate-fade-up overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,2.4fr)_1fr_1fr_.7fr_1.2fr_auto] gap-4 border-b border-line bg-paper px-5 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-muted md:grid">
            <span>File</span><span>Uploaded</span><span>Expires</span><span>Downloads</span><span>Status</span><span className="w-[148px]" />
          </div>
          <ul className="divide-y divide-line">
            {items.map((f) => {
              const live = f.availability === 'ready';
              return (
                <li key={f.fileId} className="grid items-center gap-x-4 gap-y-2 px-5 py-4 transition-colors duration-150 hover:bg-paper/70 md:grid-cols-[minmax(0,2.4fr)_1fr_1fr_.7fr_1.2fr_auto]">
                  <div className="flex min-w-0 items-center gap-3">
                    <ExtBadge ext={f.extension} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{f.name}</p>
                      <p className="text-xs text-ink-muted">{formatBytes(f.size)}{f.passwordProtected && ' · password'}</p>
                    </div>
                  </div>
                  <p className="text-sm text-ink-soft"><span className="md:hidden text-ink-muted">Uploaded </span>{formatShortDate(f.uploadedAt)}</p>
                  <p className="text-sm text-ink-soft tabular-nums">{live ? remaining(f.expiresAt, now) : '—'}</p>
                  <p className="text-sm tabular-nums text-ink-soft">{f.downloadCount}{f.downloadLimit ? ` / ${f.downloadLimit}` : ''}</p>
                  <div title={f.deletion.lastError ?? undefined}><StatusBadge f={f} now={now} /></div>
                  <div className="flex w-[148px] justify-end gap-1.5">
                    {confirm === f.fileId ? (
                      <>
                        <button className="btn-danger !px-3 !py-1.5" disabled={busy === f.fileId} onClick={() => remove(f.fileId)}>{busy === f.fileId ? <Spinner /> : 'Delete'}</button>
                        <button className="btn-ghost !px-2.5 !py-1.5" onClick={() => setConfirm(null)}>Keep</button>
                      </>
                    ) : (
                      <>
                        <button className="btn-secondary !px-2.5 !py-1.5" disabled={!live} aria-label="Copy link" title="Copy link" onClick={async () => { if (await copyText(shareUrl(f.fileId))) show('Link copied'); }}><Icon name="copy" /></button>
                        <button className="btn-secondary !px-2.5 !py-1.5 hover:!text-danger" disabled={f.deletion.status === 'deleted'} aria-label="Delete file" title="Delete" onClick={() => setConfirm(f.fileId)}><Icon name="trash" /></button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {total > size && (
            <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm text-ink-muted">
              <span>{(page - 1) * size + 1}–{Math.min(page * size, total)} of {total}</span>
              <div className="flex gap-2">
                <button className="btn-secondary !py-1" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <button className="btn-secondary !py-1" disabled={page * size >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          )}
        </div>
      )}
      {toast}
    </div>
  );
}
