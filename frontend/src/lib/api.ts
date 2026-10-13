export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
let csrfToken: string | null = null;
export const setCsrf = (t: string | null) => (csrfToken = t);
export const getCsrf = () => csrfToken;
export const apiUrl = (p: string) => BASE + p;

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown; manageToken?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  if (init.manageToken) headers.set('X-Manage-Token', init.manageToken);
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers,
      credentials: 'include',
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export interface AppConfig {
  maxFileBytes: number;
  partSize: number;
  allowAnonymous: boolean;
  allowRegistration: boolean;
  retentionOptions: { key: string; label: string; seconds: number }[];
  blockedExtensions: string[];
}
export interface FileInfo {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  extension: string;
  createdAt: string;
  expiresAt: string;
  passwordProtected: boolean;
  downloadLimit: number | null;
  downloadsRemaining: number | null;
  checksumSha256: string | null;
  executableWarning: boolean;
}
export interface OwnedFile extends FileInfo {
  downloadCount: number;
  uploadedAt: string;
  uploadStatus: 'uploading' | 'ready' | 'deleted';
  availability: 'ready' | 'uploading' | 'expired' | 'deleted' | 'missing';
  deletion: { status: 'none' | 'pending' | 'in_progress' | 'failed' | 'deleted'; reason: string | null; attempts: number; lastError: string | null };
  ownerId?: string | null;
}
