import { del } from '@vercel/blob';

/** Deletes expired files from Blob storage first, then their records. Safe to call anytime. */
export async function purgeExpired(col, limit = 100, now = new Date()) {
  const expired = await col.find({ expiresAt: { $lte: now } }).limit(limit).toArray();
  let deleted = 0;
  let failed = 0;
  for (const f of expired) {
    try {
      await del(f.url); // already-missing blobs are not an error
      await col.deleteOne({ _id: f._id });
      deleted++;
    } catch {
      failed++; // record stays, next run retries
    }
  }
  return { deleted, failed };
}
