import mongoose from 'mongoose';
import { config } from './config.js';
import { logger } from './logger.js';
import { connectDb, syncIndexes } from './db.js';
import { startCleanupWorker, stopCleanupWorker } from './services/cleanup.js';

/** Standalone cleanup worker (run with RUN_WORKER_IN_API=false on the API for horizontal scaling). */
async function main() {
  await connectDb(config().MONGODB_URI);
  await syncIndexes();
  startCleanupWorker();
  logger.info('cleanup worker started');
  const stop = async () => {
    stopCleanupWorker();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}
main().catch((e) => {
  logger.error({ err: e?.message }, 'worker fatal');
  process.exit(1);
});
