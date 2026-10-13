import 'dotenv/config';
import { z } from 'zod';

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;
/** Hard product limits. Admin settings can lower these but never exceed them. */
export const HARD_MAX_FILE_BYTES = 3 * GB;
export const HARD_MAX_RETENTION_SECONDS = 30 * 24 * 3600;

export const RETENTION_OPTIONS = [
  { key: '1h', label: '1 hour', seconds: 3600 },
  { key: '6h', label: '6 hours', seconds: 6 * 3600 },
  { key: '12h', label: '12 hours', seconds: 12 * 3600 },
  { key: '1d', label: '1 day', seconds: 24 * 3600 },
  { key: '3d', label: '3 days', seconds: 3 * 24 * 3600 },
  { key: '7d', label: '7 days', seconds: 7 * 24 * 3600 },
  { key: '14d', label: '14 days', seconds: 14 * 24 * 3600 },
  { key: '30d', label: '30 days', seconds: HARD_MAX_RETENTION_SECONDS },
] as const;

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default('info'),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/fileshare'),

  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().default(0),

  JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),
  COOKIE_SECURE: bool.optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_DAYS: z.coerce.number().default(7),

  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_PATH: z.string().default('./data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  S3_KEY_PREFIX: z.string().default('files/'),

  MAX_FILE_BYTES: z.coerce.number().int().positive().default(HARD_MAX_FILE_BYTES),
  PART_SIZE_BYTES: z.coerce.number().int().min(1024).default(8 * MB),
  STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(500 * GB),
  UPLOAD_SESSION_TTL_HOURS: z.coerce.number().positive().default(24),
  UPLOAD_IDLE_TIMEOUT_MINUTES: z.coerce.number().positive().default(120),
  COMPUTE_CHECKSUM: bool.default(true),
  VERIFY_SIGNATURES: bool.default(true),
  FILE_POLICY_PATH: z.string().optional(),

  ALLOW_ANONYMOUS_UPLOADS: bool.default(true),
  ALLOW_REGISTRATION: bool.default(true),
  UPLOADS_PER_HOUR: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),
  RATE_LIMIT_API_MAX: z.coerce.number().int().default(600),
  RATE_LIMIT_DOWNLOAD_MAX: z.coerce.number().int().default(120),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().default(20),
  RATE_LIMIT_PASSWORD_MAX: z.coerce.number().int().default(8),
  RATE_LIMIT_PARTS_MAX: z.coerce.number().int().default(3000),

  SCANNER: z.enum(['none', 'clamav']).default('none'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  RUN_WORKER_IN_API: bool.default(true),
  CLEANUP_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
  CLEANUP_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  DELETE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  DELETE_RETRY_BASE_SECONDS: z.coerce.number().positive().default(30),
  TOMBSTONE_HOURS: z.coerce.number().min(0).default(24),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const c = parsed.data;
  if (c.MAX_FILE_BYTES > HARD_MAX_FILE_BYTES) {
    throw new Error('MAX_FILE_BYTES cannot exceed 3 GB');
  }
  if (c.NODE_ENV === 'production') {
    if (c.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
    if (c.STORAGE_PROVIDER === 's3' && !c.S3_BUCKET) throw new Error('S3_BUCKET is required');
  }
  if (c.STORAGE_PROVIDER === 's3' && c.PART_SIZE_BYTES < 5 * MB) {
    throw new Error('PART_SIZE_BYTES must be at least 5 MiB for S3-compatible storage');
  }
  return c;
}

let cached: Config | undefined;
export function config(): Config {
  return (cached ??= loadConfig());
}
/** For tests: replace the cached configuration. */
export function setConfig(c: Config) {
  cached = c;
}
