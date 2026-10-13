import mongoose from 'mongoose';
import { logger } from './logger.js';
import { FileModel } from './models/File.js';
import { UploadSessionModel } from './models/UploadSession.js';
import { UserModel } from './models/User.js';
import { SettingsModel } from './models/Settings.js';
import { AuditLogModel } from './models/AuditLog.js';
import { ErrorLogModel } from './models/ErrorLog.js';

export async function connectDb(uri: string) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info('mongodb connected');
}

export async function syncIndexes() {
  for (const m of [FileModel, UploadSessionModel, UserModel, SettingsModel, AuditLogModel, ErrorLogModel]) {
    await m.syncIndexes();
  }
}

export async function recordError(source: string, message: string, context?: unknown) {
  logger.error({ source, context }, message);
  try {
    if (mongoose.connection.readyState === 1) {
      await ErrorLogModel.create({ source, message: message.slice(0, 500), context });
    }
  } catch {
    /* never let error recording throw */
  }
}
