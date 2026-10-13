import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { z } from 'zod';
import { config } from '../config.js';
import { FileModel } from '../models/File.js';
import { UploadSessionModel, type SessionDoc } from '../models/UploadSession.js';
import { storage } from '../storage/index.js';
import { StorageError } from '../storage/types.js';
import { HttpError, badRequest, conflict, gone, notFound } from '../utils/errors.js';
import { randomId, sha256Hex } from '../utils/ids.js';
import { SIGNATURE_BYTES, validateUploadMetadata, verifySignature, typeFor } from './filePolicy.js';
import { computeExpiry, resolveRetention } from './retention.js';
import { getSettings } from './settings.js';
import { getScanner } from './scanner.js';
import { hashPassword } from './auth.js';
import { recordError } from '../db.js';
import { logger } from '../logger.js';
import type { UserDoc } from '../models/User.js';

export const initiateSchema = z
  .object({
    filename: z.string().min(1).max(1024),
    size: z.number().int().positive(),
    mimeType: z.string().max(200).optional(),
    retention: z.string().optional(),
    retentionSeconds: z.number().optional(),
    password: z.string().min(4).max(128).optional(),
    downloadLimit: z.number().int().min(1).max(1_000_000).optional(),
    clientKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  })
  .strict();
export type InitiateInput = z.infer<typeof initiateSchema>;

export interface Actor {
  user?: UserDoc;
  clientId: string;
}

const scopeOf = (a: Actor) => (a.user ? `u:${a.user._id}` : `a:${a.clientId}`);

export async function storageUsedBytes(): Promise<number> {
  const r = await FileModel.aggregate([{ $match: { status: { $ne: 'deleted' } } }, { $group: { _id: null, total: { $sum: '$size' } } }]);
  return r[0]?.total ?? 0;
}

export function partGeometry(size: number, preferredPartSize: number) {
  let partSize = preferredPartSize;
  // object stores allow at most 10 000 parts
  while (Math.ceil(size / partSize) > 10_000) partSize *= 2;
  return { partSize, totalParts: Math.max(1, Math.ceil(size / partSize)) };
}

export const expectedPartSize = (s: Pick<SessionDoc, 'partSize' | 'totalParts' | 'expectedSize'>, n: number) =>
  n < s.totalParts ? s.partSize : s.expectedSize - s.partSize * (s.totalParts - 1);

type PartLike = { partNumber?: number | null; size?: number | null };
function sessionView(s: SessionDoc, parts: ReadonlyArray<PartLike>) {
  return {
    sessionId: s.sessionId,
    status: s.status,
    partSize: s.partSize,
    totalParts: s.totalParts,
    expectedSize: s.expectedSize,
    expiresAt: s.expiresAt,
    uploadedParts: parts.map((p) => p.partNumber ?? 0).sort((a, b) => a - b),
    uploadedBytes: parts.reduce((n, p) => n + (p.size ?? 0), 0),
    error: s.error,
  };
}

