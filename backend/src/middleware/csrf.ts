import type { RequestHandler } from 'express';
import { AUTH_COOKIE, CSRF_COOKIE } from '../services/auth.js';
import { HttpError } from '../utils/errors.js';
import { safeEqual } from '../utils/ids.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT = new Set(['/api/auth/login', '/api/auth/register']);

/**
 * Double-submit CSRF protection for cookie-authenticated requests. The token is
 * returned in the JSON body of login / me (readable only by our own origin under
 * CORS) and must be echoed in X-CSRF-Token. Requests with no auth cookie carry no
 * ambient authority, so they are not subject to CSRF.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE.has(req.method) || EXEMPT.has(req.path) || !req.cookies?.[AUTH_COOKIE]) return next();
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !safeEqual(cookie, header)) {
    return next(new HttpError(403, 'csrf_failed', 'Missing or invalid CSRF token'));
  }
  next();
};
