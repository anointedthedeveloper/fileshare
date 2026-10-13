import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { FileModel } from '../models/File.js';
import { HttpError, forbidden, gone, notFound } from '../utils/errors.js';
import { ID_RE, safeEqual, sha256Hex } from '../utils/ids.js';
import { verifyPassword } from './auth.js';
import { isRiskyExecutable } from './filePolicy.js';
import type { UserDoc } from '../models/User.js';
import { deleteFileNow } from './cleanup.js';

type FileLean = NonNullable<Awaited<ReturnType<typeof findFile>>>;

export const findFile = (fileId: string) => (ID_RE.test(fileId) ? FileModel.findOne({ fileId }).lean() : Promise.resolve(null));

export type Availability = 'ready' | 'uploading' | 'expired' | 'deleted' | 'missing';

export function availability(f: FileLean | null, now = new Date()): Availability {
  if (!f) return 'missing';
  if (f.status === 'uploading') return 'uploading';
  if (f.status === 'deleted' || f.deletion?.status !== 'none') return 'deleted';
  if (f.expiresAt.getTime() <= now.getTime()) return 'expired'; // enforced here even before the worker removes the object
  return 'ready';
}

/** Throws the proper HTTP error unless the file can be served right now. */
export async function requireAvailable(fileId: string): Promise<FileLean> {
  const f = await findFile(fileId);
  const a = availability(f);
  if (a === 'missing' || a === 'uploading') throw notFound('This link does not exist');
  if (a === 'expired') throw gone('file_expired', 'This file has expired and is no longer available');
  if (a === 'deleted') throw gone('file_deleted', 'This file has been deleted');
  return f!;
}

export function publicInfo(f: FileLean) {
  return {
    fileId: f.fileId,
    name: f.originalName,
    size: f.size,
    mimeType: f.mimeType,
    extension: f.extension,
    createdAt: f.completedAt ?? f.createdAt,
    expiresAt: f.expiresAt,
    passwordProtected: !!f.passwordHash,
    downloadLimit: f.downloadLimit ?? null,
    downloadsRemaining: f.downloadLimit != null ? Math.max(0, f.downloadLimit - f.downloadCount) : null,
    checksumSha256: f.checksumSha256 ?? null,
    executableWarning: isRiskyExecutable(f.extension),
  };
}

export function privateInfo(f: FileLean) {
  return {
    ...publicInfo(f),
    downloadCount: f.downloadCount,
    uploadStatus: f.status,
    availability: availability(f),
    deletion: {
      status: f.deletion?.status ?? 'none',
      reason: f.deletion?.reason ?? null,
      attempts: f.deletion?.attempts ?? 0,
      lastError: f.deletion?.lastError ?? null,
      deletedAt: f.deletion?.deletedAt ?? null,
    },
  };
}

export interface DownloadTokenClaims {
  fid: string;
}
export const signDownloadToken = (fileId: string) =>
  jwt.sign({ fid: fileId, use: 'download' }, config().JWT_SECRET, { expiresIn: '15m', issuer: 'fileshare' });

function tokenValid(token: unknown, fileId: string) {
  if (typeof token !== 'string') return false;
  try {
    const p = jwt.verify(token, config().JWT_SECRET, { issuer: 'fileshare' }) as jwt.JwtPayload;
    return p.use === 'download' && p.fid === fileId;
  } catch {
    return false;
  }
}

export async function unlock(fileId: string, password: string) {
  const f = await requireAvailable(fileId);
  if (!f.passwordHash) return { token: null as string | null };
  if (!(await verifyPassword(password, f.passwordHash))) throw new HttpError(401, 'wrong_password', 'Incorrect password');
  return { token: signDownloadToken(fileId) };
}

/** Authorisation for opening the byte stream (password) - throws if not permitted. */
export async function authorizeDownload(fileId: string, token: unknown, user?: UserDoc): Promise<FileLean> {
  const f = await requireAvailable(fileId);
  if (f.passwordHash) {
    const isOwner = user && f.ownerId && String(f.ownerId) === String(user._id);
    if (!isOwner && !tokenValid(token, fileId)) {
      throw new HttpError(401, 'password_required', 'This file is password protected');
    }
  }
  return f;
}

/** Atomically consumes one download, honouring the optional limit. Never touches expiresAt. */
export async function consumeDownload(fileId: string): Promise<boolean> {
  const now = new Date();
  const r = await FileModel.findOneAndUpdate(
    {
      fileId,
      status: 'ready',
      'deletion.status': 'none',
      expiresAt: { $gt: now },
      $or: [{ downloadLimit: null }, { $expr: { $lt: ['$downloadCount', '$downloadLimit'] } }],
    },
    { $inc: { downloadCount: 1 } },
    { new: false },
  ).lean();
  return !!r;
}

export interface DeleteAuth {
  user?: UserDoc;
  manageToken?: string;
}

export function canManage(f: FileLean, auth: DeleteAuth): boolean {
  if (auth.user?.role === 'admin') return true;
  if (auth.user && f.ownerId && String(f.ownerId) === String(auth.user._id)) return true;
  if (auth.manageToken && f.manageTokenHash && safeEqual(sha256Hex(auth.manageToken), f.manageTokenHash)) return true;
  return false;
}

export async function deleteFile(fileId: string, auth: DeleteAuth) {
  const f = await findFile(fileId);
  // Unauthenticated callers cannot learn whether an id exists.
  if (!f || f.status === 'uploading') throw auth.user || auth.manageToken ? notFound('File not found') : forbidden();
  if (!canManage(f, auth)) throw forbidden('You are not allowed to delete this file');
  const reason = auth.user?.role === 'admin' && String(f.ownerId) !== String(auth.user._id) ? 'admin' : 'user';
  await FileModel.updateOne(
    { fileId, 'deletion.status': { $in: ['none', 'failed'] } },
    { $set: { 'deletion.status': 'pending', 'deletion.reason': reason, 'deletion.nextAttemptAt': new Date() } },
  );
  await deleteFileNow(fileId).catch(() => undefined); // worker retries on failure
  return { fileId, deleted: true };
}
