import { config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { StorageAdapter } from './types.js';

let adapter: StorageAdapter | undefined;

export function createStorage(): StorageAdapter {
  const c = config();
  if (c.STORAGE_PROVIDER === 's3') {
    return new S3Storage({
      endpoint: c.S3_ENDPOINT,
      region: c.S3_REGION,
      bucket: c.S3_BUCKET!,
      accessKeyId: c.S3_ACCESS_KEY_ID,
      secretAccessKey: c.S3_SECRET_ACCESS_KEY,
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
      keyPrefix: c.S3_KEY_PREFIX,
    });
  }
  return new LocalStorage(c.LOCAL_STORAGE_PATH);
}

export function storage(): StorageAdapter {
  return (adapter ??= createStorage());
}
/** Tests inject a mock/alternate adapter. */
export function setStorage(a: StorageAdapter | undefined) {
  adapter = a;
}
export type { StorageAdapter } from './types.js';
