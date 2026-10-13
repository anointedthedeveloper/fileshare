import { upload } from '@vercel/blob/client';

export const MAX_MB = 1024; // keep in sync with MAX_BYTES in api/_lib/util.js
export const MAX_BYTES = MAX_MB * 1024 * 1024;
export const RETENTIONS = [
  { key: '1h', label: '1 hour' },
  { key: '6h', label: '6 hours' },
  { key: '1d', label: '1 day' },
  { key: '3d', label: '3 days' },
] as const;

export interface Progress {
  loaded: number;
  total: number;
  percent: number;
  speed: number;
  eta: number;
  finishing: boolean;
}
export interface Result {
  code: string;
  name: string;
  size: number;
  expiresAt: string;
}

export class UploadAborted extends Error {}

/** Browser → Vercel Blob directly (multipart, parallel parts), then one call to mint the short link. */
export async function uploadFile(
  file: File,
  retention: string,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<Result> {
  const samples: { t: number; b: number }[] = [];
  const emit = (loaded: number, finishing = false) => {
    const now = performance.now();
    samples.push({ t: now, b: loaded });
    while (samples.length > 2 && now - samples[0].t > 4000) samples.shift();
    const dt = (now - samples[0].t) / 1000;
    const speed = dt > 0.25 ? Math.max(0, (loaded - samples[0].b) / dt) : 0;
    onProgress({
      loaded,
      total: file.size,
      percent: (loaded / file.size) * 100,
      speed,
      eta: speed > 0 ? (file.size - loaded) / speed : Infinity,
      finishing,
    });
  };
  emit(0);

  let blob;
  try {
    blob = await upload(`f/${crypto.randomUUID()}/${file.name}`, file, {
      access: 'public',
      handleUploadUrl: '/api/upload',
      multipart: true,
      abortSignal: signal,
      onUploadProgress: (e) => emit(e.loaded),
    });
  } catch (e) {
    if (signal.aborted) throw new UploadAborted();
    throw new Error(await explain(e));
  }

  emit(file.size, true);
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: blob.url, name: file.name, retention }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Could not create the link.');
  return data as Result;
}

/** Turn a vague client error into the real reason (asks the server what is misconfigured). */
async function explain(e: unknown): Promise<string> {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const h = await r.json();
    if (h?.problems?.length) return `Setup problem: ${h.problems[0]}`;
  } catch {
    /* health unreachable: fall through */
  }
  const m = e instanceof Error ? e.message : '';
  if (/maximum|too large/i.test(m)) return `That file is too big. The limit is ${MAX_MB} MB.`;
  if (!navigator.onLine) return 'You appear to be offline. Check your network and try again.';
  return m ? `Upload failed: ${m}` : 'Upload failed. Please try again.';
}
