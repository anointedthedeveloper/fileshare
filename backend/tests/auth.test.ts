import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { boot, resetDb, shutdown, uploadViaApi, makeUser, loginAgent, type Kit } from './testkit.js';
import { FileModel } from '../src/models/File.js';
import { AuditLogModel } from '../src/models/AuditLog.js';
import { SettingsModel } from '../src/models/Settings.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(shutdown);
beforeEach(resetDb);

describe('deleting files', () => {
  it('rejects unauthenticated and unrelated-user deletion attempts', async () => {
    await makeUser('owner@example.com');
    await makeUser('mallory@example.com');
    const owner = await loginAgent(kit.app, 'owner@example.com');
    const up = await uploadViaApi(kit.app, { agent: owner.agent, csrf: owner.csrf });
    const id = up.fileId;

    const anon = await request(kit.app).delete(`/api/files/${id}`);
    expect(anon.status).toBe(403);
    const mallory = await loginAgent(kit.app, 'mallory@example.com');
    expect((await mallory.agent.delete(`/api/files/${id}`).set('X-CSRF-Token', mallory.csrf)).status).toBe(403);
    expect((await request(kit.app).delete(`/api/files/${id}`).set('X-Manage-Token', 'guess-guess-guess')).status).toBe(403);
    expect((await FileModel.findOne({ fileId: id }).lean())!.deletion!.status).toBe('none');
    expect(kit.storage.objects.size).toBe(1);

    // anonymous callers can't probe which ids exist
    const missing = await request(kit.app).delete('/api/files/AAAAAAAAAAAAAAAAAAAAAA');
    expect(missing.status).toBe(403);
  });

  it('lets the owner delete: the object leaves storage and the link dies at once', async () => {
    await makeUser('owner@example.com');
    const o = await loginAgent(kit.app, 'owner@example.com');
    const { fileId } = await uploadViaApi(kit.app, { agent: o.agent, csrf: o.csrf });
    const r = await o.agent.delete(`/api/files/${fileId}`).set('X-CSRF-Token', o.csrf);
    expect(r.status).toBe(200);
    expect(kit.storage.objects.size).toBe(0);
    expect((await request(kit.app).get(`/api/files/${fileId}/download`)).status).toBe(410);
  });

  it('lets an anonymous uploader delete with their manage token', async () => {
    const { fileId, manageToken } = await uploadViaApi(kit.app);
    expect((await request(kit.app).delete(`/api/files/${fileId}`).set('X-Manage-Token', manageToken)).status).toBe(200);
    expect(kit.storage.objects.size).toBe(0);
  });

  it('keeps the link dead and retries when storage deletion fails', async () => {
    const { fileId, manageToken } = await uploadViaApi(kit.app);
    kit.storage.failDelete = 1;
    expect((await request(kit.app).delete(`/api/files/${fileId}`).set('X-Manage-Token', manageToken)).status).toBe(200);
    expect(kit.storage.objects.size).toBe(1);
    expect((await request(kit.app).get(`/api/files/${fileId}/download`)).status).toBe(410);
    expect((await FileModel.findOne({ fileId }).lean())!.deletion!.status).toBe('failed');
  });
});

describe('accounts, CSRF and My Files', () => {
  it('registers, sets httpOnly cookies and never returns the password hash', async () => {
    const r = await request(kit.app).post('/api/auth/register').send({ email: 'New@Example.com', password: 'a-long-password' });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe('new@example.com');
    expect(JSON.stringify(r.body)).not.toMatch(/hash|\$2/);
    const jar = r.headers['set-cookie'] as unknown as string[];
    const tok = jar.find((c) => c.startsWith('fs_token='))!;
    expect(tok).toMatch(/HttpOnly/);
    expect(tok).toMatch(/SameSite=Lax/);
    expect((await request(kit.app).post('/api/auth/register').send({ email: 'new@example.com', password: 'a-long-password' })).status).toBe(409);
    expect((await request(kit.app).post('/api/auth/register').send({ email: 'bad', password: 'short' })).status).toBe(400);
  });

  it('rejects bad credentials identically for unknown and known users', async () => {
    await makeUser('a@example.com');
    const a = await request(kit.app).post('/api/auth/login').send({ email: 'a@example.com', password: 'wrong-password' });
    const b = await request(kit.app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });
    expect(a.status).toBe(401);
    expect(b.body).toEqual(a.body);
  });

  it('requires a CSRF token for cookie-authenticated state changes', async () => {
    await makeUser('a@example.com');
    const { agent, csrf } = await loginAgent(kit.app, 'a@example.com');
    const body = { filename: 'a.txt', size: 5, retention: '1d' };
    const noToken = await agent.post('/api/uploads/initiate').send(body);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('csrf_failed');
    expect((await agent.post('/api/uploads/initiate').set('X-CSRF-Token', 'forged').send(body)).status).toBe(403);
    expect((await agent.post('/api/uploads/initiate').set('X-CSRF-Token', csrf).send(body)).status).toBe(201);
    const me = await agent.get('/api/auth/me');
    expect(me.body.csrfToken).toBe(csrf);
  });

  it('lists only the signed-in user\'s files', async () => {
    await makeUser('a@example.com');
    await makeUser('b@example.com');
    const a = await loginAgent(kit.app, 'a@example.com');
    const b = await loginAgent(kit.app, 'b@example.com');
    await uploadViaApi(kit.app, { agent: a.agent, csrf: a.csrf, name: 'a1.pdf' });
    await uploadViaApi(kit.app, { agent: a.agent, csrf: a.csrf, name: 'a2.pdf' });
    await uploadViaApi(kit.app, { agent: b.agent, csrf: b.csrf, name: 'b1.pdf' });
    await uploadViaApi(kit.app, { name: 'anon.pdf' });
    const mine = await a.agent.get('/api/user/files');
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((i: any) => i.name).sort()).toEqual(['a1.pdf', 'a2.pdf']);
    expect(mine.body.items[0]).toMatchObject({ downloadCount: 0, uploadStatus: 'ready', deletion: { status: 'none' } });
    expect((await request(kit.app).get('/api/user/files')).status).toBe(401);
  });

  it('prevents using someone else\'s upload session', async () => {
    await makeUser('a@example.com');
    const a = await loginAgent(kit.app, 'a@example.com');
    const s = (await a.agent.post('/api/uploads/initiate').set('X-CSRF-Token', a.csrf).send({ filename: 'a.txt', size: 5, retention: '1d' })).body;
    expect((await request(kit.app).get(`/api/uploads/${s.sessionId}`)).status).toBe(404);
    expect((await request(kit.app).post(`/api/uploads/${s.sessionId}/parts?partNumber=1`).send(Buffer.from('hello'))).status).toBe(404);
    expect((await request(kit.app).delete(`/api/uploads/${s.sessionId}`)).status).toBe(404);
  });
});

