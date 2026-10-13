import { config } from '../config.js';
import { FileModel } from '../models/File.js';
import { UploadSessionModel } from '../models/UploadSession.js';
import { storage } from '../storage/index.js';
import { recordError } from '../db.js';
import { logger } from '../logger.js';
import { releaseSession } from './uploads.js';

const MAX_BACKOFF_SECONDS = 6 * 3600;

export function backoffSeconds(attempts: number, base = config().DELETE_RETRY_BASE_SECONDS) {
  return Math.min(base * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SECONDS);
}

/**
 * Atomically claims one file that needs physical deletion:
 *  - expired and untouched, or pending (user/admin/aborted), or failed and due for retry,
 *  - or "in_progress" with an expired lock (a worker died mid-delete: resume it).
 */
async function claimNext(now: Date, fileId?: string) {
  const due = {
    $or: [
      { 'deletion.status': 'none', status: 'ready', expiresAt: { $lte: now } },
      { 'deletion.status': { $in: ['pending', 'failed'] }, 'deletion.nextAttemptAt': { $lte: now } },
      { 'deletion.status': 'in_progress', 'deletion.lockedUntil': { $lt: now } },
    ],
  };
  const filter = fileId ? { fileId, ...due } : due;
  return FileModel.findOneAndUpdate(
    filter,
    {
      $set: { 'deletion.status': 'in_progress', 'deletion.lockedUntil': new Date(now.getTime() + 5 * 60_000) },
      $inc: { 'deletion.attempts': 1 },
    },
    { new: true, sort: { expiresAt: 1 } },
  ).lean();
}

type Claimed = NonNullable<Awaited<ReturnType<typeof claimNext>>>;

async function performDelete(f: Claimed, now: Date): Promise<'deleted' | 'failed'> {
  try {
    await storage().delete(f.storageKey); // idempotent: missing object is success
    const tomb = config().TOMBSTONE_HOURS;
    if (tomb === 0) {
      await FileModel.deleteOne({ fileId: f.fileId });
    } else {
      await FileModel.updateOne(
        { fileId: f.fileId },
        {
          $set: {
            status: 'deleted',
            'deletion.status': 'deleted',
            'deletion.deletedAt': now,
            'deletion.reason': f.deletion?.reason ?? 'expired',
            purgeAt: new Date(now.getTime() + tomb * 3600_000), // TTL index sweeps the tombstone
          },
          $unset: { 'deletion.lockedUntil': 1, 'deletion.lastError': 1, passwordHash: 1, manageTokenHash: 1 },
        },
      );
    }
    logger.info({ fileId: f.fileId, reason: f.deletion?.reason ?? 'expired' }, 'file deleted from storage');
    return 'deleted';
  } catch (e) {
    const attempts = f.deletion?.attempts ?? 1;
    const delay = backoffSeconds(attempts);
    const msg = (e as Error).message?.slice(0, 300) ?? 'unknown';
    await FileModel.updateOne(
      { fileId: f.fileId },
      {
        $set: {
          'deletion.status': 'failed',
          'deletion.lastError': msg,
          'deletion.nextAttemptAt': new Date(now.getTime() + delay * 1000),
          'deletion.reason': f.deletion?.reason ?? 'expired',
        },
        $unset: { 'deletion.lockedUntil': 1 },
      },
    );
    const exhausted = attempts >= config().DELETE_MAX_ATTEMPTS;
    await recordError('worker', exhausted ? 'storage deletion failing repeatedly; needs attention' : 'storage deletion failed; will retry', {
      fileId: f.fileId,
      attempts,
      retryInSeconds: delay,
      err: msg,
    });
    return 'failed';
  }
}

/** Deletes one specific file now (manual deletion path). Falls back to the worker on failure. */
export async function deleteFileNow(fileId: string) {
  const now = new Date();
  const f = await claimNext(now, fileId);
  if (!f) return 'skipped' as const;
  return performDelete(f, now);
}

export interface CleanupStats {
  deleted: number;
  failed: number;
  sessionsReleased: number;
  sessionsExpired: number;
  orphansQueued: number;
  tombstonesPurged: number;
}

export async function runCleanupOnce(now = new Date()): Promise<CleanupStats> {
  const c = config();
  const stats: CleanupStats = { deleted: 0, failed: 0, sessionsReleased: 0, sessionsExpired: 0, orphansQueued: 0, tombstonesPurged: 0 };

  // 1. expired / pending / retryable file deletions
  for (let i = 0; i < c.CLEANUP_BATCH_SIZE; i++) {
    const f = await claimNext(now);
    if (!f) break;
    (await performDelete(f, now)) === 'deleted' ? stats.deleted++ : stats.failed++;
  }

  // 2. abandoned upload sessions: expired, idle, or stuck finalising
  await UploadSessionModel.updateMany(
    { status: 'completing', lockedUntil: { $lt: now } },
    { $set: { status: 'active' }, $unset: { lockedUntil: 1 } },
  );
  const idleBefore = new Date(now.getTime() - c.UPLOAD_IDLE_TIMEOUT_MINUTES * 60_000);
  const abandoned = await UploadSessionModel.updateMany(
    { status: 'active', $or: [{ expiresAt: { $lte: now } }, { lastActivityAt: { $lt: idleBefore } }] },
    { $set: { status: 'aborted', error: 'abandoned' } },
  );
  stats.sessionsExpired = abandoned.modifiedCount;

  // 3. release storage state for aborted/failed sessions (also retries earlier failures)
  const toRelease = await UploadSessionModel.find({ status: { $in: ['aborted', 'failed'] }, released: false })
    .limit(c.CLEANUP_BATCH_SIZE)
    .select('sessionId')
    .lean();
  for (const s of toRelease) {
    try {
      await releaseSession(s.sessionId);
      stats.sessionsReleased++;
    } catch (e) {
      await recordError('worker', 'failed to release upload session; will retry', { sessionId: s.sessionId, err: (e as Error).message });
    }
  }

  // 4. file records stuck in "uploading" with no live session -> queue for deletion
  const orphanBefore = new Date(now.getTime() - (c.UPLOAD_SESSION_TTL_HOURS * 2) * 3600_000);
  const orphans = await FileModel.updateMany(
    { status: 'uploading', 'deletion.status': 'none', createdAt: { $lt: orphanBefore } },
    { $set: { 'deletion.status': 'pending', 'deletion.reason': 'aborted', 'deletion.nextAttemptAt': now } },
  );
  stats.orphansQueued = orphans.modifiedCount;

  // 5. tombstones past their grace period (TTL index does the same; this is the explicit path)
  const purged = await FileModel.deleteMany({ 'deletion.status': 'deleted', purgeAt: { $lte: now } });
  stats.tombstonesPurged = purged.deletedCount;
  return stats;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startCleanupWorker() {
  const c = config();
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await runCleanupOnce();
      if (s.deleted || s.failed || s.sessionsReleased || s.sessionsExpired || s.orphansQueued) logger.info(s, 'cleanup pass');
    } catch (e) {
      await recordError('worker', `cleanup pass crashed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, c.CLEANUP_INTERVAL_SECONDS * 1000);
  void tick();
  return () => timer && clearInterval(timer);
}
export function stopCleanupWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
