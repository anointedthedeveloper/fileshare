import { files } from './_lib/db.js';
import { purgeExpired } from './_lib/purge.js';
import { send } from './_lib/util.js';

// Daily Vercel Cron: physically removes expired files, then their records.
// Harmless to call (it only deletes what already expired); if CRON_SECRET is set it must match.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'unauthorized' });
  send(res, 200, await purgeExpired(await files(), 500));
}
