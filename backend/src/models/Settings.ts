import { Schema, model } from 'mongoose';

/** Singleton document holding admin-tunable policy. Env values are the defaults. */
const settingsSchema = new Schema(
  {
    key: { type: String, default: 'global', unique: true },
    maxFileBytes: { type: Number },
    allowedRetentionKeys: { type: [String] },
    allowAnonymous: { type: Boolean },
    allowRegistration: { type: Boolean },
    storageQuotaBytes: { type: Number },
    uploadsPerHour: { type: Number },
    blockedExtensions: { type: [String], default: [] },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String },
  },
  { versionKey: false },
);
export const SettingsModel = model('Settings', settingsSchema);
