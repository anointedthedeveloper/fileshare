import type { Readable } from 'node:stream';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { StorageError, type MultipartInit, type PartInfo, type StorageAdapter } from './types.js';

export interface S3Options {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  keyPrefix: string;
}

const notFound = (e: any) =>
  e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.name === 'NoSuchUpload' || e?.$metadata?.httpStatusCode === 404;

/**
 * S3-compatible adapter (AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi...).
 * Uses native multipart upload, so a 3 GB file is ~400 independent parts. Each
 * part (<= PART_SIZE_BYTES) is buffered once to give the SDK a known length and
 * a signable payload over plain-HTTP endpoints; the whole file is never held.
 */
export class S3Storage implements StorageAdapter {
  readonly name = 's3' as const;
  private client: S3Client;

  constructor(private opts: S3Options) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
      credentials:
        opts.accessKeyId && opts.secretAccessKey
          ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
          : undefined,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 4,
    });
  }

  private k(key: string) {
    return this.opts.keyPrefix + key;
  }

  async createMultipart(key: string, init: MultipartInit) {
    const r = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.opts.bucket,
        Key: this.k(key),
        ContentType: 'application/octet-stream', // never trust/serve the client's type from the bucket
        ServerSideEncryption: undefined,
      }),
    );
    if (!r.UploadId) throw new StorageError('io', 'no upload id returned');
    return r.UploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Readable, size: number): Promise<PartInfo> {
    const chunks: Buffer[] = [];
    let got = 0;
    for await (const c of body) {
      got += (c as Buffer).length;
      if (got > size) throw new StorageError('part_size_mismatch', 'part larger than declared');
      chunks.push(c as Buffer);
    }
    if (got !== size) throw new StorageError('part_size_mismatch', `expected ${size} bytes, received ${got}`);
    const r = await this.client.send(
      new UploadPartCommand({
        Bucket: this.opts.bucket,
        Key: this.k(key),
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: Buffer.concat(chunks),
        ContentLength: size,
      }),
    );
    return { partNumber, size, etag: r.ETag ?? '' };
  }

  async listParts(key: string, uploadId: string): Promise<PartInfo[]> {
    const out: PartInfo[] = [];
    let marker: string | undefined;
    for (;;) {
      const r = await this.client.send(
        new ListPartsCommand({ Bucket: this.opts.bucket, Key: this.k(key), UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const p of r.Parts ?? []) out.push({ partNumber: p.PartNumber!, size: p.Size ?? 0, etag: p.ETag ?? '' });
      if (!r.IsTruncated) break;
      marker = r.NextPartNumberMarker;
    }
    return out;
  }

  async completeMultipart(key: string, uploadId: string, totalSize: number, totalParts: number) {
    const parts = await this.listParts(key, uploadId);
    const byNum = new Map(parts.map((p) => [p.partNumber, p]));
    const missing: number[] = [];
    let sum = 0;
    for (let n = 1; n <= totalParts; n++) {
      const p = byNum.get(n);
      if (!p) missing.push(n);
      else sum += p.size;
    }
    if (missing.length) throw new StorageError('missing_parts', `missing parts: ${missing.slice(0, 10).join(',')}`);
    if (sum !== totalSize) throw new StorageError('size_mismatch', 'assembled size mismatch');
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.opts.bucket,
        Key: this.k(key),
        UploadId: uploadId,
        MultipartUpload: {
          Parts: Array.from({ length: totalParts }, (_, i) => ({ PartNumber: i + 1, ETag: byNum.get(i + 1)!.etag })),
        },
      }),
    );
    return { size: totalSize };
  }

  async abortMultipart(key: string, uploadId: string) {
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.opts.bucket, Key: this.k(key), UploadId: uploadId }));
    } catch (e) {
      if (!notFound(e)) throw e;
    }
  }

  async stat(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: this.k(key) }));
      return { size: r.ContentLength ?? 0 };
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }

  async getStream(key: string, range?: { start: number; end: number }) {
    try {
      const r = await this.client.send(
        new GetObjectCommand({
          Bucket: this.opts.bucket,
          Key: this.k(key),
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      );
      return r.Body as Readable;
    } catch (e) {
      if (notFound(e)) throw new StorageError('not_found', 'object not found');
      throw e;
    }
  }

  async readHead(key: string, bytes: number) {
    const s = await this.getStream(key, { start: 0, end: bytes - 1 });
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(c as Buffer);
    return Buffer.concat(chunks).subarray(0, bytes);
  }

  async delete(key: string) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.k(key) }));
    } catch (e) {
      if (!notFound(e)) throw e;
    }
  }

  async healthCheck() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }
}
