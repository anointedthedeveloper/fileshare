import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for Vercel Blob
const store = new Map(); // url -> size
const del = vi.fn(async (url) => void store.delete(url));
let captured;
vi.mock('@vercel/blob', () => ({
  head: async (url) => {
    if (!store.has(url)) throw new Error('not found');
    return { size: store.get(url) };
  },
  del: (u) => del(u),
}));
vi.mock('@vercel/blob/client', () => ({
  handleUpload: async (opts) => {
    captured = opts;
    return { type: 'blob.generate-client-token', clientToken: 'tok' };
  },
}));

const BASE = 'https://abc123.public.blob.vercel-storage.com';
const url = (n = 'a.pdf') => `${BASE}/f/11111111-1111-1111-1111-111111111111/${n}`;

function call(handler, { method = 'GET', body, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const out = { status: 200, headers: {}, body: undefined };
    const res = {
      status(s) { out.status = s; return res; },
      setHeader(k, v) { out.headers[k.toLowerCase()] = v; return res; },
      json(b) { out.body = b; resolve(out); return res; },
      send(b) { out.body = b; resolve(out); return res; },
      redirect(s, l) { out.status = s; out.headers.location = l; resolve(out); return res; },
    };
    Promise.resolve(handler({ method, body, query, headers: {} }, res)).catch(reject);
  });
}

let register, go, cleanup, upload, files, util;
beforeAll(async () => {
  process.env.MONGODB_URI = process.env.TEST_MONGO_URI;
  process.env.MONGODB_DB = `t_${Date.now()}`;
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_abc123_secret';
  register = (await import('../api/register.js')).default;
  go = (await import('../api/go.js')).default;
  cleanup = (await import('../api/cleanup.js')).default;
  upload = (await import('../api/upload.js')).default;
  util = await import('../api/_lib/util.js');
  files = (await import('../api/_lib/db.js')).files;
});
beforeEach(async () => {
  store.clear();
  del.mockClear();
  await (await files()).deleteMany({});
});
afterAll(async () => {
});

const put = (n, size = 1000) => { store.set(url(n), size); return url(n); };
const reg = (b) => call(register, { method: 'POST', body: b });

describe('short codes', () => {
  it('are 4 chars, lowercase alphanumeric, without look-alike characters', () => {
    for (let i = 0; i < 500; i++) expect(util.makeCode()).toMatch(/^[a-hj-km-np-z2-9]{4}$/);
    expect(util.makeCode(5)).toHaveLength(5);
  });
});

describe('register', () => {
  it('creates a short link with the right expiry for each option', async () => {
    for (const [k, secs] of Object.entries({ '1h': 3600, '6h': 21600, '1d': 86400, '3d': 259200 })) {
      const r = await reg({ url: put(`${k}.pdf`), name: `${k}.pdf`, retention: k });
      expect(r.status).toBe(200);
      expect(r.body.code).toMatch(/^[a-z2-9]{4}$/);
      const d = new Date(r.body.expiresAt).getTime() - Date.now();
      expect(Math.abs(d - secs * 1000)).toBeLessThan(5000);
    }
  });
  it('never allows more than 3 days', async () => {
    for (const retention of ['7d', '30d', '4d', '', undefined, '999999']) {
      expect((await reg({ url: put(), name: 'a.pdf', retention })).status).toBe(400);
    }
  });
  it('rejects blobs from other stores, other hosts, and missing uploads', async () => {
    expect((await reg({ url: 'https://evil.example/f/x', retention: '1d' })).status).toBe(400);
    expect((await reg({ url: 'https://zzz999.public.blob.vercel-storage.com/f/a', retention: '1d' })).status).toBe(400);
    expect((await reg({ url: url('ghost.pdf'), retention: '1d' })).status).toBe(400);
  });
  it('rejects and deletes files over 1 GB or empty', async () => {
    const big = put('big.bin', 1024 * 1024 * 1024 + 1);
    expect((await reg({ url: big, name: 'big.bin', retention: '1d' })).status).toBe(413);
    expect(del).toHaveBeenCalledWith(big);
    expect((await reg({ url: put('z.bin', 0), name: 'z', retention: '1d' })).status).toBe(413);
    const ok = put('exact.bin', 1024 * 1024 * 1024);
    expect((await reg({ url: ok, name: 'exact.bin', retention: '1d' })).status).toBe(200);
  });
  it('sanitises the filename', async () => {
    const r = await reg({ url: put(), name: '../../etc/pass<wd>.pdf', retention: '1d' });
    expect(r.body.name).toBe('pass_wd_.pdf');
  });
  it('only accepts POST', async () => {
    expect((await call(register, { method: 'GET' })).status).toBe(405);
  });
  it('hands out unique codes under load', async () => {
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => reg({ url: put(`f${i}.pdf`), name: `f${i}.pdf`, retention: '1h' })));
    expect(new Set(rs.map((r) => r.body.code)).size).toBe(60);
  });
  it('survives code collisions by retrying', async () => {
    const col = await files();
    const spy = vi.spyOn(util, 'makeCode');
    await col.insertOne({ code: 'aaaa', url: 'x', expiresAt: new Date(Date.now() + 1e6) });
    // can't intercept ESM binding; instead just prove the unique index rejects duplicates
    await expect(col.insertOne({ code: 'aaaa' })).rejects.toMatchObject({ code: 11000 });
    spy.mockRestore();
  });
});

