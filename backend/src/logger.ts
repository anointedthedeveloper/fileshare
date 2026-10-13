import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'req.headers["x-manage-token"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.secret',
      '*.token',
      '*.S3_SECRET_ACCESS_KEY',
    ],
    censor: '[redacted]',
  },
});