describe('admin', () => {
  it('blocks non-admins and anonymous users', async () => {
    await makeUser('u@example.com');
    const u = await loginAgent(kit.app, 'u@example.com');
    expect((await request(kit.app).get('/api/admin/stats')).status).toBe(401);
    expect((await u.agent.get('/api/admin/stats')).status).toBe(403);
    expect((await u.agent.put('/api/admin/settings').set('X-CSRF-Token', u.csrf).send({ allowAnonymous: false })).status).toBe(403);
  });

  it('reports stats, can change policy, and audits it', async () => {
    await makeUser('root@example.com', 'admin');
    const adm = await loginAgent(kit.app, 'root@example.com');
    const up = await uploadViaApi(kit.app, { content: Buffer.alloc(3000, 'a'), name: 'x.txt' });
    await FileModel.updateOne({ fileId: up.fileId }, { $inc: { downloadCount: 3 } });
    const stats = await adm.agent.get('/api/admin/stats');
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ totalFiles: 1, storedBytes: 3000, activeFiles: 1, expiredAwaitingDeletion: 0, deletionFailures: 0, totalDownloads: 3 });

    const put = await adm.agent.put('/api/admin/settings').set('X-CSRF-Token', adm.csrf).send({ allowAnonymous: false, maxFileBytes: 1000, allowedRetentionKeys: ['1h', '1d'] });
    expect(put.status).toBe(200);
    expect(put.body.allowAnonymous).toBe(false);
    expect((await AuditLogModel.find({ action: 'settings.update' }).lean()).length).toBe(1);

    // new policy applies immediately
    expect((await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.txt', size: 5, retention: '1d' })).status).toBe(401);
    const cfg = await request(kit.app).get('/api/config');
    expect(cfg.body.retentionOptions.map((o: any) => o.key)).toEqual(['1h', '1d']);
    expect(cfg.body.maxFileBytes).toBe(1000);
  });

  it('refuses settings that exceed the hard 3 GB / 30 day ceilings', async () => {
    await makeUser('root@example.com', 'admin');
    const adm = await loginAgent(kit.app, 'root@example.com');
    const put = (b: object) => adm.agent.put('/api/admin/settings').set('X-CSRF-Token', adm.csrf).send(b);
    expect((await put({ maxFileBytes: 3 * 1024 ** 3 + 1 })).status).toBe(400);
    expect((await put({ allowedRetentionKeys: ['60d'] })).status).toBe(400);
    expect((await put({ retentionMaxSeconds: 99999999 })).status).toBe(400);
    expect(await SettingsModel.countDocuments()).toBe(0);
  });

  it('lets admins list problem files and delete any file with an audit trail', async () => {
    await makeUser('root@example.com', 'admin');
    const adm = await loginAgent(kit.app, 'root@example.com');
    const up = await uploadViaApi(kit.app);
    await FileModel.updateOne({ fileId: up.fileId }, { $set: { 'deletion.status': 'failed', 'deletion.lastError': 'x', 'deletion.nextAttemptAt': new Date(Date.now() + 99999) } });
    const failed = await adm.agent.get('/api/admin/files?state=failed');
    expect(failed.body.total).toBe(1);
    await FileModel.updateOne({ fileId: up.fileId }, { $set: { 'deletion.status': 'none' } });
    expect((await adm.agent.delete(`/api/admin/files/${up.fileId}`).set('X-CSRF-Token', adm.csrf)).status).toBe(200);
    expect((await AuditLogModel.find({ action: 'file.delete' }).lean()).length).toBe(1);
    expect(kit.storage.objects.size).toBe(0);
  });
});

describe('platform hygiene', () => {
  it('sets security headers and a consistent error envelope', async () => {
    const r = await request(kit.app).get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toBeDefined();
    const bad = await request(kit.app).post('/api/uploads/initiate').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
  });
  it('only allows the configured CORS origin', async () => {
    const ok = await request(kit.app).get('/api/config').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(kit.app).get('/api/config').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('exposes liveness and readiness probes', async () => {
    expect((await request(kit.app).get('/health/live')).status).toBe(200);
    const ready = await request(kit.app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ mongodb: 'ok', storage: 'ok' });
  });
  it('rejects a mis-sized malicious upload without crashing the server', async () => {
    const s = (await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.bin', size: 5000, retention: '1d' })).body;
    const r = await request(kit.app).post(`/api/uploads/${s.sessionId}/parts?partNumber=1`).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(9000));
    expect(r.status).toBe(400);
    expect((await request(kit.app).get('/health/live')).status).toBe(200);
  });
});
