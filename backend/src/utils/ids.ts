import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Unpredictable URL-safe id with `bytes` of entropy (default 128 bit). */
export const randomId = (bytes = 16) => randomBytes(bytes).toString('base64url');
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
export const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