export async function initiateUpload(input: InitiateInput, actor: Actor) {
  const c = config();
  const settings = await getSettings();
  if (!actor.user && !settings.allowAnonymous) throw new HttpError(401, 'login_required', 'Anonymous uploads are disabled. Please sign in.');

  if (input.size > settings.maxFileBytes) {
    throw new HttpError(413, 'file_too_large', `File exceeds the maximum of ${settings.maxFileBytes} bytes`);
  }
  const meta = validateUploadMetadata(input.filename, input.mimeType, settings.blockedExtensions);
  const retentionSeconds = resolveRetention(input, settings.allowedRetentionKeys);
  const scopeKey = scopeOf(actor);

  // Idempotent replay: same client key => same session, no duplicate file record.
  if (input.clientKey) {
    const existing = await FileModel.findOne({ scopeKey, clientKey: input.clientKey }).lean();
    if (existing) return replay(existing.fileId, input);
  }

  // DB-backed rate limit (works across instances)
  const recent = await FileModel.countDocuments({
    uploaderHash: actor.clientId,
    createdAt: { $gt: new Date(Date.now() - 3600_000) },
  });
  if (recent >= settings.uploadsPerHour) throw new HttpError(429, 'upload_rate_limited', 'Hourly upload limit reached. Try again later.');

  if ((await storageUsedBytes()) + input.size > settings.storageQuotaBytes) {
    throw new HttpError(507, 'storage_full', 'The service has run out of storage space. Please try again later.');
  }

  const { partSize, totalParts } = partGeometry(input.size, c.PART_SIZE_BYTES);
  const fileId = randomId(16);
  const key = randomId(24);
  const manageToken = randomId(24); // lets an anonymous uploader delete; only its hash is stored
  const now = new Date();

  try {
    await FileModel.create({
      fileId,
      originalName: meta.name,
      storageKey: key,
      storageProvider: storage().name,
      size: input.size,
      mimeType: meta.mimeType,
      extension: meta.extension,
      status: 'uploading',
      ownerId: actor.user?._id ?? null,
      uploaderHash: actor.clientId,
      scopeKey,
      clientKey: input.clientKey,
      manageTokenHash: sha256Hex(manageToken),
      retentionSeconds,
      expiresAt: computeExpiry(retentionSeconds, now),
      downloadLimit: input.downloadLimit ?? null,
      passwordHash: input.password ? await hashPassword(input.password) : null,
    });
  } catch (e: any) {
    if (e?.code === 11000 && input.clientKey) {
      const ex = await FileModel.findOne({ scopeKey, clientKey: input.clientKey }).lean();
      if (ex) return replay(ex.fileId, input);
    }
    throw e;
  }

  let uploadId: string;
  try {
    uploadId = await storage().createMultipart(key, { partSize, totalSize: input.size, contentType: meta.mimeType });
  } catch (e) {
    await FileModel.deleteOne({ fileId });
    throw e;
  }
  const sessionId = randomId(32);
  const session = await UploadSessionModel.create({
    sessionId,
    fileId,
    ownerId: actor.user?._id ?? null,
    uploaderHash: actor.clientId,
    filename: meta.name,
    extension: meta.extension,
    declaredMime: meta.declared,
    expectedSize: input.size,
    partSize,
    totalParts,
    storageKey: key,
    storageUploadId: uploadId,
    status: 'active',
    lastActivityAt: now,
    expiresAt: new Date(now.getTime() + c.UPLOAD_SESSION_TTL_HOURS * 3600_000),
  });
  return { ...sessionView(session.toObject() as SessionDoc, []), resumed: false, manageToken };
}

async function replay(fileId: string, input: InitiateInput) {
  const file = await FileModel.findOne({ fileId }).lean();
  const session = await UploadSessionModel.findOne({ fileId }).lean();
  if (!file || !session) throw conflict('upload_state_gone', 'Previous upload with this key no longer exists');
  if (file.size !== input.size) throw conflict('client_key_reused', 'clientKey was already used for a different upload');
  if (session.status === 'completed') throw conflict('already_completed', 'This upload has already completed');
  if (session.status !== 'active' && session.status !== 'completing') throw conflict('upload_not_active', 'Previous upload is no longer active');
  return { ...sessionView(session as SessionDoc, session.parts ?? []), resumed: true };
}

async function loadSession(sessionId: string, actor: Actor): Promise<SessionDoc> {
  const s = await UploadSessionModel.findOne({ sessionId }).lean();
  if (!s) throw notFound('Upload session not found');
  if (s.ownerId && String(s.ownerId) !== String(actor.user?._id)) throw notFound('Upload session not found');
  return s as SessionDoc;
}

export async function getSession(sessionId: string, actor: Actor) {
  const s = await loadSession(sessionId, actor);
  let parts: PartLike[] = s.parts ?? [];
  if (s.status === 'active') {
    // storage is the source of truth for which parts really landed (survives crashes)
    try {
      parts = (await storage().listParts(s.storageKey, s.storageUploadId)).map((p) => ({ partNumber: p.partNumber, size: p.size }));
    } catch {
      /* fall back to the recorded parts */
    }
  }
  const view = sessionView(s, parts);
  if (s.status === 'completed') {
    const f = await FileModel.findOne({ fileId: s.fileId }).lean();
    return { ...view, file: f ? fileResult(f) : undefined };
  }
  return view;
}

function fileResult(f: { fileId: string; originalName: string; size: number; expiresAt: Date; passwordHash?: string | null; downloadLimit?: number | null }) {
  return {
    fileId: f.fileId,
    name: f.originalName,
    size: f.size,
    expiresAt: f.expiresAt,
    passwordProtected: !!f.passwordHash,
    downloadLimit: f.downloadLimit ?? null,
  };
}

