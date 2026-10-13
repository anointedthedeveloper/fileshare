import { api, apiUrl, ApiError, getCsrf } from './api';

export type Phase = 'preparing' | 'uploading' | 'finalizing' | 'done' | 'cancelled' | 'error';

export interface Progress {
  phase: Phase;
  loaded: number;
  total: number;
  percent: number;
  speed: number; // bytes / second (rolling 5 s window)
  eta: number; // seconds
  resumed: boolean;
  retrying: boolean;
}

export interface UploadedFile {
  fileId: string;
  name: string;
  size: number;
  expiresAt: string;
  passwordProtected: boolean;
  downloadLimit: number | null;
}
export interface UploadResult {
  file: UploadedFile;
  manageToken?: string;
}

export interface UploadOptions {
  retention: string;
  password?: string;
  downloadLimit?: number;
  concurrency?: number;
  onProgress: (p: Progress) => void;
}

interface Session {
  sessionId: string;
  partSize: number;
  totalParts: number;
  expectedSize: number;
  uploadedParts: number[];
  resumed?: boolean;
  manageToken?: string;
}

const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cancelled extends Error {}

/** Resumable, chunked uploader: parallel parts via XHR (for byte-level progress), per-part retry with backoff. */
export class ChunkedUploader {
  private cancelled = false;
  private xhrs = new Set<XMLHttpRequest>();
  private samples: { t: number; b: number }[] = [];
  private inflight = new Map<number, number>();
  private doneBytes = 0;
  private session?: Session;
  private resumed = false;
  private retrying = false;
  private phase: Phase = 'preparing';

  private file: File;
  private opts: UploadOptions;
  private manageToken?: string;

  constructor(file: File, opts: UploadOptions) {
    this.file = file;
    this.opts = opts;
  }

  private storageKey = () => `parcel-upload:${this.file.name}:${this.file.size}:${this.file.lastModified}`;

  private emit() {
    const loaded = Math.min(this.file.size, this.doneBytes + [...this.inflight.values()].reduce((a, b) => a + b, 0));
    const now = performance.now();
    this.samples.push({ t: now, b: loaded });
    while (this.samples.length > 2 && now - this.samples[0].t > 5000) this.samples.shift();
    const first = this.samples[0];
    const dt = (now - first.t) / 1000;
    const speed = dt > 0.25 ? Math.max(0, (loaded - first.b) / dt) : 0;
    this.opts.onProgress({
      phase: this.phase,
      loaded,
      total: this.file.size,
      percent: this.file.size ? (loaded / this.file.size) * 100 : 0,
      speed,
      eta: speed > 0 ? (this.file.size - loaded) / speed : Infinity,
      resumed: this.resumed,
      retrying: this.retrying,
    });
  }

