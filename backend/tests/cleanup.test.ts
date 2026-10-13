import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { boot, resetDb, shutdown, uploadViaApi, PDF, type Kit } from './testkit.js';
import { FileModel } from '../src/models/File.js';
import { UploadSessionModel } from '../src/models/UploadSession.js';
import { ErrorLogModel } from '../src/models/ErrorLog.js';
import { runCleanupOnce, backoffSeconds } from '../src/services/cleanup.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(shutdown);
beforeEach(resetDb);

const expire = (fileId: string, ms = 1000) => FileModel.updateOne({ fileId }, { $set: { expiresAt: new Date(Date.now() - ms) } });

describe('background deletion of expired files', () => {
  it('deletes the stored object and leaves only a short-lived tombstone', async () => {
    const { fileId } = await uploadViaApi(kit.app);
    const keep = await uploadViaApi(kit.app);
    await expire(fileId);
    expect(kit.storage.objects.size).toBe(2);

    const stats = await runCleanupOnce();
    expect(stats.deleted).toBe(1);
    expect(kit.storage.objects.size).toBe(1); // physical object gone, the live one untouched
    const tomb = await FileModel.findOne({ fileId }).lean();
    expect(tomb!.status).toBe('deleted');
    expect(tomb!.deletion!.status).toBe('deleted');
    expect(tomb!.purgeAt).toBeTruthy();
    expect(tomb!.passwordHash).toBeUndefined();
    expect((await request(kit.app).get(`/api/files/${fileId}/download`)).status).toBe(410);
    expect((await request(kit.app).get(`/api/files/${keep.fileId}/download`)).status).toBe(200);

    // after the grace period the record itself is removed
    await FileModel.updateOne({ fileId }, { $set: { purgeAt: new Date(Date.now() - 1000) } });
    expect((await runCleanupOnce()).tombstonesPurged).toBe(1);
    expect(await FileModel.countDocuments({ fileId })).toBe(0);
  });

  it('removes records immediately when TOMBSTONE_HOURS=0', async () => {
    const k = await boot({ TOMBSTONE_HOURS: '0' });
    const { fileId } = await uploadViaApi(k.app);
    await expire(fileId);
    await runCleanupOnce();
    expect(await FileModel.countDocuments({ fileId })).toBe(0);
    expect(k.storage.objects.size).toBe(0);
    kit = await boot();
  });

  it('never deletes files that are not yet expired', async () => {
    await uploadViaApi(kit.app);
    expect((await runCleanupOnce()).deleted).toBe(0);
    expect(kit.storage.objects.size).toBe(1);
  });

  it('is idempotent when the object is already gone from storage', async () => {
    const { fileId } = await uploadViaApi(kit.app);
    kit.storage.objects.clear();
    await expire(fileId);
    expect((await runCleanupOnce()).deleted).toBe(1);
  });
});

describe('retrying failed storage deletions', () => {
  it('records the failure, backs off exponentially, then succeeds', async () => {
    const { fileId } = await uploadViaApi(kit.app);
    await expire(fileId);
    kit.storage.failDelete = 2;

    let s = await runCleanupOnce();
    expect(s.failed).toBe(1);
    let f = await FileModel.findOne({ fileId }).lean();
    expect(f!.deletion!.status).toBe('failed');
    expect(f!.deletion!.attempts).toBe(1);
    expect(f!.deletion!.lastError).toContain('simulated storage outage');
    expect(f!.deletion!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(kit.storage.objects.size).toBe(1);
    expect((await ErrorLogModel.countDocuments({ source: 'worker' }))).toBe(1);

    // not due yet -> not retried
    s = await runCleanupOnce();
    expect(s.failed + s.deleted).toBe(0);
    expect(kit.storage.deleteCalls).toBe(1);

    // fast-forward past backoff: second attempt fails, third succeeds
    await FileModel.updateOne({ fileId }, { $set: { 'deletion.nextAttemptAt': new Date(Date.now() - 1) } });
    expect((await runCleanupOnce()).failed).toBe(1);
    f = await FileModel.findOne({ fileId }).lean();
    expect(f!.deletion!.attempts).toBe(2);
    await FileModel.updateOne({ fileId }, { $set: { 'deletion.nextAttemptAt': new Date(Date.now() - 1) } });
    expect((await runCleanupOnce()).deleted).toBe(1);
    expect(kit.storage.objects.size).toBe(0);
    expect((await FileModel.findOne({ fileId }).lean())!.deletion!.status).toBe('deleted');
  });

  it('keeps blocking downloads while deletion is failing', async () => {
    const { fileId } = await uploadViaApi(kit.app);
    await expire(fileId);
    kit.storage.failDelete = 1;
    await runCleanupOnce();
    expect((await request(kit.app).get(`/api/files/${fileId}/download`)).status).toBe(410);
  });

  it('backoff grows exponentially and is capped', () => {
    expect(backoffSeconds(1, 30)).toBe(30);
    expect(backoffSeconds(2, 30)).toBe(60);
    expect(backoffSeconds(4, 30)).toBe(240);
    expect(backoffSeconds(30, 30)).toBe(6 * 3600);
  });

  it('resumes a deletion interrupted by a crashed worker (stale lock)', async () => {
    const { fileId } = await uploadViaApi(kit.app);
    await FileModel.updateOne({ fileId }, { $set: { 'deletion.status': 'in_progress', 'deletion.lockedUntil': new Date(Date.now() - 1000), 'deletion.attempts': 1, expiresAt: new Date(Date.now() - 5000) } });
    expect((await runCleanupOnce()).deleted).toBe(1);
    // a live lock is respected
    const other = await uploadViaApi(kit.app);
    await FileModel.updateOne({ fileId: other.fileId }, { $set: { 'deletion.status': 'in_progress', 'deletion.lockedUntil': new Date(Date.now() + 60_000) } });
    expect((await runCleanupOnce()).deleted).toBe(0);
  });

  it('two concurrent workers never delete the same file twice', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await uploadViaApi(kit.app)).fileId);
    for (const id of ids) await expire(id);
    const [a, b] = await Promise.all([runCleanupOnce(), runCleanupOnce()]);
    expect(a.deleted + b.deleted).toBe(4);
    expect(kit.storage.deleteCalls).toBe(4);
  });
});

