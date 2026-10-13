import { Router } from 'express';
import mongoose from 'mongoose';
import { storage } from '../storage/index.js';

export const healthRouter = Router();
healthRouter.get('/live', (_req, res) => void res.json({ status: 'ok' }));
healthRouter.get('/ready', async (_req, res) => {
  const checks: Record<string, string> = {};
  try {
    await mongoose.connection.db!.admin().ping();
    checks.mongodb = 'ok';
  } catch {
    checks.mongodb = 'fail';
  }
  try {
    await storage().healthCheck();
    checks.storage = 'ok';
  } catch {
    checks.storage = 'fail';
  }
  const ok = Object.values(checks).every((v) => v === 'ok');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks });
});
