import mongoose from 'mongoose';
import request from 'supertest';
import { loadConfig, setConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { setStorage } from '../src/storage/index.js';
import { MemoryStorage } from './memoryStorage.js';
import { invalidateSettingsCache } from '../src/services/settings.js';
import { setScanner } from '../src/services/scanner.js';
import { syncIndexes } from '../src/db.js';
import { UserModel } from '../src/models/User.js';
import { hashPassword } from '../src/services/auth.js';

export interface Kit {
  app: ReturnType<typeof createApp>;
  storage: MemoryStorage;
}

let current: MemoryStorage | undefined;

export async function boot(overrides: Record<string, string> = {}): Promise<Kit> {
  setConfig(loadConfig({ ...process.env, ...overrides }));
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.TEST_MONGO_URI!, { dbName: `t_${Math.random().toString(36).slice(2, 10)}` });
    await syncIndexes();
  }
  const storage = new MemoryStorage();
  current = storage;
  setStorage(storage);
  setScanner(undefined);
  invalidateSettingsCache();
  return { app: createApp(), storage };
}

export async function resetDb() {
  const cols = await mongoose.connection.db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
  current?.objects.clear();
  current?.uploads.clear();
  if (current) {
    current.failDelete = 0;
    current.deleteCalls = 0;
  }
  invalidateSettingsCache();
}

export async function shutdown() {
  await mongoose.disconnect();
}

export interface UploadOpts {
  name?: string;
  content?: Buffer;
  retention?: string;
  password?: string;
  downloadLimit?: number;
  agent?: ReturnType<typeof request.agent>;
  csrf?: string;
}

export const PDF = (n = 10_000) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(n, 0x41)]);

/** Full happy-path upload through the HTTP API. */
export interface UploadOutcome {
  init: request.Response;
  part?: request.Response;
  done?: request.Response;
  session?: any;
  fileId: string;
  manageToken: string;
  content?: Buffer;
}

export async function uploadViaApi(app: Kit['app'], o: UploadOpts = {}): Promise<UploadOutcome> {
  const content = o.content ?? PDF();
  const agent = o.agent ?? request.agent(app);
  const h = o.csrf ? { 'X-CSRF-Token': o.csrf } : {};
  const init = await agent
    .post('/api/uploads/initiate')
    .set(h)
    .send({
      filename: o.name ?? 'report.pdf',
      size: content.length,
      retention: o.retention ?? '1d',
      password: o.password,
      downloadLimit: o.downloadLimit,
    });
  if (init.status >= 300) return { init } as UploadOutcome;
  const s = init.body;
  for (let n = 1; n <= s.totalParts; n++) {
    const chunk = content.subarray((n - 1) * s.partSize, n * s.partSize);
    const r = await agent.post(`/api/uploads/${s.sessionId}/parts?partNumber=${n}`).set(h).set('Content-Type', 'application/octet-stream').send(chunk);
    if (r.status >= 300) return { init, part: r } as UploadOutcome;
  }
  const done = await agent.post(`/api/uploads/${s.sessionId}/complete`).set(h);
  return { init, done, session: s, fileId: done.body?.file?.fileId as string, manageToken: init.body?.manageToken as string, content };
}

export async function makeUser(email: string, role: 'user' | 'admin' = 'user', password = 'password123') {
  return UserModel.create({ email, passwordHash: await hashPassword(password), role });
}

export async function loginAgent(app: Kit['app'], email: string, password = 'password123') {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ email, password });
  return { agent, csrf: r.body.csrfToken as string, res: r };
}