/** Captures the head of the stream and validates the file signature as soon as enough bytes arrive. */
function signatureGuard(extension: string) {
  let head = Buffer.alloc(0);
  let checked = false;
  const check = () => {
    checked = true;
    if (!verifySignature(extension, head)) {
      throw new HttpError(415, 'signature_mismatch', `File contents do not match the .${extension} format`);
    }
  };
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      try {
        if (!checked) {
          head = Buffer.concat([head, chunk.subarray(0, SIGNATURE_BYTES - head.length)]);
          if (head.length >= SIGNATURE_BYTES) check();
        }
        cb(null, chunk);
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      try {
        if (!checked) check();
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

export async function receivePart(sessionId: string, partNumber: number, body: Readable, contentLength: number | undefined, actor: Actor) {
  const s = await loadSession(sessionId, actor);
  if (s.status !== 'active') throw conflict('upload_not_active', `Upload is ${s.status}`);
  if (s.expiresAt.getTime() < Date.now()) throw gone('upload_expired', 'Upload session expired');
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > s.totalParts) {
    throw badRequest('invalid_part_number', `partNumber must be between 1 and ${s.totalParts}`);
  }
  const expected = expectedPartSize(s, partNumber);
  if (contentLength === undefined) throw new HttpError(411, 'length_required', 'Content-Length is required');
  if (contentLength !== expected) {
    throw badRequest('invalid_part_size', `Part ${partNumber} must be exactly ${expected} bytes (got ${contentLength})`);
  }

  await UploadSessionModel.updateOne({ sessionId }, { $set: { lastActivityAt: new Date() } });

  // The first part carries the file header: verify its signature while streaming, so a
  // mismatching 3 GB upload is rejected after a few KB instead of at the end.
  let guardError: Error | undefined;
  let source: Readable = body;
  if (partNumber === 1) {
    const guard = signatureGuard(s.extension);
    guard.on('error', (e) => (guardError = e));
    body.on('error', (e) => guard.destroy(e));
    source = body.pipe(guard);
  }
  let part;
  try {
    part = await storage().uploadPart(s.storageKey, s.storageUploadId, partNumber, source, expected);
  } catch (e) {
    throw guardError ?? e;
  }

  // record (upsert by part number) for observability; storage remains the source of truth
  const upd = await UploadSessionModel.updateOne(
    { sessionId, 'parts.partNumber': partNumber },
    { $set: { 'parts.$': { partNumber, size: part.size, etag: part.etag, at: new Date() }, lastActivityAt: new Date() } },
  );
  if (upd.matchedCount === 0) {
    await UploadSessionModel.updateOne(
      { sessionId, 'parts.partNumber': { $ne: partNumber } },
      { $push: { parts: { partNumber, size: part.size, etag: part.etag, at: new Date() } }, $set: { lastActivityAt: new Date() } },
    );
  }
  return { partNumber, size: part.size, etag: part.etag };
}

export async function completeUpload(sessionId: string, actor: Actor, waitMs = 55_000) {
  const s = await loadSession(sessionId, actor);
  if (s.status === 'completed') {
    const f = await FileModel.findOne({ fileId: s.fileId }).lean();
    return { state: 'completed' as const, file: f ? fileResult(f) : undefined };
  }
  if (s.status === 'aborted' || s.status === 'failed') throw conflict('upload_not_active', s.error ?? `Upload is ${s.status}`);

  const claimed = await UploadSessionModel.findOneAndUpdate(
    { sessionId, status: 'active' },
    { $set: { status: 'completing', lockedUntil: new Date(Date.now() + 15 * 60_000), lastActivityAt: new Date() } },
    { new: true },
  ).lean();
  if (!claimed) return { state: 'processing' as const }; // another request is already finalising

  const work = finalize(claimed as SessionDoc);
  const raced = await Promise.race([work, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), waitMs).unref())]);
  if (raced === 'timeout') {
    work.catch(() => undefined);
    return { state: 'processing' as const };
  }
  return raced;
}


