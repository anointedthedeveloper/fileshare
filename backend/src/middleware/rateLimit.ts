import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Config } from '../config.js';

const handler = (code: string, message: string) => (_req: any, res: any) =>
  res.status(429).json({ error: { code, message } });

/**
 * In-process limiters (per instance). For multi-instance deployments put a shared
 * limiter at the reverse proxy / CDN; hourly upload quotas are additionally
 * enforced via MongoDB and therefore are shared across instances.
 */
export function buildLimiters(c: Config) {
  const base = { windowMs: c.RATE_LIMIT_WINDOW_MS, standardHeaders: true, legacyHeaders: false } as const;
  return {
    api: rateLimit({ ...base, limit: c.RATE_LIMIT_API_MAX, handler: handler('rate_limited', 'Too many requests, slow down.') }),
    parts: rateLimit({ ...base, limit: c.RATE_LIMIT_PARTS_MAX, handler: handler('rate_limited', 'Too many upload requests, slow down.') }),
    download: rateLimit({ ...base, limit: c.RATE_LIMIT_DOWNLOAD_MAX, handler: handler('rate_limited', 'Too many download requests, slow down.') }),
    auth: rateLimit({ ...base, windowMs: 15 * 60_000, limit: c.RATE_LIMIT_AUTH_MAX, handler: handler('rate_limited', 'Too many attempts. Try again later.') }),
    password: rateLimit({
      ...base,
      windowMs: 15 * 60_000,
      limit: c.RATE_LIMIT_PASSWORD_MAX,
      keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${req.params.fileId}`,
      handler: handler('rate_limited', 'Too many password attempts. Try again later.'),
    }),
  };
}
export type Limiters = ReturnType<typeof buildLimiters>;
