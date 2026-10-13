import type { Readable } from 'node:stream';

export interface PartInfo {
  partNumber: number;
  size: number;
  etag: string;
}

export interface MultipartInit {
  partSize: number;
  totalSize: number;
  contentType?: string;
}

/**
 * Storage adapter. Both providers implement the same multipart contract so the
 * HTTP layer is provider-agnostic: initiate -> uploadPart (any order, retryable)
 * -> complete (or abort). Bytes are always streamed; they never touch MongoDB.
 */
export interface StorageAdapter {
  readonly name: 'local' | 's3';
  createMultipart(key: string, init: MultipartInit): Promise<string>;
  /** Streams `body` into the part. Must reject if fewer/more than `size` bytes arrive. */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Readable, size: number): Promise<PartInfo>;
  listParts(key: string, uploadId: string): Promise<PartInfo[]>;
  /** Assembles the object. Throws if any part is missing or the size does not match. */
  completeMultipart(key: string, uploadId: string, totalSize: number, totalParts: number): Promise<{ size: number }>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  stat(key: string): Promise<{ size: number } | null>;
  getStream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  readHead(key: string, bytes: number): Promise<Buffer>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** Free-form connectivity check used by /health/ready. */
  healthCheck(): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    public code: 'part_size_mismatch' | 'missing_parts' | 'size_mismatch' | 'not_found' | 'invalid_key' | 'io',
    message: string,
  ) {
    super(message);
  }
}
