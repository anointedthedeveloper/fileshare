import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, apiUrl, ApiError, type FileInfo } from '../lib/api';
import { Alert, ExtBadge, Icon, Spinner, useNow } from '../components/ui';
import { formatBytes, formatDateTime, remaining } from '../lib/format';

type State = { kind: 'loading' } | { kind: 'ok'; file: FileInfo } | { kind: 'gone'; code: string } | { kind: 'missing' } | { kind: 'error'; msg: string };

export default function Download() {
  const { id = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const now = useNow(15_000);

  useEffect(() => {
    api<FileInfo>(`/api/files/${id}`)
      .then((file) => setState({ kind: 'ok', file }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 410) setState({ kind: 'gone', code: e.code });
        else if (e instanceof ApiError && e.status === 404) setState({ kind: 'missing' });
        else setState({ kind: 'error', msg: e.message });
      });
  }, [id]);

  const trigger = (url: string) => {
    // Navigating to an attachment response downloads natively (streamed by the browser, resumable).
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStarted(true);
  };

  const download = async () => {
    if (state.kind !== 'ok') return;
    const f = state.file;
    setErr(null);
    if (!f.passwordProtected) return trigger(apiUrl(`/api/files/${f.fileId}/download`));
    setBusy(true);
    try {
      const { token } = await api<{ token: string }>(`/api/files/${f.fileId}/unlock`, { method: 'POST', json: { password } });
      trigger(apiUrl(`/api/files/${f.fileId}/download?token=${encodeURIComponent(token)}`));
    } catch (e) {
      setErr(e instanceof ApiError ? (e.status === 429 ? 'Too many attempts. Please wait a few minutes.' : e.message) : 'Could not unlock the file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20">
      {state.kind === 'loading' && <div className="card flex h-56 items-center justify-center text-ink-muted"><Spinner className="h-5 w-5" /></div>}

      {state.kind === 'ok' && (
        <div className="card animate-fade-up overflow-hidden">
          <div className="p-6 sm:p-8">
            <div className="flex items-center gap-4">
              <ExtBadge ext={state.file.extension} />
              <div className="min-w-0">
                <h1 className="break-words text-lg font-semibold leading-snug">{state.file.name}</h1>
                <p className="text-sm text-ink-muted">{formatBytes(state.file.size)}</p>
              </div>
            </div>

            <dl className="mt-6 grid gap-4 rounded-lg border border-line bg-paper p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-muted">Available for</dt>
                <dd className="mt-0.5 flex items-center gap-1.5 font-medium tabular-nums"><Icon name="clock" className="h-4 w-4 text-accent" />{remaining(state.file.expiresAt, now)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">Expires</dt>
                <dd className="mt-0.5 font-medium">{formatDateTime(state.file.expiresAt)}</dd>
              </div>
              {state.file.downloadsRemaining !== null && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-ink-muted">Downloads left</dt>
                  <dd className="mt-0.5 font-medium">{state.file.downloadsRemaining}</dd>
                </div>
              )}
            </dl>

            {state.file.executableWarning && (
              <Alert tone="warn" className="mt-5">
                <p className="font-medium">Only open this if you trust the sender.</p>
                <p className="mt-0.5 opacity-90">Programs and Android apps (.{state.file.extension}) can harm your device. This service does not run or vet them.</p>
              </Alert>
            )}

            {state.file.passwordProtected && (
              <form className="mt-5" onSubmit={(e) => { e.preventDefault(); download(); }}>
                <label className="label" htmlFor="pw"><Icon name="lock" className="-mt-0.5 mr-1 inline h-3.5 w-3.5" />Password</label>
                <input id="pw" type="password" autoFocus autoComplete="off" className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter the password you were given" />
              </form>
            )}
            {err && <Alert className="mt-4">{err}</Alert>}

            <button className="btn-primary mt-6 w-full !py-3 text-[15px]" onClick={download} disabled={busy || (state.file.passwordProtected && !password)}>
              {busy ? <Spinner /> : <Icon name="download" className="h-[18px] w-[18px]" />}
              {state.file.passwordProtected ? 'Unlock and download' : 'Download'}
            </button>
            {started && <p className="mt-3 animate-fade-in text-center text-sm text-ink-muted">Your download should start shortly. Check your browser's downloads.</p>}
          </div>
          {state.file.checksumSha256 && (
            <div className="border-t border-line bg-paper px-6 py-3 sm:px-8">
              <p className="text-[11px] uppercase tracking-wide text-ink-muted">SHA-256</p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-ink-soft">{state.file.checksumSha256}</p>
            </div>
          )}
        </div>
      )}

      {state.kind === 'gone' && (
        <Notice title={state.code === 'file_deleted' ? 'This file was deleted' : 'This file has expired'}>
          Shared files are only kept for a limited time. Ask the sender to upload it again and share a new link.
        </Notice>
      )}
      {state.kind === 'missing' && <Notice title="Link not found">This link doesn't exist. Check that it was copied completely.</Notice>}
      {state.kind === 'error' && <Notice title="Couldn't load this page">{state.msg}</Notice>}
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card animate-fade-up px-8 py-14 text-center">
      <div className="mx-auto mb-5 flex h-12 w-12 animate-breathe items-center justify-center rounded-full border border-line bg-paper text-ink-muted"><Icon name="clock" className="h-6 w-6" /></div>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">{children}</p>
      <a href="/" className="btn-secondary mt-6">Send a file</a>
    </div>
  );
}
