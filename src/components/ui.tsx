import { useEffect, useState, type ReactNode } from 'react';

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#2f6f73" />
      <path d="M9 12.5 16 9l7 3.5v7L16 23l-7-3.5zM9 12.5 16 16l7-3.5M16 16v7" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

const paths: Record<string, string> = {
  upload: 'M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  download: 'M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5M4 18v0a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2',
  file: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5',
  copy: 'M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5 15V6a1 1 0 0 1 1-1h9',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  trash: 'M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
  warn: 'M12 9v4m0 4h.01M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z',
  x: 'M6 6l12 12M18 6 6 18',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
  shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  chevron: 'M6 9l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
};
export function Icon({ name, className = 'h-4 w-4' }: { name: keyof typeof paths | string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name]} />
    </svg>
  );
}

export function Alert({ tone = 'danger', children, className = '' }: { tone?: 'danger' | 'warn' | 'info'; children: ReactNode; className?: string }) {
  const t = {
    danger: 'border-danger-line bg-danger-soft text-danger',
    warn: 'border-warn-line bg-warn-soft text-warn',
    info: 'border-accent-ring bg-accent-soft text-accent-hover',
  }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'note'} className={`flex animate-fade-in gap-2.5 rounded-lg border px-3.5 py-3 text-sm ${t} ${className}`}>
      <Icon name={tone === 'info' ? 'shield' : 'warn'} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Subtle ephemeral confirmation (copy link etc.). */
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; id: number } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2200);
    return () => clearTimeout(t);
  }, [msg]);
  const toast = msg && (
    <div key={msg.id} role="status" className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="animate-toast rounded-lg bg-ink px-4 py-2.5 text-sm text-white shadow-pop">{msg.text}</div>
    </div>
  );
  return { show: (text: string) => setMsg({ text, id: Date.now() }), toast };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function ExtBadge({ ext }: { ext: string }) {
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-line bg-paper text-[11px] font-semibold uppercase tracking-wide text-accent">
      {(ext || 'file').slice(0, 4)}
    </div>
  );
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
