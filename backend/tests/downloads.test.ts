import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { boot, resetDb, shutdown, uploadViaApi, type Kit } from './testkit.js';
import { FileModel } from '../src/models/File.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(shutdown);
beforeEach(resetDb);

const bin = (r: request.Test) => r.buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

const content = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 20_000 }, (_, i) => i % 251))]);

describe('download metadata + streaming', () => {
  it('returns file info and streams the exact bytes as an attachment', async () => {
    const { fileId } = await uploadViaApi(kit.app, { name: 'My Report.pdf', content });
    const info = await request(kit.app).get(`/api/files/${fileId}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ name: 'My Report.pdf', size: content.length, passwordProtected: false, executableWarning: false });
    expect(JSON.stringify(info.body)).not.toMatch(/storageKey|objects|\/data\//);

    const dl = await bin(request(kit.app).get(`/api/files/${fileId}/download`));
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(content)).toBe(true);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    expect(dl.headers['content-disposition']).toContain('My Report.pdf');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
    expect(dl.headers['accept-ranges']).toBe('bytes');
    expect((await FileModel.findOne({ fileId }))!.downloadCount).toBe(1);
  });

  it('serves HTML and SVG as inert attachments, never as renderable content', async () => {
    for (const name of ['page.html', 'logo.svg']) {
      const { fileId } = await uploadViaApi(kit.app, { name, content: Buffer.from('<script>alert(1)</script>') });
      const dl = await request(kit.app).get(`/api/files/${fileId}/download`);
      expect(dl.headers['content-type']).toMatch(/application\/octet-stream/);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    }
  });

  it('flags executables and APKs for the trust warning', async () => {
    const exe = await uploadViaApi(kit.app, { name: 'setup.exe', content: Buffer.from('MZ\x90\x00 fake') });
    const apk = await uploadViaApi(kit.app, { name: 'app.apk', content: Buffer.from('PK\x03\x04 fake') });
    expect((await request(kit.app).get(`/api/files/${exe.fileId}`)).body.executableWarning).toBe(true);
    expect((await request(kit.app).get(`/api/files/${apk.fileId}`)).body.executableWarning).toBe(true);
  });

  it('encodes unicode and hostile filenames safely in Content-Disposition', async () => {
    const { fileId } = await uploadViaApi(kit.app, { name: 'résumé "final"\r\nX-Evil: 1.txt', content: Buffer.from('hi') });
    const dl = await request(kit.app).get(`/api/files/${fileId}/download`);
    expect(dl.headers['x-evil']).toBeUndefined();
    expect(dl.status).toBe(200);
  });
});

describe('HTTP Range', () => {
  let fileId: string;
  beforeEach(async () => {
    fileId = (await uploadViaApi(kit.app, { name: 'r.pdf', content })).fileId;
  });

  it('serves a byte range with 206 + Content-Range', async () => {
    const r = await bin(request(kit.app).get(`/api/files/${fileId}/download`).set('Range', 'bytes=100-199'));
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 100-199/${content.length}`);
    expect(r.headers['content-length']).toBe('100');
    expect((r.body as Buffer).equals(content.subarray(100, 200))).toBe(true);
  });
  it('supports open-ended and suffix ranges', async () => {
    const open = await bin(request(kit.app).get(`/api/files/${fileId}/download`).set('Range', `bytes=${content.length - 10}-`));
    expect((open.body as Buffer).equals(content.subarray(-10))).toBe(true);
    const suffix = await bin(request(kit.app).get(`/api/files/${fileId}/download`).set('Range', 'bytes=-50'));
    expect(suffix.status).toBe(206);
    expect((suffix.body as Buffer).equals(content.subarray(-50))).toBe(true);
  });
  it('returns 416 for unsatisfiable ranges', async () => {
    const r = await request(kit.app).get(`/api/files/${fileId}/download`).set('Range', `bytes=${content.length + 5}-`);
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe(`bytes */${content.length}`);
  });
  it('answers HEAD without a body and without counting a download', async () => {
    const r = await request(kit.app).head(`/api/files/${fileId}/download`);
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(content.length));
    expect((await FileModel.findOne({ fileId }))!.downloadCount).toBe(0);
  });
  it('does not count resumed (non-zero offset) ranges as new downloads', async () => {
    await request(kit.app).get(`/api/files/${fileId}/download`).set('Range', 'bytes=5000-');
    expect((await FileModel.findOne({ fileId }))!.downloadCount).toBe(0);
    await request(kit.app).get(`/api/files/${fileId}/download`);
    expect((await FileModel.findOne({ fileId }))!.downloadCount).toBe(1);
  });
});

