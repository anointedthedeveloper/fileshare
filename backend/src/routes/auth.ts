import { Router } from 'express';
import { z } from 'zod';
import { wrap } from '../middleware/errors.js';
import { CSRF_COOKIE, endSession, login, register, startSession } from '../services/auth.js';
import type { Limiters } from '../middleware/rateLimit.js';
import { getSettings } from '../services/settings.js';

const creds = z.object({ email: z.string().email().max(254), password: z.string().min(8).max(128) }).strict();

const userView = (u: { _id: unknown; email: string; role: string }) => ({ id: String(u._id), email: u.email, role: u.role });

export function authRouter(l: Limiters) {
  const r = Router();
  r.post('/register', l.auth, wrap(async (req, res) => {
    const b = creds.parse(req.body);
    const u = await register(b.email, b.password);
    const csrfToken = startSession(res, u);
    res.status(201).json({ user: userView(u), csrfToken });
  }));
  r.post('/login', l.auth, wrap(async (req, res) => {
    const b = creds.parse(req.body);
    const u = await login(b.email, b.password);
    const csrfToken = startSession(res, u);
    res.json({ user: userView(u), csrfToken });
  }));
  r.post('/logout', (_req, res) => {
    endSession(res);
    res.status(204).end();
  });
  r.get('/me', wrap(async (req, res) => {
    const s = await getSettings();
    res.json({
      user: req.user ? userView(req.user) : null,
      csrfToken: req.user ? req.cookies?.[CSRF_COOKIE] ?? null : null,
      allowRegistration: s.allowRegistration,
    });
  }));
  return r;
}
