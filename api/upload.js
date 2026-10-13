import { handleUpload } from '@vercel/blob/client';
import { MAX_BYTES, bodyOf, send } from './_lib/util.js';

// Issues short-lived tokens so the BROWSER uploads straight to Blob storage
// (serverless functions can't accept large bodies). The size cap is enforced by Blob itself.
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  try {
    const json = await handleUpload({
      body: bodyOf(req),
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^f\/[A-Za-z0-9-]{36}\/[^/]{1,200}$/.test(pathname)) throw new Error('Invalid file path');
        return { maximumSizeInBytes: MAX_BYTES, addRandomSuffix: false, allowOverwrite: false };
      },
      onUploadCompleted: async () => {},
    });
    res.status(200).setHeader('Cache-Control', 'no-store').json(json);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}
