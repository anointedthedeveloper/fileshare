import { Schema, model } from 'mongoose';

const auditSchema = new Schema(
  {
    actorId: { type: String, required: true },
    actorEmail: { type: String },
    action: { type: String, required: true },
    target: { type: String },
    meta: { type: Schema.Types.Mixed },
    ip: { type: String },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
auditSchema.index({ at: -1 });
export const AuditLogModel = model('AuditLog', auditSchema);