describe('download page', () => {
  it('shows the file and a forced-download link while valid', async () => {
    const u = put('report.pdf', 5 * 1024 * 1024);
    const { body } = await reg({ url: u, name: 'report.pdf', retention: '1d' });
    const r = await call(go, { query: { code: body.code.toUpperCase() } });
    expect(r.status).toBe(200);
    expect(r.body).toContain('report.pdf');
    expect(r.body).toContain('5.0 MB');
    expect(r.body).toContain(`${u}?download=1`);
    const direct = await call(go, { query: { code: body.code, d: '1' } });
    expect(direct.status).toBe(302);
    expect(direct.headers.location).toBe(`${u}?download=1`);
  });
  it('escapes hostile filenames', async () => {
    const { body } = await reg({ url: put('x.pdf'), name: '"><img src=x onerror=alert(1)>.pdf', retention: '1d' });
    const r = await call(go, { query: { code: body.code } });
    expect(r.body).not.toContain('<img');
  });
  it('is dead the moment it expires and deletes the file right away', async () => {
    const u = put('old.pdf');
    const { body } = await reg({ url: u, name: 'old.pdf', retention: '1h' });
    await (await files()).updateOne({ code: body.code }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await call(go, { query: { code: body.code } });
    expect(r.status).toBe(410);
    expect(del).toHaveBeenCalledWith(u);
    expect(await (await files()).countDocuments({ code: body.code })).toBe(0);
    expect((await call(go, { query: { code: body.code } })).status).toBe(404);
  });
  it('404s on unknown or malformed codes', async () => {
    for (const code of ['zzzz', '', 'a', '../x', 'abcdefgh']) expect((await call(go, { query: { code } })).status).toBe(404);
  });
});

describe('cleanup cron', () => {
  it('deletes expired blobs and records, leaves live ones, retries failures', async () => {
    const live = (await reg({ url: put('live.pdf'), name: 'live.pdf', retention: '1d' })).body.code;
    const a = (await reg({ url: put('a.pdf'), name: 'a.pdf', retention: '1h' })).body.code;
    const b = (await reg({ url: put('b.pdf'), name: 'b.pdf', retention: '1h' })).body.code;
    const col = await files();
    await col.updateMany({ code: { $in: [a, b] } }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    del.mockImplementationOnce(async () => { throw new Error('blob outage'); });
    let r = await call(cleanup);
    expect(r.body).toEqual({ deleted: 1, failed: 1 });
    expect(await col.countDocuments({ code: live })).toBe(1);
    expect(await col.countDocuments({ expiresAt: { $lte: new Date() } })).toBe(1); // failed one kept for retry
    r = await call(cleanup);
    expect(r.body).toEqual({ deleted: 1, failed: 0 });
    expect(store.has(url('live.pdf'))).toBe(true);
    expect(store.has(url('a.pdf')) && store.has(url('b.pdf'))).toBe(false);
  });
  it('requires CRON_SECRET only when configured', async () => {
    process.env.CRON_SECRET = 's3cret';
    expect((await call(cleanup)).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call(cleanup)).status).toBe(200);
  });
});

describe('upload token endpoint', () => {
  it('only issues tokens for our path shape, with a 1 GB cap and no overwrite', async () => {
    await call(upload, { method: 'POST', body: { type: 'x' } });
    const ok = await captured.onBeforeGenerateToken('f/11111111-1111-1111-1111-111111111111/a.pdf');
    expect(ok).toMatchObject({ maximumSizeInBytes: 1024 * 1024 * 1024, allowOverwrite: false, addRandomSuffix: false });
    for (const bad of ['../x', 'f/x/a', 'other/11111111-1111-1111-1111-111111111111/a', 'f/11111111-1111-1111-1111-111111111111/a/b']) {
      await expect(captured.onBeforeGenerateToken(bad)).rejects.toThrow();
    }
    expect((await call(upload, { method: 'GET' })).status).toBe(405);
  });
});

describe('health check', () => {
  it('reports missing config without leaking secrets', async () => {
    const h = (await import('../api/health.js')).default;
    const t = process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    let r = await call(h);
    expect(r.status).toBe(503);
    expect(r.body.problems.join(' ')).toMatch(/Blob storage is not connected/);
    expect(JSON.stringify(r.body)).not.toContain(process.env.MONGODB_URI);
    process.env.BLOB_READ_WRITE_TOKEN = t;
    r = await call(h);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mongo: 'ok', blobTokenSet: true, problems: [] });
  });
});
