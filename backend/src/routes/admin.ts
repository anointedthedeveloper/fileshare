import { Router } from 'express';
import { z } from 'zod';
import { wrap } from '../middleware/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import { FileModel } from '../models/File.js';
import { UploadSessionModel } from '../models/UploadSession.js';
import { UserModel } from '../models/User.js';
import { ErrorLogModel } from '../models/ErrorLog.js';
import { AuditLogModel } from '../models/AuditLog.js';
import { getSettings, settingsPatchSchema, updateSettings } from '../services/settings.js';
import { audit } from '../services/audit.js';
import { privateInfo, deleteFile } from '../services/files.js';
import { runCleanupOnce } from '../services/cleanup.js';
import { storageUsedBytes } from '../services/uploads.js';
import { storage } from '../storage/index.js';
import { ID_RE } from '../utils/ids.js';
import { notFound } from '../utils/errors.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);
const actor = (req: any) => ({ id: String(req.user._id), email: req.user.email });

adminRouter.get('/stats', wrap(async (_req, res) => {
  const now = new Date();
  const live = { status: 'ready', 'deletion.status': 'none' };
  const [totals, active, expiredWaiting, pendingDeletion, failedDeletion, uploading, users, recentErrors, used, downloads, settings] =
    await Promise.all([
      FileModel.aggregate([{ $match: { status: { $ne: 'deleted' } } }, { $group: { _id: null, files: { $sum: 1 }, bytes: { $sum: '$size' } } }]),
      FileModel.countDocuments({ ...live, expiresAt: { $gt: now } }),
      FileModel.countDocuments({ ...live, expiresAt: { $lte: now } }),
      FileModel.countDocuments({ 'deletion.status': { $in: ['pending', 'in_progress'] } }),
      FileModel.countDocuments({ 'deletion.status': 'failed' }),
      UploadSessionModel.countDocuments({ status: { $in: ['active', 'completing'] } }),
      UserModel.countDocuments(),
      ErrorLogModel.find().sort({ createdAt: -1 }).limit(20).lean(),
      storageUsedBytes(),
      FileModel.aggregate([{ $group: { _id: null, n: { $sum: '$downloadCount' } } }]),
      getSettings(),
    ]);
  res.json({
    totalFiles: totals[0]?.files ?? 0,
    storedBytes: totals[0]?.bytes ?? 0,
    activeFiles: active,
    expiredAwaitingDeletion: expiredWaiting,
    deletionsPending: pendingDeletion,
    deletionFailures: failedDeletion,
    uploadsInProgress: uploading,
    users,
    totalDownloads: downloads[0]?.n ?? 0,
    storage: { provider: storage().name, usedBytes: used, quotaBytes: settings.storageQuotaBytes },
    recentErrors: recentErrors.map((e) => ({ id: String(e._id), source: e.source, message: e.message, at: e.createdAt, context: e.context })),
  });
}));

adminRouter.get('/files', wrap(async (req, res) => {
  const { page, pageSize, state } = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      state: z.enum(['all', 'active', 'expired', 'failed', 'uploading']).default('all'),
    })
    .parse(req.query);
  const now = new Date();
  const filter: Record<string, unknown> = {};
  if (state === 'active') Object.assign(filter, { status: 'ready', 'deletion.status': 'none', expiresAt: { $gt: now } });
  if (state === 'expired') Object.assign(filter, { status: 'ready', 'deletion.status': 'none', expiresAt: { $lte: now } });
  if (state === 'failed') filter['deletion.status'] = 'failed';
  if (state === 'uploading') filter.status = 'uploading';
  const [items, total] = await Promise.all([
    FileModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    FileModel.countDocuments(filter),
  ]);
  res.json({ items: items.map((f) => ({ ...privateInfo(f), uploadedAt: f.createdAt, ownerId: f.ownerId ? String(f.ownerId) : null })), total, page, pageSize });
}));

adminRouter.delete('/files/:fileId', wrap(async (req, res) => {
  if (!ID_RE.test(req.params.fileId)) throw notFound();
  const out = await deleteFile(req.params.fileId, { user: req.user });
  await audit(actor(req), 'file.delete', req.params.fileId, undefined, req.ip);
  res.json(out);
}));

adminRouter.get('/settings', wrap(async (_req, res) => void res.json(await getSettings())));
adminRouter.put('/settings', wrap(async (req, res) => {
  const patch = settingsPatchSchema.parse(req.body);
  const before = await getSettings();
  const after = await updateSettings(patch, String(req.user!._id));
  await audit(actor(req), 'settings.update', 'global', { before, patch }, req.ip);
  res.json(after);
}));

adminRouter.post('/cleanup/run', wrap(async (req, res) => {
  const stats = await runCleanupOnce();
  await audit(actor(req), 'cleanup.run', undefined, stats as unknown as Record<string, unknown>, req.ip);
  res.json(stats);
}));

adminRouter.get('/errors', wrap(async (_req, res) => {
  const items = await ErrorLogModel.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json({ items: items.map((e) => ({ id: String(e._id), source: e.source, message: e.message, at: e.createdAt, context: e.context })) });
}));

adminRouter.get('/audit', wrap(async (_req, res) => {
  const items = await AuditLogModel.find().sort({ at: -1 }).limit(100).lean();
  res.json({ items });
}));
