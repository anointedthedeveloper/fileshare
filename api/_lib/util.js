import { randomInt } from 'node:crypto';

export const MB = 1024 * 1024;
/** Hard cap 1 GB. MAX_FILE_MB can only lower it. */
export const MAX_BYTES = Math.min(Number(process.env.MAX_FILE_MB) || 1024, 1024) * MB;

/** Retention options in seconds. Longest is 3 days — nothing is ever kept longer. */
export const RETENTION = { '1h': 3600, '6h': 6 * 3600, '1d': 86400, '3d': 3 * 86400 };

// no 0/o/1/l/i so codes survive being read out loud or typed from a screen
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function makeCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
export const CODE_RE = /^[a-z0-9]{4,6}$/;

export function cleanName(raw) {
  let n = String(raw ?? '').normalize('NFC').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*‎‏‪-‮⁦-⁩]/g, '_').trim().replace(/^\.+/, '');
  return n.slice(0, 180) || 'file';
}

/** Only accept blobs that live in OUR store (store id is embedded in the token). */
export function isOurBlobUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.public.blob.vercel-storage.com')) return false;
    const storeId = /^vercel_blob_rw_([a-z0-9]+)_/i.exec(process.env.BLOB_READ_WRITE_TOKEN ?? '')?.[1];
    return storeId ? u.hostname.startsWith(storeId.toLowerCase() + '.') : true;
  } catch {
    return false;
  }
}

export function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

export function bodyOf(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body ?? {};
}

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
