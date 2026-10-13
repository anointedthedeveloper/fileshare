import { Schema, model } from 'mongoose';

const errorSchema = new Schema(
  {
    source: { type: String, required: true }, // api | worker | storage
    message: { type: String, required: true },
    context: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
errorSchema.index({ createdAt: -1 });
errorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
export const ErrorLogModel = model('ErrorLog', errorSchema);
