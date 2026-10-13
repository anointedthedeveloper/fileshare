import { z } from 'zod';
import { config, HARD_MAX_FILE_BYTES, HARD_MAX_RETENTION_SECONDS, RETENTION_OPTIONS } from '../config.js';
import { SettingsModel } from '../models/Settings.js';

export interface EffectiveSettings {
  maxFileBytes: number;
  allowedRetentionKeys: string[];
  allowAnonymous: boolean;
  allowRegistration: boolean;
  storageQuotaBytes: number;
  uploadsPerHour: number;
  blockedExtensions: string[];
}

let cache: { at: number; value: EffectiveSettings } | undefined;

export function invalidateSettingsCache() {
  cache = undefined;
}

export async function getSettings(): Promise<EffectiveSettings> {
  if (cache && Date.now() - cache.at < 3000) return cache.value;
  const c = config();
  const doc = await SettingsModel.findOne({ key: 'global' }).lean();
  const value: EffectiveSettings = {
    maxFileBytes: Math.min(doc?.maxFileBytes ?? c.MAX_FILE_BYTES, HARD_MAX_FILE_BYTES),
    allowedRetentionKeys: doc?.allowedRetentionKeys?.length ? doc.allowedRetentionKeys : RETENTION_OPTIONS.map((o) => o.key),
    allowAnonymous: doc?.allowAnonymous ?? c.ALLOW_ANONYMOUS_UPLOADS,
    allowRegistration: doc?.allowRegistration ?? c.ALLOW_REGISTRATION,
    storageQuotaBytes: doc?.storageQuotaBytes ?? c.STORAGE_QUOTA_BYTES,
    uploadsPerHour: doc?.uploadsPerHour ?? c.UPLOADS_PER_HOUR,
    blockedExtensions: doc?.blockedExtensions ?? [],
  };
  cache = { at: Date.now(), value };
  return value;
}

export const settingsPatchSchema = z
  .object({
    maxFileBytes: z.number().int().positive().max(HARD_MAX_FILE_BYTES),
    allowedRetentionKeys: z.array(z.enum(RETENTION_OPTIONS.map((o) => o.key) as [string, ...string[]])).min(1),
    allowAnonymous: z.boolean(),
    allowRegistration: z.boolean(),
    storageQuotaBytes: z.number().int().positive(),
    uploadsPerHour: z.number().int().positive().max(100000),
    blockedExtensions: z.array(z.string().regex(/^[a-z0-9]{1,12}$/)).max(200),
  })
  .partial()
  .strict();

export async function updateSettings(patch: z.infer<typeof settingsPatchSchema>, actor: string) {
  await SettingsModel.updateOne({ key: 'global' }, { $set: { ...patch, updatedAt: new Date(), updatedBy: actor } }, { upsert: true });
  invalidateSettingsCache();
  return getSettings();
}

export { HARD_MAX_RETENTION_SECONDS };
