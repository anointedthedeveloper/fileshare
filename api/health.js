import { getDb } from './_lib/db.js';

// Open /api/health in the browser to see what is (not) configured. Never prints secrets.
export default async function handler(_req, res) {
  const out = {
    mongoUriSet: !!process.env.MONGODB_URI,
    blobTokenSet: !!process.env.BLOB_READ_WRITE_TOKEN,
    mongo: 'skipped',
    problems: [],
  };
  if (!out.blobTokenSet) out.problems.push('Blob storage is not connected: Vercel project → Storage → create a Blob store and connect it, then redeploy.');
  if (!out.mongoUriSet) out.problems.push('MONGODB_URI is missing: add it under Settings → Environment Variables, then redeploy.');
  else {
    try {
      const db = await Promise.race([getDb(), new Promise((_, r) => setTimeout(() => r(new Error('timed out')), 9000))]);
      await db.command({ ping: 1 });
      out.mongo = 'ok';
    } catch (e) {
      out.mongo = 'failed';
      out.problems.push(`Cannot reach MongoDB (${String(e.message).replace(/mongodb(\+srv)?:\/\/\S+/g, '[uri]').slice(0, 160)}). In Atlas → Network Access allow 0.0.0.0/0, and check the password.`);
    }
  }
  res.status(out.problems.length ? 503 : 200).setHeader('Cache-Control', 'no-store').json(out);
}
