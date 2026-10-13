import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.LOCAL_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-test-'));
process.env.PART_SIZE_BYTES = '4096';
process.env.RATE_LIMIT_API_MAX = '100000';
process.env.RATE_LIMIT_PARTS_MAX = '100000';
process.env.RATE_LIMIT_DOWNLOAD_MAX = '100000';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.UPLOADS_PER_HOUR = '100000';
process.env.RUN_WORKER_IN_API = 'false';
process.env.TOMBSTONE_HOURS = '24';
