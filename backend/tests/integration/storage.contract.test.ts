import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, afterAll } from 'vitest';
import { LocalStorage } from '../../src/storage/local.js';
import { S3Storage } from '../../src/storage/s3.js';
import type { StorageAdapter } from '../../src/storage/types.js';

/**
 * The same contract runs against every real provider. Local disk always runs; an
 * S3-compatible endpoint runs when S3_TEST_ENDPOINT / S3_TEST_BUCKET are set
 * (MinIO, moto, R2, AWS ...). No mocks here.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
const providers: Array<[string, () => StorageAdapter, number]> = [['local', () => new LocalStorage(tmp), 4096]];
if (process.env.S3_TEST_ENDPOINT && process.env.S3_TEST_BUCKET) {
  providers.push([
    's3',
    () =>
      new S3Storage({
        endpoint: process.env.S3_TEST_ENDPOINT,
        region: 'us-east-1',
        bucket: process.env.S3_TEST_BUCKET!,
        accessKeyId: process.env.S3_TEST_KEY ?? 'test',
        secretAccessKey: process.env.S3_TEST_SECRET ?? 'test',
        forcePathStyle: true,
        keyPrefix: `contract-${Date.now()}/`,
      }),
    5 * 1024 * 1024, // S3 minimum part size
  ]);
}
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.each(providers)('storage contract: %s', (_name, make, partSize) => {
  const s = make();
  const key = () => randomBytes(18).toString('base64url');
  const total = partSize * 2 + 1234; // 3 parts, last one short
  const data = randomBytes(total);
  const part = (n: number) => data.subarray((n - 1) * partSize, Math.min(n * partSize, total));

  it('assembles out-of-order parts into the exact object', async () => {
    const k = key();
    const id = await s.createMultipart(k, { partSize, totalSize: total });
    for (const n of [3, 1, 2]) {
      const r = await s.uploadPart(k, id, n, Readable.from([part(n)]), part(n).length);
      expect(r.size).toBe(part(n).length);
    }
    expect((await s.listParts(k, id)).map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(await s.stat(k)).toBeNull(); // not visible until completed
    expect(await s.completeMultipart(k, id, total, 3)).toEqual({ size: total });
    expect(await s.stat(k)).toEqual({ size: total });
    const chunks: Buffer[] = [];
    for await (const c of await s.getStream(k)) chunks.push(c as Buffer);
    expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    await s.delete(k);
    expect(await s.stat(k)).toBeNull();
    await s.delete(k); // idempotent
  });

  it('streams byte ranges, including across part boundaries', async () => {
    const k = key();
    const id = await s.createMultipart(k, { partSize, totalSize: total });
    for (const n of [1, 2, 3]) await s.uploadPart(k, id, n, Readable.from([part(n)]), part(n).length);
    await s.completeMultipart(k, id, total, 3);
    for (const [start, end] of [[0, 99], [partSize - 10, partSize + 10], [total - 5, total - 1], [7, 7]]) {
      const chunks: Buffer[] = [];
      for await (const c of await s.getStream(k, { start, end })) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).equals(data.subarray(start, end + 1))).toBe(true);
    }
    expect((await s.readHead(k, 16)).equals(data.subarray(0, 16))).toBe(true);
    await s.delete(k);
  });

  it('rejects wrong-sized parts and incomplete assemblies, and can recover', async () => {
    const k = key();
    const id = await s.createMultipart(k, { partSize, totalSize: total });
    await expect(s.uploadPart(k, id, 1, Readable.from([part(1).subarray(0, 100)]), part(1).length)).rejects.toThrow();
    await expect(s.uploadPart(k, id, 1, Readable.from([part(1), Buffer.alloc(5)]), part(1).length)).rejects.toThrow();
    await s.uploadPart(k, id, 1, Readable.from([part(1)]), part(1).length);
    await expect(s.completeMultipart(k, id, total, 3)).rejects.toThrow(/missing/);
    // recovery: resend the rest and finish
    await s.uploadPart(k, id, 2, Readable.from([part(2)]), part(2).length);
    await s.uploadPart(k, id, 3, Readable.from([part(3)]), part(3).length);
    await s.completeMultipart(k, id, total, 3);
    expect(await s.stat(k)).toEqual({ size: total });
    await s.delete(k);
  });

  it('aborts a multipart upload and frees its state', async () => {
    const k = key();
    const id = await s.createMultipart(k, { partSize, totalSize: total });
    await s.uploadPart(k, id, 1, Readable.from([part(1)]), part(1).length);
    await s.abortMultipart(k, id);
    await expect(s.listParts(k, id)).rejects.toThrow();
    await s.abortMultipart(k, id); // idempotent
    expect(await s.stat(k)).toBeNull();
  });

  it('refuses unsafe keys (path traversal)', async () => {
    if (s.name !== 'local') return;
    await expect(s.stat('../../etc/passwd')).rejects.toThrow();
    await expect(s.delete('../../../tmp/x')).rejects.toThrow();
  });

  it('passes its health check', async () => {
    await expect(s.healthCheck()).resolves.toBeUndefined();
  });
});