  async start(): Promise<UploadResult> {
    try {
      this.emit();
      const session = await this.initiate();
      this.session = session;
      this.manageToken = session.manageToken ?? this.loadManageToken();
      this.resumed = !!session.resumed && session.uploadedParts.length > 0;
      const have = new Set(session.uploadedParts);
      for (const n of have) this.doneBytes += this.partLength(session, n);
      this.phase = 'uploading';
      this.emit();

      const queue: number[] = [];
      for (let n = 1; n <= session.totalParts; n++) if (!have.has(n)) queue.push(n);
      let fatal: unknown;
      const worker = async () => {
        while (!this.cancelled && !fatal) {
          const n = queue.shift();
          if (n === undefined) return;
          try {
            await this.sendPart(session, n);
          } catch (e) {
            fatal = fatal ?? e;
            this.abortAll();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? 3, Math.max(1, queue.length)) }, worker));
      if (this.cancelled) throw new Cancelled();
      if (fatal) throw fatal;

      this.phase = 'finalizing';
      this.inflight.clear();
      this.emit();
      const result = await this.complete(session);
      result.manageToken = this.manageToken;
      this.phase = 'done';
      this.emit();
      this.forget();
      return result;
    } catch (e) {
      if (this.cancelled || e instanceof Cancelled) {
        this.phase = 'cancelled';
        this.emit();
        throw new Cancelled('Upload cancelled');
      }
      this.phase = 'error';
      this.emit();
      throw e;
    }
  }

  /** Cancels transfers and discards the server-side partial upload. */
  async cancel() {
    this.cancelled = true;
    this.abortAll();
    this.forget();
    if (this.session) {
      try {
        await api(`/api/uploads/${this.session.sessionId}`, { method: 'DELETE' });
      } catch {
        /* the server-side cleanup worker removes it anyway */
      }
    }
  }

  private abortAll() {
    for (const x of this.xhrs) x.abort();
    this.xhrs.clear();
  }

  private loadManageToken() {
    try {
      return localStorage.getItem(this.storageKey() + ':mt') ?? undefined;
    } catch {
      return undefined;
    }
  }

  private forget() {
    try {
      localStorage.removeItem(this.storageKey());
      localStorage.removeItem(this.storageKey() + ':mt');
    } catch {
      /* storage unavailable */
    }
  }

  private async initiate(): Promise<Session> {
    let clientKey: string | undefined;
    try {
      clientKey = localStorage.getItem(this.storageKey()) ?? undefined;
    } catch {
      /* ignore */
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      clientKey = clientKey ?? crypto.randomUUID();
      try {
        localStorage.setItem(this.storageKey(), clientKey);
      } catch {
        /* ignore */
      }
      try {
        const s = await api<Session>('/api/uploads/initiate', {
          method: 'POST',
          json: {
            filename: this.file.name,
            size: this.file.size,
            mimeType: this.file.type || undefined,
            retention: this.opts.retention,
            password: this.opts.password || undefined,
            downloadLimit: this.opts.downloadLimit || undefined,
            clientKey,
          },
        });
        if (s.manageToken) {
          try {
            localStorage.setItem(this.storageKey() + ':mt', s.manageToken);
          } catch {
            /* ignore */
          }
        }
        if (s.resumed) {
          // Storage is the source of truth for which parts actually landed
          const fresh = await api<Session>(`/api/uploads/${s.sessionId}`);
          return { ...s, uploadedParts: fresh.uploadedParts, resumed: true };
        }
        return s;
      } catch (e) {
        // stale key (finished/expired/aborted earlier): start over with a new key
        if (e instanceof ApiError && e.status === 409 && attempt === 0) {
          clientKey = undefined;
          this.forget();
          continue;
        }
        throw e;
      }
    }
    throw new ApiError(0, 'error', 'Could not start upload');
  }

  private partLength(s: Session, n: number) {
    return n < s.totalParts ? s.partSize : s.expectedSize - s.partSize * (s.totalParts - 1);
  }

  private async sendPart(s: Session, n: number) {
    const start = (n - 1) * s.partSize;
    const blob = this.file.slice(start, start + this.partLength(s, n));
    for (let attempt = 1; ; attempt++) {
      if (this.cancelled) throw new Cancelled();
      try {
        this.retrying = attempt > 1;
        await this.xhrPart(s, n, blob);
        this.retrying = false;
        this.inflight.delete(n);
        this.doneBytes += blob.size;
        this.emit();
        return;
      } catch (e) {
        this.inflight.delete(n);
        if (this.cancelled) throw new Cancelled();
        const status = e instanceof ApiError ? e.status : 0;
        const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw e;
        this.retrying = true;
        this.emit();
        if (!navigator.onLine) await new Promise<void>((r) => window.addEventListener('online', () => r(), { once: true }));
        else await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  private xhrPart(s: Session, n: number, blob: Blob) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhrs.add(xhr);
      xhr.open('POST', apiUrl(`/api/uploads/${s.sessionId}/parts?partNumber=${n}`));
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      const csrf = getCsrf();
      if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.upload.onprogress = (ev) => {
        this.inflight.set(n, ev.loaded);
        this.emit();
      };
      xhr.onload = () => {
        this.xhrs.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let err: any;
        try {
          err = JSON.parse(xhr.responseText).error;
        } catch {
          /* ignore */
        }
        reject(new ApiError(xhr.status, err?.code ?? 'error', err?.message ?? `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => {
        this.xhrs.delete(xhr);
        reject(new ApiError(0, 'network', 'Connection interrupted'));
      };
      xhr.onabort = () => {
        this.xhrs.delete(xhr);
        reject(new Cancelled());
      };
      xhr.send(blob);
    });
  }

  private async complete(s: Session): Promise<UploadResult> {
    // The server may take a while to assemble, hash and scan a multi-GB file: it answers 202 and we poll.
    for (let i = 0; i < 2000; i++) {
      if (this.cancelled) throw new Cancelled();
      let res: Response;
      try {
        res = await fetch(apiUrl(`/api/uploads/${s.sessionId}/complete`), {
          method: 'POST',
          credentials: 'include',
          headers: getCsrf() ? { 'X-CSRF-Token': getCsrf()! } : undefined,
        });
      } catch {
        await sleep(2000);
        continue;
      }
      if (res.status === 200) {
        const body = await res.json();
        if (body.file) return { file: body.file, manageToken: body.manageToken };
      } else if (res.status !== 202) {
        let err: any;
        try {
          err = (await res.json()).error;
        } catch {
          /* ignore */
        }
        throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? 'Could not finalize upload');
      }
      await sleep(1500);
    }
    throw new ApiError(0, 'timeout', 'Timed out while the server was verifying the file.');
  }
}

export { Cancelled };
