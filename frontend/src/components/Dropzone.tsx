import { useRef, useState } from 'react';
import { Icon } from './ui';
import { formatBytes } from '../lib/format';

export default function Dropzone({ maxBytes, onFile, disabled }: { maxBytes: number; onFile: (f: File) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const pick = (files: FileList | null) => {
    if (files && files[0]) onFile(files[0]);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload a file: drop it here or press Enter to browse"
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
      onClick={() => !disabled && input.current?.click()}
      onDragEnter={(e) => { e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setOver(false); } }}
      onDrop={(e) => { e.preventDefault(); depth.current = 0; setOver(false); if (!disabled) pick(e.dataTransfer.files); }}
      className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-[1.5px] border-dashed px-6 py-14 text-center transition-all duration-300 sm:py-16
        ${over ? 'scale-[1.012] border-accent bg-accent-soft' : 'border-line-strong bg-white hover:border-accent/60 hover:bg-accent-soft/40'}`}
    >
      <div className={`mb-5 flex h-14 w-14 items-center justify-center rounded-full border transition-all duration-300 ${over ? 'border-accent bg-white text-accent' : 'border-line bg-paper text-ink-muted group-hover:text-accent'}`}>
        <Icon name="upload" className={`h-6 w-6 transition-transform duration-300 ${over ? '-translate-y-1' : 'group-hover:-translate-y-0.5'}`} />
      </div>
      <p className="text-base font-medium">{over ? 'Release to add your file' : 'Drag a file here'}</p>
      <p className="mt-1 text-sm text-ink-muted">or</p>
      <span className="btn-primary mt-3 pointer-events-none">Browse files</span>
      <p className="mt-5 text-xs text-ink-muted">
        Up to <span className="font-medium text-ink-soft">{formatBytes(maxBytes, 0)}</span> per file · any common format
      </p>
      <input ref={input} type="file" className="hidden" onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
