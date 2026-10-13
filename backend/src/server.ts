import http from 'node:http';
import mongoose from 'mongoose';
import { config } from './config.js';
import { logger } from './logger.js';
import { connectDb, syncIndexes } from './db.js';
import { createApp } from './app.js';
import { ensureAdmin } from './services/auth.js';
import { startCleanupWorker, stopCleanupWorker } from './services/cleanup.js';
import { UploadSessionModel } from './models/UploadSession.js';

async function main() {
  const c = config();
  await connectDb(c.MONGODB_URI);
  await syncIndexes();
  await ensureAdmin();

  const server = http.createServer(createApp());
  // Parts are 8 MiB+, but clients may be slow: never time out an in-flight part body early.
  server.requestTimeout = 30 * 60_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  if (c.RUN_WORKER_IN_API) startCleanupWorker();
  server.listen(c.PORT, () => logger.info({ port: c.PORT, storage: c.STORAGE_PROVIDER }, 'api listening'));

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    logger.info({ sig }, 'shutting down');
    stopCleanupWorker();
    server.close();
    const force = setTimeout(() => process.exit(1), 25_000).unref();
    try {
      // Sessions keep their uploaded parts so clients can resume after restart; only
      // sessions stuck mid-finalisation are handed back to the worker.
      await UploadSessionModel.updateMany({ status: 'completing' }, { $set: { status: 'active' }, $unset: { lockedUntil: 1 } });
      await mongoose.disconnect();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
}

main().catch((e) => {
  logger.error({ err: e?.message }, 'fatal startup error');
  process.exit(1);
});
