import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { StorageError, type MultipartInit, type PartInfo, type StorageAdapter } from '../src/storage/types.js';

/** In-memory mock adapter with failure injection, for unit/API tests. */
export class MemoryStorage implements StorageAdapter {
  readonly name = 'local' as const;
  objects = new Map<string, Buffer>();
  uploads = new Map<string, { init: MultipartInit; parts: Map<number, Buffer> }>();
  failDelete = 0; // number of upcoming delete() calls that should fail
  deleteCalls = 0;

  async createMultipart(_key: string, init: MultipartInit) {
    const id = randomBytes(12).toString('hex');
    this.uploads.set(id, { init, parts: new Map() });
    return id;
  }
  async uploadPart(_k: string, id: string, n: number, body: Readable, size: number): Promise<PartInfo> {
    const u = this.uploads.get(id);
    if (!u) throw new StorageError('not_found', 'no such upload');
    const chunks: Buffer[] = [];
    let got = 0;
    for await (const c of body) {
      got += (c as Buffer).length;
      if (got > size) throw new StorageError('part_size_mismatch', 'too large');
      chunks.push(c as Buffer);
    }
    if (got !== size) throw new StorageError('part_size_mismatch', 'short part');
    u.parts.set(n, Buffer.concat(chunks));
    return { partNumber: n, size, etag: `etag-${n}` };
  }
  async listParts(_k: string, id: string) {
    const u = this.uploads.get(id);
    if (!u) throw new StorageError('not_found', 'no such upload');
    return [...u.parts].map(([partNumber, b]) => ({ partNumber, size: b.length, etag: `etag-${partNumber}` })).sort((a, b) => a.partNumber - b.partNumber);
  }
  async completeMultipart(key: string, id: string, totalSize: number, totalParts: number) {
    const u = this.uploads.get(id);
    if (!u) throw new StorageError('not_found', 'no such upload');
    const bufs: Buffer[] = [];
    for (let n = 1; n <= totalParts; n++) {
      const b = u.parts.get(n);
      if (!b) throw new StorageError('missing_parts', `missing parts: ${n}`);
      bufs.push(b);
    }
    const all = Buffer.concat(bufs);
    if (all.length !== totalSize) throw new StorageError('size_mismatch', 'size mismatch');
    this.objects.set(key, all);
    this.uploads.delete(id);
    return { size: all.length };
  }
  async abortMultipart(_k: string, id: string) {
    this.uploads.delete(id);
  }
  async stat(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.length } : null;
  }
  async getStream(key: string, range?: { start: number; end: number }) {
    const o = this.objects.get(key);
    if (!o) throw new StorageError('not_found', 'missing');
    return Readable.from([range ? o.subarray(range.start, range.end + 1) : o]);
  }
  async readHead(key: string, bytes: number) {
    const o = this.objects.get(key);
    if (!o) throw new StorageError('not_found', 'missing');
    return o.subarray(0, bytes);
  }
  async delete(key: string) {
    this.deleteCalls++;
    if (this.failDelete > 0) {
      this.failDelete--;
      throw new Error('simulated storage outage');
    }
    this.objects.delete(key);
  }
  async healthCheck() {}
}
