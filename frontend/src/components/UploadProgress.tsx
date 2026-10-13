import type { Progress } from '../lib/upload';
import { formatBytes, formatDuration, formatSpeed } from '../lib/format';
import { Spinner } from './ui';

export default function UploadProgress({ file, p, onCancel }: { file: File; p: Progress; onCancel: () => void }) {
  const finalizing = p.phase === 'finalizing';
  const label = finalizing ? 'Verifying file…' : p.retrying ? 'Connection lost — retrying…' : p.resumed && p.loaded > 0 && p.percent < 100 ? 'Resuming upload' : 'Uploading';
  return (
    <div className="card animate-fade-up p-6" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-medium">{file.name}</p>
          <p className="mt-0.5 flex items-center gap-2 text-sm text-ink-muted">
            {(finalizing || p.retrying) && <Spinner className="h-3.5 w-3.5" />}
            {label}
          </p>
        </div>
        <p className="text-2xl font-semibold tabular-nums tracking-tight">{Math.floor(p.percent)}<span className="text-base text-ink-muted">%</span></p>
      </div>

      <div className="mt-5 h-2 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(p.percent)}>
        <div className="relative h-full overflow-hidden rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.max(1.5, p.percent)}%` }}>
          {!finalizing && p.percent < 100 && <span className="absolute inset-y-0 w-1/3 animate-sheen bg-white/25" />}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-y-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-ink-muted">Uploaded</dt><dd className="font-medium tabular-nums">{formatBytes(p.loaded)}</dd></div>
        <div><dt className="text-xs text-ink-muted">Total</dt><dd className="font-medium tabular-nums">{formatBytes(p.total)}</dd></div>
        <div><dt className="text-xs text-ink-muted">Speed</dt><dd className="font-medium tabular-nums">{formatSpeed(p.speed)}</dd></div>
        <div><dt className="text-xs text-ink-muted">Time left</dt><dd className="font-medium tabular-nums">{finalizing ? '—' : formatDuration(p.eta)}</dd></div>
      </dl>

      <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
        <p className="text-xs text-ink-muted">Keep this tab open. If the connection drops, the upload continues where it stopped.</p>
        <button className="btn-secondary !py-1.5" onClick={onCancel} disabled={finalizing}>Cancel</button>
      </div>
    </div>
  );
}
