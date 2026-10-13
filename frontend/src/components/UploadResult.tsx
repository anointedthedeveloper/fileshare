import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { UploadResult as Result } from '../lib/upload';
import { copyText, Icon, useNow, useToast } from './ui';
import { api } from '../lib/api';
import { formatBytes, formatDateTime, remaining, shareUrl } from '../lib/format';

export default function UploadResult({ result, onAnother }: { result: Result; onAnother: () => void }) {
  const { file } = result;
  const url = shareUrl(file.fileId);
  const now = useNow();
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<'idle' | 'confirm' | 'busy' | 'gone'>('idle');
  const { show, toast } = useToast();

  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 176, color: { dark: '#1c1917', light: '#ffffff' } }).then(setQr).catch(() => undefined);
  }, [url]);

  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      show('Link copied to clipboard');
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div className="card animate-fade-up overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line bg-ok-soft px-6 py-4">
        <svg className="h-7 w-7 shrink-0 animate-pop-in" viewBox="0 0 28 28" fill="none">
          <circle cx="14" cy="14" r="13" stroke="#2f7d4f" strokeWidth="1.6" />
          <path d="M8.5 14.5l3.8 3.8 7.2-7.6" stroke="#2f7d4f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="48" className="animate-draw" />
        </svg>
        <div>
          <p className="font-medium text-ok">Your file is ready to share</p>
          <p className="text-xs text-ink-muted">Uploaded, verified and stored.</p>
        </div>
      </div>

      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-sm text-ink-muted">{formatBytes(file.size)}{file.passwordProtected && <> · <Icon name="lock" className="-mt-0.5 inline h-3.5 w-3.5" /> password protected</>}</p>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="share">Share link</label>
          <div className="flex gap-2">
            <input id="share" readOnly value={url} className="input font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} />
            <button className="btn-primary min-w-[92px]" onClick={copy}>
              <Icon name={copied ? 'x' : 'copy'} className={`h-4 w-4 ${copied ? 'hidden' : ''}`} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="grid gap-3 rounded-lg border border-line bg-paper p-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs text-ink-muted">Expires</p>
            <p className="font-medium">{formatDateTime(file.expiresAt)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-muted">Time remaining</p>
            <p className="font-medium tabular-nums">{remaining(file.expiresAt, now)}</p>
          </div>
        </div>

        {showQr && qr && (
          <div className="flex animate-pop-in items-center gap-4 rounded-lg border border-line p-4">
            <img src={qr} alt="QR code for the share link" className="h-28 w-28 rounded" />
            <p className="text-sm text-ink-muted">Scan to open the download page on another device.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <button className="btn-ghost !px-3" onClick={() => setShowQr((v) => !v)}>
            {showQr ? 'Hide QR code' : 'Show QR code'}
          </button>
          {result.manageToken && removing !== 'gone' && (
            removing === 'confirm' ? (
              <span className="flex items-center gap-2">
                <button className="btn-danger !py-1.5" onClick={async () => { setRemoving('busy'); try { await api(`/api/files/${file.fileId}`, { method: 'DELETE', manageToken: result.manageToken }); setRemoving('gone'); show('File deleted'); } catch { setRemoving('idle'); show('Could not delete the file'); } }}>Delete now</button>
                <button className="btn-ghost !py-1.5" onClick={() => setRemoving('idle')}>Keep</button>
              </span>
            ) : (
              <button className="btn-ghost !px-3 hover:!text-danger" disabled={removing === 'busy'} onClick={() => setRemoving('confirm')}><Icon name="trash" /> Delete file</button>
            )
          )}
          {removing === 'gone' && <span className="text-sm text-ink-muted">This file was deleted.</span>}
          <button className="btn-secondary" onClick={onAnother}>
            <Icon name="plus" /> Upload another file
          </button>
        </div>
      </div>
      {toast}
    </div>
  );
}
