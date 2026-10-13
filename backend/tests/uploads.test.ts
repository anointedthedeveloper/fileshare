import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { boot, resetDb, shutdown, uploadViaApi, PDF, type Kit } from './testkit.js';
import { FileModel } from '../src/models/File.js';
import { UploadSessionModel } from '../src/models/UploadSession.js';
import { GB } from '../src/config.js';
import { SettingsModel } from '../src/models/Settings.js';
import { invalidateSettingsCache } from '../src/services/settings.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(shutdown);
beforeEach(resetDb);

const octet = (r: request.Test) => r.set('Content-Type', 'application/octet-stream');

describe('small file upload', () => {
  it('uploads, finalises and returns a share link payload', async () => {
    const r = await uploadViaApi(kit.app, { name: 'report.pdf' });
    expect(r.done!.status).toBe(200);
    const { file } = r.done!.body;
    const manageToken = r.init.body.manageToken;
    expect(file.name).toBe('report.pdf');
    expect(file.size).toBe(r.content!.length);
    expect(manageToken).toBeTruthy();
    const delta = new Date(file.expiresAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(86400_000 - 10_000);
    expect(delta).toBeLessThanOrEqual(86400_000);
    const stored = await FileModel.findOne({ fileId: file.fileId }).lean();
    expect(stored?.status).toBe('ready');
    expect(stored?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.storageKey).not.toContain('report'); // randomized key
    expect(kit.storage.objects.get(stored!.storageKey)!.equals(r.content!)).toBe(true);
  });

  it('does not expose the file before completion', async () => {
    const content = PDF();
    const init = await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.pdf', size: content.length, retention: '1d' });
    expect(init.status).toBe(201);
    const f = await FileModel.findOne().lean();
    expect((await request(kit.app).get(`/api/files/${f!.fileId}`)).status).toBe(404);
    expect((await request(kit.app).get(`/api/files/${f!.fileId}/download`)).status).toBe(404);
  });

  it.each(['exe', 'apk', 'zip', 'png'])('accepts %s with a valid signature', async (ext) => {
    const sig: Record<string, Buffer> = {
      exe: Buffer.from('MZ\x90\x00'), apk: Buffer.from('PK\x03\x04'), zip: Buffer.from('PK\x03\x04'),
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };
    const r = await uploadViaApi(kit.app, { name: `file.${ext}`, content: Buffer.concat([sig[ext], Buffer.alloc(5000, 1)]) });
    expect(r.done!.status).toBe(200);
  });
});

describe('validation', () => {
  it('rejects files over the 3 GB limit on the server', async () => {
    const r = await request(kit.app).post('/api/uploads/initiate').send({ filename: 'huge.bin', size: 3 * GB + 1, retention: '1d' });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('file_too_large');
    const ok = await request(kit.app).post('/api/uploads/initiate').send({ filename: 'huge.bin', size: 3 * GB, retention: '1d' });
    expect(ok.status).toBe(201); // exactly 3 GB is allowed (nothing is allocated until parts arrive)
    expect(ok.body.totalParts).toBe(Math.ceil((3 * GB) / ok.body.partSize));
  });

  it('rejects retention beyond 30 days even when called directly', async () => {
    for (const body of [{ retentionSeconds: 30 * 86400 + 1 }, { retention: '31d' }, { retention: '90d' }]) {
      const r = await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.txt', size: 10, ...body });
      expect(r.status).toBe(400);
    }
    const r = await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.txt', size: 10, retention: '30d' });
    expect(r.status).toBe(201);
    const f = await FileModel.findOne().lean();
    expect(f!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 86400_000);
  });

  it('refuses client-supplied expiresAt / owner / mime fields', async () => {
    const r = await request(kit.app)
      .post('/api/uploads/initiate')
      .send({ filename: 'a.txt', size: 10, retention: '1h', expiresAt: '2099-01-01', ownerId: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
  });

  it.each([
    [{ filename: '', size: 5, retention: '1d' }],
    [{ filename: 'a.txt', size: 0, retention: '1d' }],
    [{ filename: 'a.txt', size: -4, retention: '1d' }],
    [{ filename: 'a.txt', size: 1.5, retention: '1d' }],
    [{ filename: '..', size: 5, retention: '1d' }],
    [{ filename: 'a.txt', size: 5 }],
    [{ filename: 'a.png', size: 5, retention: '1d', mimeType: 'video/mp4' }],
  ])('rejects invalid metadata %j', async (body) => {
    const r = await request(kit.app).post('/api/uploads/initiate').send(body);
    expect(r.status).toBe(400);
  });

  it('sanitises path traversal in the stored filename', async () => {
    const r = await uploadViaApi(kit.app, { name: '../../etc/passwd.txt', content: Buffer.from('hello') });
    expect(r.done!.body.file.name).toBe('passwd.txt');
  });

  it('rejects content whose signature contradicts the extension, at the first part', async () => {
    const r = await uploadViaApi(kit.app, { name: 'fake.pdf', content: Buffer.concat([Buffer.from('MZ\x90'), Buffer.alloc(6000)]) });
    expect(r.part!.status).toBe(415);
    expect(r.part!.body.error.code).toBe('signature_mismatch');
  });

  it('enforces admin-blocked extensions', async () => {
    await SettingsModel.create({ key: 'global', blockedExtensions: ['scr'] });
    invalidateSettingsCache();
    const r = await request(kit.app).post('/api/uploads/initiate').send({ filename: 'x.scr', size: 5, retention: '1d' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('unsupported_type');
  });

  it('blocks anonymous uploads when the administrator disables them', async () => {
    await SettingsModel.create({ key: 'global', allowAnonymous: false });
    invalidateSettingsCache();
    const r = await request(kit.app).post('/api/uploads/initiate').send({ filename: 'x.txt', size: 5, retention: '1d' });
    expect(r.status).toBe(401);
  });

  it('enforces the storage quota', async () => {
    await SettingsModel.create({ key: 'global', storageQuotaBytes: 100 });
    invalidateSettingsCache();
    const r = await request(kit.app).post('/api/uploads/initiate').send({ filename: 'x.txt', size: 101, retention: '1d' });
    expect(r.status).toBe(507);
  });
});

describe('chunked, resumable uploads', () => {
  it('reports received parts, resumes after interruption and completes', async () => {
    const content = PDF(14_000); // 4 parts of 4096
    const agent = request.agent(kit.app);
    const init = await agent.post('/api/uploads/initiate').send({ filename: 'big.pdf', size: content.length, retention: '7d' });
    const s = init.body;
    expect(s.totalParts).toBe(4);
    const part = (n: number) => content.subarray((n - 1) * s.partSize, n * s.partSize);
    // "connection drops" after parts 1 and 3
    for (const n of [1, 3]) expect((await octet(agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=${n}`)).send(part(n))).status).toBe(200);

    // completing early fails but keeps the session resumable
    const early = await agent.post(`/api/uploads/${s.sessionId}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('incomplete_upload');

    // a fresh client asks which parts exist
    const state = await agent.get(`/api/uploads/${s.sessionId}`);
    expect(state.body.status).toBe('active');
    expect(state.body.uploadedParts).toEqual([1, 3]);

    for (const n of [2, 4]) expect((await octet(agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=${n}`)).send(part(n))).status).toBe(200);
    const done = await agent.post(`/api/uploads/${s.sessionId}/complete`);
    expect(done.status).toBe(200);
    const stored = await FileModel.findOne({ fileId: done.body.file.fileId }).lean();
    expect(kit.storage.objects.get(stored!.storageKey)!.equals(content)).toBe(true);
    // complete is idempotent
    const again = await agent.post(`/api/uploads/${s.sessionId}/complete`);
    expect(again.status).toBe(200);
    expect(again.body.file.fileId).toBe(done.body.file.fileId);
  });

  it('accepts out-of-order and retried parts', async () => {
    const content = PDF(9000);
    const agent = request.agent(kit.app);
    const s = (await agent.post('/api/uploads/initiate').send({ filename: 'x.pdf', size: content.length, retention: '1d' })).body;
    const part = (n: number) => content.subarray((n - 1) * s.partSize, n * s.partSize);
    for (const n of [3, 1, 2, 2]) {
      expect((await octet(agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=${n}`)).send(part(n))).status).toBe(200);
    }
    expect((await agent.post(`/api/uploads/${s.sessionId}/complete`)).status).toBe(200);
  });

  it('rejects wrong-sized, out-of-range and unknown-session parts', async () => {
    const content = PDF(9000);
    const agent = request.agent(kit.app);
    const s = (await agent.post('/api/uploads/initiate').send({ filename: 'x.pdf', size: content.length, retention: '1d' })).body;
    const bad = await octet(agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=1`)).send(content.subarray(0, 100));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_part_size');
    expect((await octet(agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=99`)).send(content.subarray(0, 4096))).status).toBe(400);
    expect((await octet(agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=abc`)).send(content.subarray(0, 4096))).status).toBe(400);
    const nosess = await octet(agent.post('/api/uploads/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/parts?partNumber=1')).send(content.subarray(0, 4096));
    expect(nosess.status).toBe(404);
  });

  it('is idempotent for duplicate initiate requests (no duplicate file records)', async () => {
    const body = { filename: 'dup.pdf', size: 5000, retention: '1d', clientKey: 'client-key-123456' };
    const a = await request(kit.app).post('/api/uploads/initiate').send(body);
    const b = await request(kit.app).post('/api/uploads/initiate').send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.sessionId).toBe(a.body.sessionId);
    expect(await FileModel.countDocuments()).toBe(1);
    const mismatch = await request(kit.app).post('/api/uploads/initiate').send({ ...body, size: 6000 });
    expect(mismatch.status).toBe(409);
  });

  it('handles concurrent uploads safely', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => uploadViaApi(kit.app, { name: `c${i}.pdf`, content: PDF(5000 + i * 700) })),
    );
    for (const r of results) expect(r.done!.status).toBe(200);
    expect(new Set(results.map((r) => r.fileId)).size).toBe(8);
    expect(await FileModel.countDocuments({ status: 'ready' })).toBe(8);
  });

  it('survives concurrent duplicate initiates with the same key', async () => {
    const body = { filename: 'race.pdf', size: 5000, retention: '1d', clientKey: 'race-key-12345678' };
    const rs = await Promise.all(Array.from({ length: 6 }, () => request(kit.app).post('/api/uploads/initiate').send(body)));
    expect(new Set(rs.map((r) => r.body.sessionId)).size).toBe(1);
    expect(await FileModel.countDocuments()).toBe(1);
    expect(await UploadSessionModel.countDocuments()).toBe(1);
  });

  it('cancels an upload and cleans up partial data', async () => {
    const content = PDF(9000);
    const agent = request.agent(kit.app);
    const s = (await agent.post('/api/uploads/initiate').send({ filename: 'x.pdf', size: content.length, retention: '1d' })).body;
    await octet(agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=1`)).send(content.subarray(0, 4096));
    expect(kit.storage.uploads.size).toBe(1);
    expect((await agent.delete(`/api/uploads/${s.sessionId}`)).status).toBe(204);
    expect(kit.storage.uploads.size).toBe(0);
    expect(await FileModel.countDocuments()).toBe(0);
    expect((await octet(agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=2`)).send(content.subarray(4096, 8192))).status).toBe(409);
  });

  it('rejects finalisation if the assembled size is inconsistent', async () => {
    const content = PDF(5000);
    const s = (await request(kit.app).post('/api/uploads/initiate').send({ filename: 'x.pdf', size: content.length, retention: '1d' })).body;
    // tamper: storage reports missing part content by uploading nothing for part 2
    await octet(request(kit.app).post(`/api/uploads/${s.sessionId}/parts?partNumber=1`)).send(content.subarray(0, 4096));
    const r = await request(kit.app).post(`/api/uploads/${s.sessionId}/complete`);
    expect(r.status).toBe(409);
  });
});

describe('client disconnects', () => {
  it('does not log a cancelled part upload as a server error', async () => {
    const { ErrorLogModel } = await import('../src/models/ErrorLog.js');
    const http = await import('node:http');
    const s = (await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.bin', size: 20000, retention: '1d' })).body;
    const server = http.createServer(kit.app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as any).port;
    await new Promise<void>((resolve) => {
      const req = http.request({ port, method: 'POST', path: `/api/uploads/${s.sessionId}/parts?partNumber=1`, headers: { 'content-type': 'application/octet-stream', 'content-length': String(s.partSize) } });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(1000));
      setTimeout(() => req.destroy(), 100); // client gives up mid-body
    });
    await new Promise((r) => setTimeout(r, 300));
    server.close();
    expect(await ErrorLogModel.countDocuments()).toBe(0);
    // session remains resumable
    expect((await request(kit.app).get(`/api/uploads/${s.sessionId}`)).body.status).toBe('active');
  });
});
