import { describe, expect, it } from 'vitest';
import { loadConfig, setConfig, GB, HARD_MAX_FILE_BYTES } from '../src/config.js';
import { sanitizeFilename, validateUploadMetadata, verifySignature, downloadMime, isRiskyExecutable } from '../src/services/filePolicy.js';
import { resolveRetention } from '../src/services/retention.js';
import { partGeometry } from '../src/services/uploads.js';

setConfig(loadConfig({ ...process.env }));
const ALL = ['1h', '6h', '12h', '1d', '3d', '7d', '14d', '30d'];

describe('filename + metadata validation', () => {
  it('strips path traversal and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd').name).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\evil.exe').name).toBe('evil.exe');
    expect(sanitizeFilename('a\u202Egnp.exe').name).not.toMatch(/\u202e/);
    expect(sanitizeFilename('  report.PDF ').extension).toBe('pdf');
    expect(sanitizeFilename('CON.txt').name).toBe('_CON.txt');
  });
  it('rejects unusable names', () => {
    for (const bad of ['', '..', '...', '/', 'a\0b.txt', 123 as unknown as string]) {
      expect(() => sanitizeFilename(bad)).toThrow();
    }
  });
  it('rejects blocked extensions and absurd or mismatched MIME types', () => {
    expect(() => validateUploadMetadata('x.scr', '', ['scr'])).toThrow(/not accepted/);
    expect(() => validateUploadMetadata('x.exe', 'not a mime', [])).toThrow(/Malformed/);
    expect(() => validateUploadMetadata('x.exe', 'image/png', [])).not.toThrow(); // exe has no media category
    expect(() => validateUploadMetadata('photo.png', 'video/mp4', [])).toThrow(/does not match/);
    expect(() => validateUploadMetadata('x.exe', 'application/octet-stream', [])).not.toThrow();
  });
  it('accepts all required common formats and unknown extensions', () => {
    const names = 'pdf doc docx txt rtf zip rar 7z exe apk msi jpg jpeg png gif svg webp mp4 mkv mov avi webm mp3 wav aac flac js ts html css json xml py java c cpp'.split(' ');
    for (const e of names) expect(() => validateUploadMetadata(`file.${e}`, '', [])).not.toThrow();
    expect(validateUploadMetadata('data.weird123', '', []).mimeType).toBe('application/octet-stream');
    expect(validateUploadMetadata('Makefile', '', []).extension).toBe('');
  });
});

describe('file signatures', () => {
  const b = (s: string | number[]) => (typeof s === 'string' ? Buffer.from(s, 'latin1') : Buffer.from(s));
  it('verifies magic numbers', () => {
    expect(verifySignature('pdf', b('%PDF-1.4'))).toBe(true);
    expect(verifySignature('pdf', b('MZ\x90\0'))).toBe(false);
    expect(verifySignature('exe', b('MZ\x90\0'))).toBe(true);
    expect(verifySignature('apk', b('PK\x03\x04'))).toBe(true);
    expect(verifySignature('png', b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(verifySignature('mp4', b('\0\0\0\x18ftypmp42'))).toBe(true);
    expect(verifySignature('txt', b([0x41, 0x00, 0x42]))).toBe(false); // binary masquerading as text
    expect(verifySignature('weird123', b('anything'))).toBe(true);
  });
  it('never serves active content with a renderable type and flags risky executables', () => {
    expect(downloadMime('html')).toBe('application/octet-stream');
    expect(downloadMime('svg')).toBe('application/octet-stream');
    expect(downloadMime('pdf')).toBe('application/pdf');
    expect(isRiskyExecutable('exe')).toBe(true);
    expect(isRiskyExecutable('apk')).toBe(true);
    expect(isRiskyExecutable('pdf')).toBe(false);
  });
});

describe('retention rules', () => {
  it('accepts every documented option up to exactly 30 days', () => {
    expect(resolveRetention({ retention: '30d' }, ALL)).toBe(30 * 86400);
    expect(resolveRetention({ retentionSeconds: 3600 }, ALL)).toBe(3600);
  });
  it('rejects anything beyond 30 days and values that are not offered', () => {
    expect(() => resolveRetention({ retentionSeconds: 30 * 86400 + 1 }, ALL)).toThrow(/30 days/);
    expect(() => resolveRetention({ retentionSeconds: 31 * 86400 }, ALL)).toThrow(/30 days/);
    expect(() => resolveRetention({ retentionSeconds: 1234 }, ALL)).toThrow();
    expect(() => resolveRetention({ retention: '60d' }, ALL)).toThrow();
    expect(() => resolveRetention({ retention: '30d' }, ['1h'])).toThrow();
    expect(() => resolveRetention({}, ALL)).toThrow();
    expect(() => resolveRetention({ retentionSeconds: -5 }, ALL)).toThrow();
  });
});

describe('size limit logic (no 3 GB allocation)', () => {
  it('is capped at exactly 3 GB', () => {
    expect(HARD_MAX_FILE_BYTES).toBe(3 * GB);
    expect(() => loadConfig({ ...process.env, MAX_FILE_BYTES: String(3 * GB + 1) })).toThrow(/3 GB/);
  });
  it('splits 3 GB into valid multipart geometry (<= 10 000 parts)', () => {
    const g = partGeometry(3 * GB, 8 * 1024 * 1024);
    expect(g.totalParts).toBe(384);
    const big = partGeometry(3 * GB, 5 * 1024 * 1024);
    expect(big.totalParts).toBeLessThanOrEqual(10_000);
    expect(big.partSize * (big.totalParts - 1)).toBeLessThan(3 * GB);
    expect(big.partSize * big.totalParts).toBeGreaterThanOrEqual(3 * GB);
  });
});