describe('expired, deleted and missing files', () => {
  it('blocks downloads of expired files even if the worker has not run', async () => {
    const { fileId } = await uploadViaApi(kit.app, { content });
    await FileModel.updateOne({ fileId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(kit.storage.objects.size).toBe(1); // still physically present
    for (const path of ['', '/download', '/status']) {
      const r = await request(kit.app).get(`/api/files/${fileId}${path}`);
      expect(r.status).toBe(410);
    }
    expect((await request(kit.app).get(`/api/files/${fileId}`)).body.error.code).toBe('file_expired');
    expect((await request(kit.app).post(`/api/files/${fileId}/unlock`).send({ password: 'x' })).status).toBe(410);
  });
  it('returns 404 for unknown and malformed ids', async () => {
    expect((await request(kit.app).get('/api/files/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await request(kit.app).get('/api/files/..%2f..%2fetc')).status).toBe(404);
    expect((await request(kit.app).get('/api/files/short/download')).status).toBe(404);
  });
  it('does not extend expiry when downloaded', async () => {
    const { fileId } = await uploadViaApi(kit.app, { content });
    const before = (await FileModel.findOne({ fileId }))!.expiresAt.getTime();
    await request(kit.app).get(`/api/files/${fileId}/download`);
    await request(kit.app).get(`/api/files/${fileId}/download`);
    expect((await FileModel.findOne({ fileId }))!.expiresAt.getTime()).toBe(before);
  });
  it('reports status for a ready file', async () => {
    const { fileId } = await uploadViaApi(kit.app, { content });
    const r = await request(kit.app).get(`/api/files/${fileId}/status`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ready');
  });
});

describe('password protection and download limits', () => {
  it('stores only a hash and requires unlocking', async () => {
    const { fileId } = await uploadViaApi(kit.app, { content, password: 'hunter2-secret' });
    const stored = await FileModel.findOne({ fileId }).lean();
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(stored)).not.toContain('hunter2-secret');

    expect((await request(kit.app).get(`/api/files/${fileId}`)).body.passwordProtected).toBe(true);
    const blocked = await request(kit.app).get(`/api/files/${fileId}/download`);
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe('password_required');

    expect((await request(kit.app).post(`/api/files/${fileId}/unlock`).send({ password: 'wrong-password' })).status).toBe(401);
    const ok = await request(kit.app).post(`/api/files/${fileId}/unlock`).send({ password: 'hunter2-secret' });
    expect(ok.status).toBe(200);
    const dl = await bin(request(kit.app).get(`/api/files/${fileId}/download?token=${ok.body.token}`));
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(content)).toBe(true);
  });

  it('rejects tokens issued for another file or tampered tokens', async () => {
    const a = await uploadViaApi(kit.app, { content, password: 'password-a' });
    const b = await uploadViaApi(kit.app, { content, password: 'password-b' });
    const tok = (await request(kit.app).post(`/api/files/${a.fileId}/unlock`).send({ password: 'password-a' })).body.token;
    expect((await request(kit.app).get(`/api/files/${b.fileId}/download?token=${tok}`)).status).toBe(401);
    expect((await request(kit.app).get(`/api/files/${a.fileId}/download?token=${tok}x`)).status).toBe(401);
  });

  it('rate-limits password guessing', async () => {
    const strict = await boot({ RATE_LIMIT_PASSWORD_MAX: '3' });
    const { fileId } = await uploadViaApi(strict.app, { content, password: 'correct-horse' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(strict.app).post(`/api/files/${fileId}/unlock`).send({ password: `guess-${i}` })).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    // even the right password is throttled now
    expect((await request(strict.app).post(`/api/files/${fileId}/unlock`).send({ password: 'correct-horse' })).status).toBe(429);
    kit = await boot();
  });

  it('enforces download limits atomically', async () => {
    const { fileId } = await uploadViaApi(kit.app, { content, downloadLimit: 2 });
    expect((await request(kit.app).get(`/api/files/${fileId}`)).body.downloadsRemaining).toBe(2);
    const results = await Promise.all(Array.from({ length: 6 }, () => request(kit.app).get(`/api/files/${fileId}/download`)));
    expect(results.filter((r) => r.status === 200).length).toBe(2);
    expect(results.filter((r) => r.status === 410).length).toBe(4);
    expect((await FileModel.findOne({ fileId }))!.downloadCount).toBe(2);
  });
});
