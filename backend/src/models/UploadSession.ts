import { Schema, model, InferSchemaType, Types } from 'mongoose';

const sessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    fileId: { type: String, required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    uploaderHash: { type: String, required: true },
    filename: { type: String, required: true },
    extension: { type: String, default: '' },
    declaredMime: { type: String, default: '' },
    expectedSize: { type: Number, required: true },
    partSize: { type: Number, required: true },
    totalParts: { type: Number, required: true },
    storageKey: { type: String, required: true },
    storageUploadId: { type: String, required: true }, // provider multipart-upload identifier
    parts: [
      new Schema(
        { partNumber: Number, size: Number, etag: String, at: { type: Date, default: Date.now } },
        { _id: false },
      ),
    ],
    status: { type: String, enum: ['active', 'completing', 'completed', 'aborted', 'failed'], default: 'active' },
    error: { type: String },
    /** True once storage-side multipart state / partial objects have been released. */
    released: { type: Boolean, default: false },
    lockedUntil: { type: Date },
    lastActivityAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    purgeAt: { type: Date },
  },
  { versionKey: false },
);

sessionSchema.index({ status: 1, expiresAt: 1 });
sessionSchema.index({ status: 1, lastActivityAt: 1 });
sessionSchema.index({ status: 1, released: 1 });
sessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = InferSchemaType<typeof sessionSchema> & { _id: Types.ObjectId };
export const UploadSessionModel = model('UploadSession', sessionSchema);
