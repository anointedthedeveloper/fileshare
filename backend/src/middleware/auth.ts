import type { RequestHandler } from 'express';
import { AUTH_COOKIE, userFromToken } from '../services/auth.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import { hmac } from '../utils/ids.js';
import { config } from '../config.js';

/** Derives an opaque per-client identifier (never stores the raw IP). */
export const clientId: RequestHandler = (req, _res, next) => {
  req.clientId = hmac(config().JWT_SECRET, `ip:${req.ip ?? 'unknown'}`).slice(0, 32);
  next();
};

/** Attaches req.user when a valid auth cookie is present; anonymous otherwise. */
export const attachUser: RequestHandler = async (req, _res, next) => {
  try {
    req.user = await userFromToken(req.cookies?.[AUTH_COOKIE]);
    next();
  } catch (e) {
    next(e);
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => (req.user ? next() : next(unauthorized()));
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('Administrator access required'));
  next();
};
