import { AuditLogModel } from '../models/AuditLog.js';
import { logger } from '../logger.js';

export async function audit(
  actor: { id: string; email?: string },
  action: string,
  target?: string,
  meta?: Record<string, unknown>,
  ip?: string,
) {
  logger.info({ audit: true, actor: actor.id, action, target }, 'admin action');
  await AuditLogModel.create({ actorId: actor.id, actorEmail: actor.email, action, target, meta, ip });
}