async function finalize(s: SessionDoc) {
  const c = config();
  const store = storage();
  const fail = async (status: number, code: string, message: string): Promise<never> => {
    await UploadSessionModel.updateOne({ sessionId: s.sessionId }, { $set: { status: 'failed', error: message } });
    await releaseSession(s.sessionId).catch(() => undefined);
    throw new HttpError(status, code, message);
  };
  try {
    // Storage may already hold the object if a previous attempt crashed after assembly.
    const existing = await store.stat(s.storageKey);
    if (!(existing && existing.size === s.expectedSize)) {
      try {
        await store.completeMultipart(s.storageKey, s.storageUploadId, s.expectedSize, s.totalParts);
      } catch (e) {
        if (e instanceof StorageError && (e.code === 'missing_parts')) {
          await UploadSessionModel.updateOne({ sessionId: s.sessionId }, { $set: { status: 'active', lockedUntil: undefined } });
          throw new HttpError(409, 'incomplete_upload', e.message);
        }
        if (e instanceof StorageError && e.code === 'size_mismatch') return await fail(422, 'size_mismatch', 'Uploaded size does not match the declared size');
        throw e;
      }
    }

    const st = await store.stat(s.storageKey);
    if (!st || st.size !== s.expectedSize) return await fail(422, 'size_mismatch', 'Uploaded size does not match the declared size');
    if (st.size > (await getSettings()).maxFileBytes) return await fail(413, 'file_too_large', 'File exceeds the maximum size');

    const head = await store.readHead(s.storageKey, SIGNATURE_BYTES);
    if (!verifySignature(s.extension, head)) return await fail(415, 'signature_mismatch', `File contents do not match the .${s.extension} format`);

    if ((await storageUsedBytes()) > (await getSettings()).storageQuotaBytes) {
      return await fail(507, 'storage_full', 'The service has run out of storage space.');
    }

    // one pass over the object: checksum + malware scan
    let checksum: string | undefined;
    const scanner = getScanner();
    if (c.COMPUTE_CHECKSUM || scanner.name !== 'none') {
      const stream = await store.getStream(s.storageKey);
      const hash = createHash('sha256');
      stream.on('data', (d: Buffer) => hash.update(d));
      const ended = new Promise<void>((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
      });
      let result;
      try {
        [result] = await Promise.all([scanner.scan(stream), ended]);
      } catch (e) {
        stream.destroy();
        await recordError('scanner', 'malware scan failed', { err: (e as Error).message });
        return await fail(503, 'scan_unavailable', 'Could not verify the file safely. Please try again later.');
      }
      if (!result.clean) return await fail(422, 'malware_detected', 'The file was rejected by the malware scanner');
      checksum = hash.digest('hex');
    }

    const file = await FileModel.findOne({ fileId: s.fileId });
    if (!file) return await fail(410, 'file_gone', 'Upload was cancelled');
    const now = new Date();
    file.status = 'ready';
    file.completedAt = now;
    file.expiresAt = computeExpiry(file.retentionSeconds, now); // retention starts when the file becomes available
    file.checksumSha256 = checksum;
    file.mimeType = typeFor(file.extension).mime;
    await file.save();
    await UploadSessionModel.updateOne(
      { sessionId: s.sessionId },
      { $set: { status: 'completed', released: true, purgeAt: new Date(now.getTime() + 3600_000) }, $unset: { lockedUntil: 1 } },
    );
    return { state: 'completed' as const, file: fileResult(file) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // unexpected (storage outage etc.): hand back to the active state so the client can retry
    logger.error({ err: (e as Error).message, sessionId: s.sessionId }, 'finalize failed');
    await recordError('api', `finalize failed: ${(e as Error).message}`, { sessionId: s.sessionId });
    await UploadSessionModel.updateOne({ sessionId: s.sessionId, status: 'completing' }, { $set: { status: 'active' }, $unset: { lockedUntil: 1 } });
    throw new HttpError(503, 'finalize_failed', 'Could not finalize the upload; please retry.');
  }
}

/** Releases storage-side state of a dead session and removes the never-published file record. Idempotent. */
export async function releaseSession(sessionId: string) {
  const s = await UploadSessionModel.findOne({ sessionId }).lean();
  if (!s || s.released) return;
  const store = storage();
  await store.abortMultipart(s.storageKey, s.storageUploadId).catch((e) => {
    if (!(e instanceof StorageError && e.code === 'not_found')) throw e;
  });
  await store.delete(s.storageKey); // object may exist if assembly succeeded before a later check failed
  await FileModel.deleteOne({ fileId: s.fileId, status: 'uploading' });
  await UploadSessionModel.updateOne(
    { sessionId },
    { $set: { released: true, purgeAt: new Date(Date.now() + 3600_000) } },
  );
}

export async function abortUpload(sessionId: string, actor: Actor) {
  const s = await loadSession(sessionId, actor);
  if (s.status === 'completed') throw conflict('already_completed', 'Upload already completed; delete the file instead');
  await UploadSessionModel.updateOne({ sessionId, status: { $in: ['active', 'completing', 'failed'] } }, { $set: { status: 'aborted' } });
  try {
    await releaseSession(sessionId);
  } catch (e) {
    // the cleanup worker retries sessions that are aborted but not released
    await recordError('api', 'abort release failed (worker will retry)', { sessionId, err: (e as Error).message });
  }
}
