import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { randomId } from '../utils/ids.js';
import { StorageError, type MultipartInit, type PartInfo, type StorageAdapter } from './types.js';

const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Local-disk adapter (development, or single-node deployments on a persistent
 * volume). Each upload owns one sparse file; part N is written at offset
 * (N-1)*partSize, so completing is an atomic rename and not a 3 GB copy.
 */
export class LocalStorage implements StorageAdapter {
  readonly name = 'local' as const;
  private objects: string;
  private multipart: string;

  constructor(private root: string) {
    this.root = path.resolve(root);
    this.objects = path.join(this.root, 'objects');
    this.multipart = path.join(this.root, 'multipart');
    fs.mkdirSync(this.objects, { recursive: true });
    fs.mkdirSync(this.multipart, { recursive: true });
  }

  private objectPath(key: string) {
    if (!KEY_RE.test(key)) throw new StorageError('invalid_key', 'invalid storage key');
    const p = path.join(this.objects, key.slice(0, 2), key);
    if (!p.startsWith(this.objects + path.sep)) throw new StorageError('invalid_key', 'path escape');
    return p;
  }
  private upDir(uploadId: string) {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new StorageError('invalid_key', 'invalid upload id');
    return path.join(this.multipart, uploadId);
  }
  private metaPath(uploadId: string) {
    return path.join(this.upDir(uploadId), 'meta.json');
  }
  private async meta(uploadId: string): Promise<{ partSize: number; totalSize: number }> {
    try {
      return JSON.parse(await fsp.readFile(this.metaPath(uploadId), 'utf8'));
    } catch {
      throw new StorageError('not_found', 'multipart upload not found');
    }
  }

  async createMultipart(_key: string, init: MultipartInit): Promise<string> {
    const uploadId = randomId(18);
    const dir = this.upDir(uploadId);
    await fsp.mkdir(dir, { recursive: true });
    const fh = await fsp.open(path.join(dir, 'data'), 'w');
    await fh.truncate(init.totalSize); // sparse allocation, no RAM
    await fh.close();
    await fsp.writeFile(this.metaPath(uploadId), JSON.stringify({ partSize: init.partSize, totalSize: init.totalSize }));
    return uploadId;
  }

  async uploadPart(_key: string, uploadId: string, partNumber: number, body: Readable, size: number): Promise<PartInfo> {
    const { partSize } = await this.meta(uploadId);
    const dir = this.upDir(uploadId);
    const marker = path.join(dir, `${partNumber}.part`);
    await fsp.rm(marker, { force: true }); // a retry invalidates the previous marker first
    let written = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > size) return cb(new StorageError('part_size_mismatch', 'part larger than declared'));
        cb(null, chunk);
      },
    });
    const ws = fs.createWriteStream(path.join(dir, 'data'), { flags: 'r+', start: (partNumber - 1) * partSize });
    await pipeline(body, counter, ws);
    if (written !== size) throw new StorageError('part_size_mismatch', `expected ${size} bytes, received ${written}`);
    const etag = `${partNumber}-${size}`;
    await fsp.writeFile(marker, JSON.stringify({ size, etag }));
    return { partNumber, size, etag };
  }

  async listParts(_key: string, uploadId: string): Promise<PartInfo[]> {
    await this.meta(uploadId);
    const out: PartInfo[] = [];
    for (const f of await fsp.readdir(this.upDir(uploadId))) {
      const m = /^(\d+)\.part$/.exec(f);
      if (!m) continue;
      try {
        const j = JSON.parse(await fsp.readFile(path.join(this.upDir(uploadId), f), 'utf8'));
        out.push({ partNumber: Number(m[1]), size: j.size, etag: j.etag });
      } catch {
        /* half-written marker: treat as missing */
      }
    }
    return out.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(key: string, uploadId: string, totalSize: number, totalParts: number) {
    const { partSize, totalSize: declared } = await this.meta(uploadId);
    if (declared !== totalSize) throw new StorageError('size_mismatch', 'declared size mismatch');
    const parts = new Map((await this.listParts(key, uploadId)).map((p) => [p.partNumber, p]));
    const missing: number[] = [];
    for (let n = 1; n <= totalParts; n++) {
      const expected = n < totalParts ? partSize : totalSize - partSize * (totalParts - 1);
      if (parts.get(n)?.size !== expected) missing.push(n);
    }
    if (missing.length) throw new StorageError('missing_parts', `missing or incomplete parts: ${missing.slice(0, 10).join(',')}`);
    const data = path.join(this.upDir(uploadId), 'data');
    const st = await fsp.stat(data);
    if (st.size !== totalSize) throw new StorageError('size_mismatch', 'assembled size mismatch');
    const dest = this.objectPath(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(data, dest);
    await fsp.rm(this.upDir(uploadId), { recursive: true, force: true });
    return { size: st.size };
  }

  async abortMultipart(_key: string, uploadId: string) {
    await fsp.rm(this.upDir(uploadId), { recursive: true, force: true });
  }

  async stat(key: string) {
    try {
      const st = await fsp.stat(this.objectPath(key));
      return { size: st.size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async getStream(key: string, range?: { start: number; end: number }) {
    const p = this.objectPath(key);
    await fsp.access(p).catch(() => {
      throw new StorageError('not_found', 'object not found');
    });
    return fs.createReadStream(p, range ? { start: range.start, end: range.end } : undefined);
  }

  async readHead(key: string, bytes: number) {
    const fh = await fsp.open(this.objectPath(key), 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async delete(key: string) {
    await fsp.rm(this.objectPath(key), { force: true });
  }

  async healthCheck() {
    const probe = path.join(this.root, `.health-${randomId(6)}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe);
  }
}
