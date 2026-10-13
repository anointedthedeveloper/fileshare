import { Schema, model, InferSchemaType, Types } from 'mongoose';

export const DELETION_STATUSES = ['none', 'pending', 'in_progress', 'failed', 'deleted'] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];

const fileSchema = new Schema(
  {
    fileId: { type: String, required: true, unique: true }, // public, unguessable share id
    originalName: { type: String, required: true, maxlength: 255 },
    storageKey: { type: String, required: true, unique: true }, // randomized, never derived from the name
    storageProvider: { type: String, enum: ['local', 's3'], required: true },
    size: { type: Number, required: true, min: 0 },
    mimeType: { type: String, required: true },
    extension: { type: String, default: '' },
    checksumSha256: { type: String },
    status: { type: String, enum: ['uploading', 'ready', 'deleted'], default: 'uploading' },

    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    uploaderHash: { type: String, required: true }, // HMAC of client IP, never the raw address
    scopeKey: { type: String, required: true },
    clientKey: { type: String }, // idempotency key supplied by the client
    manageTokenHash: { type: String }, // lets anonymous uploaders delete their own file

    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
    retentionSeconds: { type: Number, required: true },
    expiresAt: { type: Date, required: true },

    downloadCount: { type: Number, default: 0 },
    downloadLimit: { type: Number, default: null },
    passwordHash: { type: String, default: null },

    deletion: {
      status: { type: String, enum: DELETION_STATUSES, default: 'none' },
      reason: { type: String, enum: ['expired', 'user', 'admin', 'aborted', 'infected'] },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: { type: Date },
      lockedUntil: { type: Date },
      lastError: { type: String },
      deletedAt: { type: Date },
    },
    /** Set only once the object is gone from storage; the TTL index then purges the tombstone. */
    purgeAt: { type: Date },
  },
  { versionKey: false },
);

fileSchema.index({ ownerId: 1, createdAt: -1 });
fileSchema.index({ 'deletion.status': 1, expiresAt: 1 });
fileSchema.index({ 'deletion.status': 1, 'deletion.nextAttemptAt': 1 });
fileSchema.index({ uploaderHash: 1, createdAt: -1 });
fileSchema.index({ status: 1, size: 1 });
fileSchema.index({ scopeKey: 1, clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });
// Supplementary cleanup only: purgeAt is written after the storage object has been deleted.
fileSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type FileDoc = InferSchemaType<typeof fileSchema> & { _id: Types.ObjectId };
export const FileModel = model('File', fileSchema);
