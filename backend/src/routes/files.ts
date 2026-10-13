import { Router } from 'express';
import { z } from 'zod';
import { create as contentDisposition } from 'content-disposition';
import rangeParser from 'range-parser';
import { pipeline, type Readable } from 'node:stream';
import { wrap } from '../middleware/errors.js';
import type { Limiters } from '../middleware/rateLimit.js';
import { ID_RE } from '../utils/ids.js';
import { HttpError, gone, notFound } from '../utils/errors.js';
import { authorizeDownload, availability, consumeDownload, deleteFile, findFile, publicInfo, unlock } from '../services/files.js';
import { downloadMime } from '../services/filePolicy.js';
import { storage } from '../storage/index.js';
import { StorageError } from '../storage/types.js';
import { recordError } from '../db.js';

export function filesRouter(l: Limiters) {
  const r = Router();
  r.param('fileId', (_req, _res, next, id) => (ID_RE.test(id) ? next() : next(notFound('This link does not exist'))));

  r.get('/:fileId', wrap(async (req, res) => {
    const f = await findFile(req.params.fileId);
    const a = availability(f);
    if (a === 'missing' || a === 'uploading') throw notFound('This link does not exist');
    if (a === 'expired') throw gone('file_expired', 'This file has expired and is no longer available');
    if (a === 'deleted') throw gone('file_deleted', 'This file has been deleted');
    res.set('Cache-Control', 'no-store').json(publicInfo(f!));
  }));

  r.get('/:fileId/status', wrap(async (req, res) => {
    const f = await findFile(req.params.fileId);
    const a = availability(f);
    if (a === 'missing' || a === 'uploading') throw notFound('This link does not exist');
    const code = a === 'ready' ? 200 : 410;
    res.status(code).set('Cache-Control', 'no-store').json({ status: a, expiresAt: f!.expiresAt });
  }));

  r.post('/:fileId/unlock', l.password, wrap(async (req, res) => {
    const { password } = z.object({ password: z.string().min(1).max(128) }).strict().parse(req.body);
    const { token } = await unlock(req.params.fileId, password);
    res.json({ token });
  }));

  const handleDownload = wrap(async (req, res) => {
    const f = await authorizeDownload(req.params.fileId, req.query.token, req.user);
    const total = f.size;

    let range: { start: number; end: number } | undefined;
    const header = req.headers.range;
    if (header && total > 0) {
      const parsed = rangeParser(total, header, { combine: true });
      if (parsed === -1) {
        res.status(416).set('Content-Range', `bytes */${total}`).json({ error: { code: 'range_not_satisfiable', message: 'Requested range not satisfiable' } });
        return;
      }
      if (Array.isArray(parsed) && parsed.type === 'bytes' && parsed.length === 1) range = parsed[0];
      // multi-range / malformed -> fall back to the full representation
    }

    if (req.method === 'GET') {
      const startsAtZero = !range || range.start === 0;
      if (f.downloadLimit != null || startsAtZero) {
        if (!(await consumeDownload(f.fileId))) {
          throw new HttpError(410, 'download_limit_reached', 'This file has reached its download limit');
        }
      }
    }

    const length = range ? range.end - range.start + 1 : total;
    let stream: Readable | undefined;
    if (req.method === 'GET' && length > 0) {
      try {
        stream = await storage().getStream(f.storageKey, range);
      } catch (e) {
        if (e instanceof StorageError && e.code === 'not_found') {
          await recordError('api', 'storage object missing for a ready file', { fileId: f.fileId });
          throw new HttpError(404, 'object_missing', 'The file is currently unavailable');
        }
        throw e;
      }
    }
    res.status(range ? 206 : 200);
    res.set({
      'Content-Type': downloadMime(f.extension),
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': contentDisposition(f.originalName, { type: 'attachment' }),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (f.checksumSha256) res.set('ETag', `"${f.checksumSha256}"`);
    if (range) res.set('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    if (!stream) return void res.end();
    pipeline(stream, res, () => stream.destroy());
    res.on('close', () => stream.destroy());
  });
  r.get('/:fileId/download', l.download, handleDownload);
  r.head('/:fileId/download', l.download, handleDownload);

  r.delete('/:fileId', wrap(async (req, res) => {
    const manageToken = req.get('x-manage-token') ?? undefined;
    res.json(await deleteFile(req.params.fileId, { user: req.user, manageToken }));
  }));
  return r;
}
