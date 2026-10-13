import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { loadConfig, setConfig, GB } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { createStorage } from '../../src/storage/index.js';
import { setStorage } from '../../src/storage/index.js';
import { syncIndexes } from '../../src/db.js';
import { FileModel } from '../../src/models/File.js';
import { runCleanupOnce } from '../../src/services/cleanup.js';
import { LocalStorage } from '../../src/storage/local.js';
import path from 'node:path';

/**
 * Real HTTP server + real MongoDB + the configured real storage provider
 * (STORAGE_PROVIDER=local by default; set S3_* to target an S3-compatible service).
 * Set RUN_LARGE_FILE_TEST=1 to push a genuine 3 GB file through it.
 */
const PART = 8 * 1024 * 1024;
let server: http.Server;
let base: string;
let storage: ReturnType<typeof createStorage>;

beforeAll(async () => {
  const overrides: Record<string, string> = { PART_SIZE_BYTES: String(PART), COMPUTE_CHECKSUM: 'true' };
  if (process.env.S3_TEST_ENDPOINT) {
    Object.assign(overrides, {
      STORAGE_PROVIDER: 's3',
      S3_ENDPOINT: process.env.S3_TEST_ENDPOINT,
      S3_BUCKET: process.env.S3_TEST_BUCKET ?? 'fileshare-test',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test',
      S3_FORCE_PATH_STYLE: 'true',
      S3_KEY_PREFIX: `e2e-${Date.now()}/`,
    });
  }
  setConfig(loadConfig({ ...process.env, ...overrides }));
  await mongoose.connect(process.env.TEST_MONGO_URI!, { dbName: `e2e_${Date.now()}` });
  await syncIndexes();
  storage = createStorage();
  setStorage(storage);
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

const block = (n: number, size: number) => {
  const b = Buffer.alloc(size, n % 251);
  b.writeUInt32BE(n, 0);
  for (let i = 8; i < Math.min(size, 4096); i++) b[i] = (i * 31 + n) & 0xff;
  return b;
};

async function api(p: string, init: RequestInit = {}) {
  const r = await fetch(base + p, init);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

async function uploadSynthetic(name: string, size: number, retention = '1h', concurrency = 3) {
  const init = await api('/api/uploads/initiate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: name, size, retention }),
  });
  expect(init.status).toBe(201);
  const s = init.body;
  const partBuf = (n: number) => {
    const len = n < s.totalParts ? s.partSize : size - s.partSize * (s.totalParts - 1);
    return block(n, len);
  };
  const expected = createHash('sha256');
  for (let n = 1; n <= s.totalParts; n++) expected.update(partBuf(n));

  let next = 1;
  const worker = async () => {
    while (next <= s.totalParts) {
      const n = next++;
      const r = await fetch(`${base}/api/uploads/${s.sessionId}/parts?partNumber=${n}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: partBuf(n),
      });
      if (r.status !== 200) throw new Error(`part ${n} -> ${r.status} ${await r.text()}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  let done = await api(`/api/uploads/${s.sessionId}/complete`, { method: 'POST' });
  while (done.status === 202) {
    await new Promise((r) => setTimeout(r, 1000));
    done = await api(`/api/uploads/${s.sessionId}/complete`, { method: 'POST' });
  }
  expect(done.status).toBe(200);
  return { s, file: done.body.file, sha: expected.digest('hex'), partBuf };
}

async function sha256OfDownload(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const h = createHash('sha256');
  let n = 0;
  for await (const c of r.body as unknown as AsyncIterable<Buffer>) {
    h.update(c);
    n += c.length;
  }
  return { status: r.status, sha: h.digest('hex'), bytes: n, headers: r.headers };
}

describe('end-to-end over real HTTP + real storage', () => {
  it('uploads 40 MB in parallel parts, verifies the checksum, downloads and range-reads it', async () => {
    const size = 40 * 1024 * 1024 + 321;
    const { file, sha } = await uploadSynthetic('payload.bin', size);
    const stored = await FileModel.findOne({ fileId: file.fileId }).lean();
    expect(stored!.checksumSha256).toBe(sha);
    expect(stored!.size).toBe(size);

    const full = await sha256OfDownload(`${base}/api/files/${file.fileId}/download`);
    expect(full.status).toBe(200);
    expect(full.bytes).toBe(size);
    expect(full.sha).toBe(sha);

    // range straddling a part boundary
    const start = PART - 100;
    const r = await fetch(`${base}/api/files/${file.fileId}/download`, { headers: { Range: `bytes=${start}-${start + 199}` } });
    expect(r.status).toBe(206);
    const buf = Buffer.from(await r.arrayBuffer());
    const expected = Buffer.concat([block(1, PART).subarray(PART - 100), block(2, PART).subarray(0, 100)]);
    expect(buf.equals(expected)).toBe(true);
  });

  it('physically removes an expired file from storage and removes its records', async () => {
    const { file } = await uploadSynthetic('short.bin', 3 * 1024 * 1024);
    const stored = await FileModel.findOne({ fileId: file.fileId }).lean();
    expect(await storage.stat(stored!.storageKey)).toEqual({ size: 3 * 1024 * 1024 });
    await FileModel.updateOne({ fileId: file.fileId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await fetch(`${base}/api/files/${file.fileId}/download`)).status).toBe(410); // blocked before cleanup
    expect(await storage.stat(stored!.storageKey)).not.toBeNull();

    const stats = await runCleanupOnce();
    expect(stats.deleted).toBeGreaterThanOrEqual(1);
    expect(await storage.stat(stored!.storageKey)).toBeNull(); // really gone from disk / bucket
    if (storage instanceof LocalStorage) {
      const root = process.env.LOCAL_STORAGE_PATH!;
      const onDisk = path.join(root, 'objects', stored!.storageKey.slice(0, 2), stored!.storageKey);
      expect(fs.existsSync(onDisk)).toBe(false);
    }
    await FileModel.updateOne({ fileId: file.fileId }, { $set: { purgeAt: new Date(Date.now() - 1) } });
    await runCleanupOnce();
    expect(await FileModel.countDocuments({ fileId: file.fileId })).toBe(0);
  });

  it('cleans up the partial data of an abandoned upload', async () => {
    const init = await api('/api/uploads/initiate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'abandon.bin', size: 3 * PART, retention: '1h' }),
    });
    const sid = init.body.sessionId;
    await fetch(`${base}/api/uploads/${sid}/parts?partNumber=1`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: block(1, PART) });
    expect(await FileModel.countDocuments({ status: 'uploading' })).toBe(1);
    expect((await fetch(`${base}/api/uploads/${sid}`, { method: 'DELETE' })).status).toBe(204);
    expect(await FileModel.countDocuments({ status: 'uploading' })).toBe(0);
    expect((await api(`/api/uploads/${sid}`)).body.status).toBe('aborted');
  });

  it.runIf(process.env.RUN_LARGE_FILE_TEST === '1')(
    'uploads, stores and downloads a genuine 3 GB file with streaming only',
    async () => {
      const size = 3 * GB;
      const t0 = Date.now();
      const { file, sha, s } = await uploadSynthetic('three-gigabytes.bin', size, '1h', 4);
      const upSecs = (Date.now() - t0) / 1000;
      expect(s.totalParts).toBe(384);
      expect(file.size).toBe(size);
      const stored = await FileModel.findOne({ fileId: file.fileId }).lean();
      expect(stored!.checksumSha256).toBe(sha);
      expect(await storage.stat(stored!.storageKey)).toEqual({ size });

      const t1 = Date.now();
      const full = await sha256OfDownload(`${base}/api/files/${file.fileId}/download`);
      expect(full.status).toBe(200);
      expect(full.bytes).toBe(size);
      expect(full.sha).toBe(sha);
      // resume: last 1 MiB via Range
      const tail = await sha256OfDownload(`${base}/api/files/${file.fileId}/download`, { headers: { Range: `bytes=${size - 1048576}-` } });
      expect(tail.status).toBe(206);
      expect(tail.bytes).toBe(1048576);
      // one byte more than 3 GB must be refused regardless of the client
      const over = await api('/api/uploads/initiate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'x.bin', size: size + 1, retention: '1h' }) });
      expect(over.status).toBe(413);
      console.log(`3 GB: upload+verify ${upSecs.toFixed(0)}s, download ${((Date.now() - t1) / 1000).toFixed(0)}s, sha256 ${sha}`);

      await FileModel.updateOne({ fileId: file.fileId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await runCleanupOnce();
      expect(await storage.stat(stored!.storageKey)).toBeNull();
    },
    45 * 60_000,
  );
});
