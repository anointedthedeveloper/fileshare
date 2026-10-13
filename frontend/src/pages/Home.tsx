import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Dropzone from '../components/Dropzone';
import UploadProgress from '../components/UploadProgress';
import UploadResult from '../components/UploadResult';
import { Alert, ExtBadge, Icon } from '../components/ui';
import { useAuth } from '../context/Auth';
import { ChunkedUploader, Cancelled, type Progress, type UploadResult as Result } from '../lib/upload';
import { ApiError } from '../lib/api';
import { formatBytes } from '../lib/format';

type Stage = 'idle' | 'staged' | 'uploading' | 'done';

const STEPS = [
  { n: '1', t: 'Choose a file', d: 'Drop in anything up to 3 GB. Large files are sent in resumable chunks.' },
  { n: '2', t: 'Pick how long it lives', d: 'From one hour to 30 days. Then it is permanently deleted.' },
  { n: '3', t: 'Share the link', d: 'Anyone with the link can download. No account needed.' },
];

function friendly(e: unknown): string {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      file_too_large: 'This file is larger than the maximum allowed size.',
      unsupported_type: 'This file type is not accepted.',
      signature_mismatch: 'The file contents do not match its extension, so it was rejected.',
      storage_full: 'The service is temporarily out of storage space. Please try again later.',
      upload_rate_limited: 'You have reached the hourly upload limit. Please try again later.',
      login_required: 'Sign in to upload files.',
      malware_detected: 'The file was rejected by the malware scanner.',
      network: 'Connection lost. Check your network and try the upload again — it will resume.',
    };
    return map[e.code] ?? e.message;
  }
  return 'Something went wrong. Please try again.';
}

export default function Home() {
  const { config, user } = useAuth();
  const [stage, setStage] = useState<Stage>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [retention, setRetention] = useState('1d');
  const [password, setPassword] = useState('');
  const [limit, setLimit] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const uploader = useRef<ChunkedUploader | null>(null);

  const max = config?.maxFileBytes ?? 3 * 1024 ** 3;
  const options = config?.retentionOptions ?? [];
  const blocked = config?.allowAnonymous === false && !user;

  const choose = (f: File) => {
    setError(null);
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (f.size === 0) return setError('This file is empty. Choose a file with content.');
    if (f.size > max) return setError(`${f.name} is ${formatBytes(f.size)}. The maximum is ${formatBytes(max, 0)} per file.`);
    if (config?.blockedExtensions.includes(ext)) return setError(`Files of type .${ext} are not accepted.`);
    setFile(f);
    if (options.length && !options.some((o) => o.key === retention)) setRetention(options[options.length - 1].key);
    setStage('staged');
  };

  const start = async () => {
    if (!file) return;
    setError(null);
    setStage('uploading');
    setProgress(null);
    const u = new ChunkedUploader(file, {
      retention,
      password: password || undefined,
      downloadLimit: limit ? Number(limit) : undefined,
      onProgress: setProgress,
    });
    uploader.current = u;
    try {
      const r = await u.start();
      setResult(r);
      setStage('done');
    } catch (e) {
      if (e instanceof Cancelled) return;
      setError(friendly(e));
      setStage('staged');
    }
  };

  const cancel = async () => {
    await uploader.current?.cancel();
    setStage('staged');
    setProgress(null);
  };

  const reset = () => {
    setStage('idle');
    setFile(null);
    setResult(null);
    setPassword('');
    setLimit('');
    setError(null);
    setProgress(null);
  };

  return (
    <div className="relative">
      <div className="dots pointer-events-none absolute inset-x-0 top-0 -z-0 h-[420px]" />
      <div className="relative mx-auto max-w-2xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20">
        <div className="stagger mb-9 text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Send large files, simply.</h1>
          <p className="mx-auto mt-3 max-w-md text-balance text-ink-muted">
            Upload up to 3&nbsp;GB, share a link, and it disappears on schedule. No account required.
          </p>
        </div>

        {blocked && (
          <Alert tone="info" className="mb-5">
            Uploads are limited to signed-in users right now. <Link to="/login" className="font-medium underline">Sign in</Link> to continue.
          </Alert>
        )}
        {error && <Alert className="mb-5">{error}</Alert>}

        {stage === 'idle' && <div className="animate-fade-up"><Dropzone maxBytes={max} onFile={choose} disabled={blocked} /></div>}

        {stage === 'staged' && file && (
          <div className="card animate-fade-up p-6">
            <div className="flex items-center gap-4">
              <ExtBadge ext={file.name.includes('.') ? file.name.split('.').pop()! : ''} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{file.name}</p>
                <p className="text-sm text-ink-muted">{formatBytes(file.size)}</p>
              </div>
              <button className="btn-ghost !p-2" aria-label="Remove file" onClick={reset}><Icon name="x" /></button>
            </div>

            <div className="mt-6">
              <label className="label" htmlFor="ret">Keep available for</label>
              <div id="ret" role="radiogroup" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {options.map((o) => (
                  <button
                    key={o.key}
                    role="radio"
                    aria-checked={retention === o.key}
                    onClick={() => setRetention(o.key)}
                    className={`rounded-lg border px-3 py-2 text-sm transition-all duration-150 ${retention === o.key ? 'border-accent bg-accent-soft font-medium text-accent-hover' : 'border-line-strong text-ink-soft hover:border-ink-faint'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <button className="mt-5 flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink" onClick={() => setMore((v) => !v)} aria-expanded={more}>
              <Icon name="chevron" className={`h-4 w-4 transition-transform duration-200 ${more ? 'rotate-180' : ''}`} /> Link options
            </button>
            <div className={`grid transition-all duration-300 ease-out ${more ? 'mt-4 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="pw">Password (optional)</label>
                    <input id="pw" type="password" autoComplete="new-password" className="input" placeholder="Require a password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} maxLength={128} />
                  </div>
                  <div>
                    <label className="label" htmlFor="dl">Download limit (optional)</label>
                    <input id="dl" type="number" min={1} max={1000000} className="input" placeholder="Unlimited" value={limit} onChange={(e) => setLimit(e.target.value)} />
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between gap-3">
              <p className="text-xs text-ink-muted">The file is deleted automatically when the time is up.</p>
              <button className="btn-primary" onClick={start} disabled={blocked || (!!password && password.length < 4)}>
                <Icon name="upload" /> Upload
              </button>
            </div>
          </div>
        )}

        {stage === 'uploading' && file && progress && <UploadProgress file={file} p={progress} onCancel={cancel} />}
        {stage === 'uploading' && !progress && <div className="card h-40 animate-pulse" />}

        {stage === 'done' && result && <UploadResult result={result} onAnother={reset} />}

        <section className="mt-16">
          <h2 className="mb-5 text-center text-xs font-medium uppercase tracking-wider text-ink-muted">How it works</h2>
          <ol className="stagger grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-xl border border-line bg-white/70 p-4 transition-colors duration-200 hover:bg-white">
                <span className="mb-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{s.n}</span>
                <p className="text-sm font-medium">{s.t}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
