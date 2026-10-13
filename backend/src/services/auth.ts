import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { config } from '../config.js';
import { UserModel, type UserDoc } from '../models/User.js';
import { randomId } from '../utils/ids.js';
import { conflict, unauthorized, forbidden } from '../utils/errors.js';
import { getSettings } from './settings.js';
import { logger } from '../logger.js';

export const AUTH_COOKIE = 'fs_token';
export const CSRF_COOKIE = 'fs_csrf';
const BCRYPT_COST = () => (config().NODE_ENV === 'test' ? 4 : 12);

export const hashPassword = (p: string) => bcrypt.hash(p, BCRYPT_COST());
export const verifyPassword = (p: string, h: string) => bcrypt.compare(p, h);

export function signSession(user: UserDoc) {
  const c = config();
  return jwt.sign({ role: user.role }, c.JWT_SECRET, {
    subject: String(user._id),
    expiresIn: `${c.SESSION_DAYS}d`,
    issuer: 'fileshare',
    algorithm: 'HS256',
  });
}

export async function userFromToken(token: string | undefined): Promise<UserDoc | undefined> {
  if (!token) return undefined;
  try {
    const p = jwt.verify(token, config().JWT_SECRET, { issuer: 'fileshare', algorithms: ['HS256'] }) as jwt.JwtPayload;
    const u = await UserModel.findById(p.sub).lean();
    if (!u || u.disabled) return undefined;
    return u as UserDoc;
  } catch {
    return undefined;
  }
}

export function cookieOpts() {
  const c = config();
  return {
    httpOnly: true,
    secure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
    sameSite: c.COOKIE_SAMESITE,
    domain: c.COOKIE_DOMAIN,
    path: '/',
  } as const;
}

/** Issues the auth cookie plus a CSRF token (cookie + returned in JSON for double-submit). */
export function startSession(res: Response, user: UserDoc) {
  const c = config();
  const maxAge = c.SESSION_DAYS * 24 * 3600 * 1000;
  const csrf = randomId(24);
  res.cookie(AUTH_COOKIE, signSession(user), { ...cookieOpts(), maxAge });
  res.cookie(CSRF_COOKIE, csrf, { ...cookieOpts(), maxAge });
  return csrf;
}
export function endSession(res: Response) {
  res.clearCookie(AUTH_COOKIE, cookieOpts());
  res.clearCookie(CSRF_COOKIE, cookieOpts());
}

export async function register(email: string, password: string) {
  if (!(await getSettings()).allowRegistration) throw forbidden('Registration is disabled');
  try {
    const u = await UserModel.create({ email, passwordHash: await hashPassword(password), role: 'user' });
    return u.toObject() as UserDoc;
  } catch (e: any) {
    if (e?.code === 11000) throw conflict('email_taken', 'An account with this email already exists');
    throw e;
  }
}

// Dummy hash so unknown emails take as long as wrong passwords (no user enumeration by timing).
const DUMMY = bcrypt.hashSync('not-a-real-password', 4);

export async function login(email: string, password: string) {
  const u = await UserModel.findOne({ email: email.toLowerCase() });
  const ok = await verifyPassword(password, u?.passwordHash ?? DUMMY);
  if (!u || !ok || u.disabled) throw unauthorized('Invalid email or password');
  u.lastLoginAt = new Date();
  await u.save();
  return u.toObject() as UserDoc;
}

/** Creates the bootstrap admin from ADMIN_EMAIL / ADMIN_PASSWORD if missing. */
export async function ensureAdmin() {
  const c = config();
  if (!c.ADMIN_EMAIL || !c.ADMIN_PASSWORD) return;
  const email = c.ADMIN_EMAIL.toLowerCase();
  const existing = await UserModel.findOne({ email });
  if (existing) {
    if (existing.role !== 'admin') {
      existing.role = 'admin';
      await existing.save();
    }
    return;
  }
  await UserModel.create({ email, passwordHash: await hashPassword(c.ADMIN_PASSWORD), role: 'admin' });
  logger.info({ email }, 'bootstrap admin created');
}
