import { Router } from 'express';
import { z } from 'zod';
import { wrap } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { FileModel } from '../models/File.js';
import { privateInfo } from '../services/files.js';

export const userRouter = Router();
userRouter.use(requireAuth);

const q = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

userRouter.get('/files', wrap(async (req, res) => {
  const { page, pageSize } = q.parse(req.query);
  const filter = { ownerId: req.user!._id, status: { $ne: 'deleted' as const } };
  const [items, total] = await Promise.all([
    FileModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    FileModel.countDocuments(filter),
  ]);
  res.json({ items: items.map((f) => ({ ...privateInfo(f), uploadedAt: f.createdAt })), total, page, pageSize });
}));
