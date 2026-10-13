import { Router } from 'express';
import { wrap } from '../middleware/errors.js';
import { abortUpload, completeUpload, getSession, initiateSchema, initiateUpload, receivePart } from '../services/uploads.js';
import type { Limiters } from '../middleware/rateLimit.js';
import { ID_RE } from '../utils/ids.js';
import { notFound } from '../utils/errors.js';

export function uploadsRouter(l: Limiters) {
  const r = Router();
  r.param('sessionId', (_req, _res, next, id) => (ID_RE.test(id) ? next() : next(notFound('Upload session not found'))));
  const actor = (req: any) => ({ user: req.user, clientId: req.clientId });

  r.post('/initiate', wrap(async (req, res) => {
    const body = initiateSchema.parse(req.body);
    const out = await initiateUpload(body, actor(req));
    res.status(out.resumed ? 200 : 201).json(out);
  }));

  r.get('/:sessionId', wrap(async (req, res) => {
    res.json(await getSession(req.params.sessionId, actor(req)));
  }));

  // Raw binary part body (application/octet-stream), streamed straight to storage.
  r.post('/:sessionId/parts', l.parts, async (req, res, next) => {
    try {
      const partNumber = Number(req.query.partNumber);
      const len = req.headers['content-length'];
      const out = await receivePart(req.params.sessionId, partNumber, req, len !== undefined ? Number(len) : undefined, actor(req));
      res.json(out);
    } catch (e) {
      req.resume(); // discard the unread body so the error response can be delivered
      next(e);
    }
  });

  r.post('/:sessionId/complete', wrap(async (req, res) => {
    const out = await completeUpload(req.params.sessionId, actor(req));
    if (out.state === 'processing') return void res.status(202).json({ state: 'processing' });
    res.json(out);
  }));

  r.delete('/:sessionId', wrap(async (req, res) => {
    await abortUpload(req.params.sessionId, actor(req));
    res.status(204).end();
  }));
  return r;
}