describe('abandoned uploads', () => {
  it('aborts expired sessions, frees multipart state and removes the pending file record', async () => {
    const content = PDF(9000);
    const s = (await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.pdf', size: content.length, retention: '1d' })).body;
    await request(kit.app).post(`/api/uploads/${s.sessionId}/parts?partNumber=1`).set('Content-Type', 'application/octet-stream').send(content.subarray(0, 4096));
    expect(kit.storage.uploads.size).toBe(1);
    await UploadSessionModel.updateOne({ sessionId: s.sessionId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const stats = await runCleanupOnce();
    expect(stats.sessionsExpired).toBe(1);
    expect(stats.sessionsReleased).toBe(1);
    expect(kit.storage.uploads.size).toBe(0);
    expect(await FileModel.countDocuments()).toBe(0);
    const sess = await UploadSessionModel.findOne({ sessionId: s.sessionId }).lean();
    expect(sess!.status).toBe('aborted');
    expect(sess!.purgeAt).toBeTruthy();
    expect((await request(kit.app).post(`/api/uploads/${s.sessionId}/complete`)).status).toBe(409);
  });

  it('aborts sessions idle for longer than the idle timeout', async () => {
    const s = (await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.pdf', size: 5000, retention: '1d' })).body;
    await UploadSessionModel.updateOne({ sessionId: s.sessionId }, { $set: { lastActivityAt: new Date(Date.now() - 3 * 3600_000) } });
    expect((await runCleanupOnce()).sessionsExpired).toBe(1);
  });

  it('leaves active sessions alone and returns stuck "completing" sessions to active', async () => {
    const s = (await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.pdf', size: 5000, retention: '1d' })).body;
    expect((await runCleanupOnce()).sessionsExpired).toBe(0);
    await UploadSessionModel.updateOne({ sessionId: s.sessionId }, { $set: { status: 'completing', lockedUntil: new Date(Date.now() - 1000) } });
    await runCleanupOnce();
    expect((await UploadSessionModel.findOne({ sessionId: s.sessionId }).lean())!.status).toBe('active');
  });

  it('retries releasing a session whose storage abort failed', async () => {
    const s = (await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.pdf', size: 5000, retention: '1d' })).body;
    const orig = kit.storage.abortMultipart.bind(kit.storage);
    let fail = true;
    kit.storage.abortMultipart = async (k, id) => {
      if (fail) throw new Error('boom');
      return orig(k, id);
    };
    expect((await request(kit.app).delete(`/api/uploads/${s.sessionId}`)).status).toBe(204);
    expect((await UploadSessionModel.findOne({ sessionId: s.sessionId }).lean())!.released).toBe(false);
    fail = false;
    expect((await runCleanupOnce()).sessionsReleased).toBe(1);
    expect(kit.storage.uploads.size).toBe(0);
    expect(await FileModel.countDocuments()).toBe(0);
  });

  it('queues orphaned "uploading" file records that have no session', async () => {
    const s = (await request(kit.app).post('/api/uploads/initiate').send({ filename: 'a.pdf', size: 5000, retention: '1d' })).body;
    await UploadSessionModel.deleteOne({ sessionId: s.sessionId });
    await FileModel.updateMany({}, { $set: { createdAt: new Date(Date.now() - 72 * 3600_000) } });
    const stats = await runCleanupOnce();
    expect(stats.orphansQueued).toBe(1);
    await runCleanupOnce();
    expect((await FileModel.findOne().lean())!.deletion!.status).toBe('deleted');
  });
});

describe('index strategy', () => {
  it('uses TTL only on purgeAt (after storage deletion), never on expiresAt', async () => {
    const idx = await FileModel.collection.indexes();
    const ttl = idx.filter((i) => i.expireAfterSeconds !== undefined);
    expect(ttl.map((i) => Object.keys(i.key)[0])).toEqual(['purgeAt']);
    expect(idx.some((i) => i.key.fileId === 1 && i.unique)).toBe(true);
    expect(idx.some((i) => i.key['deletion.status'] === 1 && i.key.expiresAt === 1)).toBe(true);
    expect(idx.some((i) => i.key.ownerId === 1)).toBe(true);
  });
});
