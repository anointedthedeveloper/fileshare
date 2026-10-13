import { useRef, useState } from 'react';
import { Alert, copyText, ExtBadge, Icon, Logo, Spinner, useNow } from './components/ui';
import { formatBytes, formatDateTime, formatDuration, formatSpeed, remaining, shareUrl } from './lib/format';
import { MAX_BYTES, MAX_MB, RETENTIONS, uploadFile, UploadAborted, type Progress, type Result } from './lib/upload';

type Stage = 'idle' | 'staged' | 'uploading' | 'done';

export default function App() {
  const [stage, setStage] = useState<Stage>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [retention, setRetention] = useState('1d');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [over, setOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const now = useNow();

  const choose = (f?: File) => {
    if (!f) return;
    setError(null);
    if (f.size === 0) return setError('That file is empty.');
    if (f.size > MAX_BYTES) return setError(`${f.name} is ${formatBytes(f.size)}. The limit is ${MAX_MB} MB.`);
    setFile(f);
    setStage('staged');
  };

  const start = async () => {
    if (!file) return;
    setError(null);
    setStage('uploading');
    setProgress(null);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      setResult(await uploadFile(file, retention, setProgress, ctl.signal));
      setStage('done');
    } catch (e) {
      if (e instanceof UploadAborted) return;
      setError(e instanceof Error ? e.message : 'Upload failed.');
      setStage('staged');
    }
  };

  const reset = () => {
    abort.current?.abort();
    setStage('idle');
    setFile(null);
    setResult(null);
    setProgress(null);
    setError(null);
    setCopied(false);
  };

  const link = result ? shareUrl(result.code) : '';
  const copy = async () => {
    if (await copyText(link)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-paper/85">
        <div className="mx-auto flex h-14 max-w-2xl items-center px-4 sm:px-6">
          <a href="/" className="group flex items-center gap-2.5">
            <Logo className="h-7 w-7 transition-transform duration-300 group-hover:-rotate-6" />
            <span className="text-[15px] font-semibold tracking-tight">Parcel</span>
          </a>
        </div>
      </header>

      <main className="relative flex-1">
        <div className="dots pointer-events-none absolute inset-x-0 top-0 h-[380px]" />
        <div className="relative mx-auto max-w-xl px-4 pb-20 pt-12 sm:pt-16">
          <div className="stagger mb-8 text-center">
            <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Send a file, get a short link.</h1>
            <p className="mx-auto mt-3 max-w-sm text-balance text-ink-muted">Up to {MAX_MB / 1024} GB. Deleted automatically after at most 3 days.</p>
          </div>

          {error && <Alert className="mb-5">{error}</Alert>}

          {stage === 'idle' && (
            <div
              role="button"
              tabIndex={0}
              aria-label="Choose a file"
              onClick={() => input.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
              onDragEnter={(e) => { e.preventDefault(); depth.current++; setOver(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setOver(false); } }}
              onDrop={(e) => { e.preventDefault(); depth.current = 0; setOver(false); choose(e.dataTransfer.files[0]); }}
              className={`group animate-fade-up flex cursor-pointer flex-col items-center rounded-xl border-[1.5px] border-dashed px-6 py-14 text-center transition-all duration-300 sm:py-16 ${over ? 'scale-[1.012] border-accent bg-accent-soft' : 'border-line-strong bg-white hover:border-accent/60 hover:bg-accent-soft/40'}`}
            >
              <div className={`mb-5 flex h-14 w-14 items-center justify-center rounded-full border transition-all duration-300 ${over ? 'border-accent bg-white text-accent' : 'border-line bg-paper text-ink-muted group-hover:text-accent'}`}>
                <Icon name="upload" className={`h-6 w-6 transition-transform duration-300 ${over ? '-translate-y-1' : 'group-hover:-translate-y-0.5'}`} />
              </div>
              <p className="text-base font-medium">{over ? 'Release to add your file' : 'Drop a file here'}</p>
              <span className="btn-primary pointer-events-none mt-4">Browse files</span>
              <p className="mt-5 text-xs text-ink-muted">Max {formatBytes(MAX_BYTES, 0)} per file</p>
              <input ref={input} type="file" className="hidden" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          )}

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
              <p className="label mt-6">Keep available for</p>
              <div role="radiogroup" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {RETENTIONS.map((o) => (
                  <button key={o.key} role="radio" aria-checked={retention === o.key} onClick={() => setRetention(o.key)}
                    className={`rounded-lg border px-3 py-2 text-sm transition-all duration-150 ${retention === o.key ? 'border-accent bg-accent-soft font-medium text-accent-hover' : 'border-line-strong text-ink-soft hover:border-ink-faint'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
              <button className="btn-primary mt-6 w-full !py-3" onClick={start}><Icon name="upload" /> Upload</button>
            </div>
          )}

          {stage === 'uploading' && file && (
            <div className="card animate-fade-up p-6" aria-live="polite">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{file.name}</p>
                  <p className="mt-0.5 flex items-center gap-2 text-sm text-ink-muted">
                    {progress?.finishing && <Spinner className="h-3.5 w-3.5" />}
                    {progress?.finishing ? 'Creating your link…' : 'Uploading'}
                  </p>
                </div>
                <p className="text-2xl font-semibold tabular-nums tracking-tight">{Math.floor(progress?.percent ?? 0)}<span className="text-base text-ink-muted">%</span></p>
              </div>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuenow={Math.floor(progress?.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}>
                <div className="relative h-full overflow-hidden rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.max(1.5, progress?.percent ?? 0)}%` }}>
                  {!progress?.finishing && <span className="absolute inset-y-0 w-1/3 animate-sheen bg-white/25" />}
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-y-3 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-ink-muted">Uploaded</dt><dd className="font-medium tabular-nums">{formatBytes(progress?.loaded ?? 0)}</dd></div>
                <div><dt className="text-xs text-ink-muted">Total</dt><dd className="font-medium tabular-nums">{formatBytes(file.size)}</dd></div>
                <div><dt className="text-xs text-ink-muted">Speed</dt><dd className="font-medium tabular-nums">{formatSpeed(progress?.speed ?? 0)}</dd></div>
                <div><dt className="text-xs text-ink-muted">Time left</dt><dd className="font-medium tabular-nums">{progress?.finishing ? '—' : formatDuration(progress?.eta ?? Infinity)}</dd></div>
              </dl>
              <div className="mt-5 flex justify-end border-t border-line pt-4">
                <button className="btn-secondary !py-1.5" disabled={progress?.finishing} onClick={reset}>Cancel</button>
              </div>
            </div>
          )}

          {stage === 'done' && result && (
            <div className="card animate-fade-up overflow-hidden">
              <div className="flex items-center gap-3 border-b border-line bg-ok-soft px-6 py-4">
                <svg className="h-7 w-7 animate-pop-in" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="13" stroke="#2f7d4f" strokeWidth="1.6" /><path d="M8.5 14.5l3.8 3.8 7.2-7.6" stroke="#2f7d4f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="48" className="animate-draw" /></svg>
                <p className="font-medium text-ok">Ready to share</p>
              </div>
              <div className="space-y-5 p-6">
                <div>
                  <p className="truncate font-medium">{result.name}</p>
                  <p className="text-sm text-ink-muted">{formatBytes(result.size)}</p>
                </div>
                <div className="flex gap-2">
                  <input readOnly value={link} aria-label="Share link" className="input font-mono text-[15px]" onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn-primary min-w-[96px]" onClick={copy}>{copied ? 'Copied' : <><Icon name="copy" /> Copy</>}</button>
                </div>
                <p className="text-sm text-ink-muted">
                  Expires {formatDateTime(result.expiresAt)} · <span className="tabular-nums">{remaining(result.expiresAt, now)}</span> left
                </p>
                <div className="border-t border-line pt-5">
                  <button className="btn-secondary" onClick={reset}><Icon name="plus" /> Upload another file</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
