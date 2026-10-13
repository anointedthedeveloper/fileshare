import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, type ZodType } from 'zod';
import { HttpError } from '../utils/errors.js';
import { recordError } from '../db.js';
import { StorageError } from '../storage/types.js';
import { logger } from '../logger.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
};

/** Consistent error envelope: { error: { code, message, details? } } */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // The client went away mid-request (cancelled upload, closed tab): not a server fault.
  if (err?.code === 'ECONNRESET' || err?.code === 'ECONNABORTED' || err?.message === 'aborted' || req.socket?.destroyed) {
    logger.debug({ path: req.path }, 'request aborted by client');
    res.destroy();
    return;
  }
  if (err instanceof ZodError) {
    return void res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof HttpError) {
    return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof StorageError && err.code === 'part_size_mismatch') {
    return void res.status(400).json({ error: { code: 'invalid_part_size', message: err.message } });
  }
  if (err?.type === 'entity.parse.failed') {
    return void res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
  }
  if (err?.type === 'entity.too.large') {
    return void res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
  }
  void recordError('api', err?.message ?? 'unhandled error', { path: req.path, method: req.method, stack: err?.stack });
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
};

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

export const wrap =
  (fn: (req: any, res: any, next: any) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
