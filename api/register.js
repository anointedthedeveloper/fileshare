import { head, del } from '@vercel/blob';
import { files } from './_lib/db.js';
import { MAX_BYTES, RETENTION, bodyOf, cleanName, isOurBlobUrl, makeCode, send } from './_lib/util.js';
import { purgeExpired } from './_lib/purge.js';

// Called after the browser finished uploading: verifies the blob and mints the short code.
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const { url, name, retention } = bodyOf(req);
  const seconds = RETENTION[retention];
  if (!seconds) return send(res, 400, { error: 'Pick 1 hour, 6 hours, 1 day or 3 days.' });
  if (!isOurBlobUrl(url)) return send(res, 400, { error: 'Unknown file.' });

  let meta;
  try {
    meta = await head(url);
  } catch {
    return send(res, 400, { error: 'Upload not found. Please try again.' });
  }
  if (meta.size > MAX_BYTES || meta.size === 0) {
    await del(url).catch(() => {});
    return send(res, 413, { error: `Files must be between 1 byte and ${Math.round(MAX_BYTES / 1048576)} MB.` });
  }

  const col = await files();
  const now = new Date();
  const doc = {
    name: cleanName(name),
    size: meta.size,
    url,
    createdAt: now,
    expiresAt: new Date(now.getTime() + seconds * 1000),
  };
  // 4 characters; on the rare collision retry, then grow to 5 so we never loop forever
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = makeCode(attempt < 8 ? 4 : 5);
    try {
      await col.insertOne({ ...doc, code });
      await purgeExpired(col, 5).catch(() => {}); // opportunistic cleanup on top of the daily cron
      return send(res, 200, { code, name: doc.name, size: doc.size, expiresAt: doc.expiresAt });
    } catch (e) {
      if (e?.code !== 11000) throw e;
    }
  }
  return send(res, 503, { error: 'Could not allocate a link. Try again.' });
}
