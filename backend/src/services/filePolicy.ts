import fs from 'node:fs';
import { config } from '../config.js';
import { badRequest } from '../utils/errors.js';

type Sig = (h: Buffer) => boolean;

const startsWith = (...bytes: number[]): Sig => (h) => bytes.every((b, i) => h[i] === b);
const ascii = (s: string, offset = 0): Sig => (h) => h.subarray(offset, offset + s.length).toString('latin1') === s;
const any = (...sigs: Sig[]): Sig => (h) => sigs.some((s) => s(h));
const all = (...sigs: Sig[]): Sig => (h) => sigs.every((s) => s(h));
/** Plain-text formats: no NUL bytes and mostly printable in the head. */
const textual: Sig = (h) => {
  if (h.includes(0) && !(h[0] === 0xff && h[1] === 0xfe) && !(h[0] === 0xfe && h[1] === 0xff)) return false;
  return true;
};

const ZIP = any(ascii('PK\x03\x04'), ascii('PK\x05\x06'), ascii('PK\x07\x08'));
const OLE = startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const MZ = ascii('MZ');
const ISO_BMFF = ascii('ftyp', 4);

export interface TypeInfo {
  mime: string;
  signature?: Sig;
  /** Content a browser could treat as active (script/markup): always served as octet-stream. */
  active?: boolean;
  /** Show the "only open if you trust the source" warning to downloaders. */
  warn?: boolean;
  category?: 'image' | 'video' | 'audio' | 'text' | 'other';
}

/** Default registry. Extend or override via FILE_POLICY_PATH (see docs). Unknown extensions are allowed. */
const DEFAULTS: Record<string, TypeInfo> = {
  // documents
  pdf: { mime: 'application/pdf', signature: ascii('%PDF-'), category: 'other' },
  doc: { mime: 'application/msword', signature: OLE },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signature: ZIP },
  xls: { mime: 'application/vnd.ms-excel', signature: OLE },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signature: ZIP },
  ppt: { mime: 'application/vnd.ms-powerpoint', signature: OLE },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', signature: ZIP },
  txt: { mime: 'text/plain', signature: textual, category: 'text' },
  md: { mime: 'text/markdown', signature: textual, category: 'text' },
  csv: { mime: 'text/csv', signature: textual, category: 'text' },
  rtf: { mime: 'application/rtf', signature: ascii('{\\rtf') },
  // archives
  zip: { mime: 'application/zip', signature: ZIP },
  rar: { mime: 'application/vnd.rar', signature: ascii('Rar!\x1a\x07') },
  '7z': { mime: 'application/x-7z-compressed', signature: startsWith(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) },
  gz: { mime: 'application/gzip', signature: startsWith(0x1f, 0x8b) },
  tar: { mime: 'application/x-tar' },
  // applications / installers
  exe: { mime: 'application/vnd.microsoft.portable-executable', signature: MZ, warn: true },
  msi: { mime: 'application/x-msi', signature: OLE, warn: true },
  dll: { mime: 'application/vnd.microsoft.portable-executable', signature: MZ, warn: true },
  apk: { mime: 'application/vnd.android.package-archive', signature: ZIP, warn: true },
  dmg: { mime: 'application/x-apple-diskimage', warn: true },
  iso: { mime: 'application/x-iso9660-image' },
  bat: { mime: 'application/x-msdos-program', warn: true, active: true },
  cmd: { mime: 'application/x-msdos-program', warn: true, active: true },
  sh: { mime: 'application/x-sh', signature: textual, warn: true, active: true },
  ps1: { mime: 'application/octet-stream', signature: textual, warn: true, active: true },
  jar: { mime: 'application/java-archive', signature: ZIP, warn: true },
  // images
  jpg: { mime: 'image/jpeg', signature: startsWith(0xff, 0xd8, 0xff), category: 'image' },
  jpeg: { mime: 'image/jpeg', signature: startsWith(0xff, 0xd8, 0xff), category: 'image' },
  png: { mime: 'image/png', signature: startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), category: 'image' },
  gif: { mime: 'image/gif', signature: any(ascii('GIF87a'), ascii('GIF89a')), category: 'image' },
  webp: { mime: 'image/webp', signature: all(ascii('RIFF'), ascii('WEBP', 8)), category: 'image' },
  svg: { mime: 'image/svg+xml', signature: textual, active: true, category: 'image' },
  bmp: { mime: 'image/bmp', signature: ascii('BM'), category: 'image' },
  ico: { mime: 'image/x-icon', signature: startsWith(0, 0, 1, 0), category: 'image' },
  // video
  mp4: { mime: 'video/mp4', signature: ISO_BMFF, category: 'video' },
  mov: { mime: 'video/quicktime', signature: any(ISO_BMFF, ascii('moov', 4), ascii('wide', 4), ascii('mdat', 4)), category: 'video' },
  mkv: { mime: 'video/x-matroska', signature: startsWith(0x1a, 0x45, 0xdf, 0xa3), category: 'video' },
  webm: { mime: 'video/webm', signature: startsWith(0x1a, 0x45, 0xdf, 0xa3), category: 'video' },
  avi: { mime: 'video/x-msvideo', signature: all(ascii('RIFF'), ascii('AVI ', 8)), category: 'video' },
  // audio
  mp3: { mime: 'audio/mpeg', signature: any(ascii('ID3'), (h) => h[0] === 0xff && (h[1] & 0xe0) === 0xe0), category: 'audio' },
  wav: { mime: 'audio/wav', signature: all(ascii('RIFF'), ascii('WAVE', 8)), category: 'audio' },
  aac: { mime: 'audio/aac', signature: any((h) => h[0] === 0xff && (h[1] & 0xf6) === 0xf0, ISO_BMFF, ascii('ID3')), category: 'audio' },
  flac: { mime: 'audio/flac', signature: ascii('fLaC'), category: 'audio' },
  // development
  js: { mime: 'text/javascript', signature: textual, active: true, category: 'text' },
  ts: { mime: 'text/plain', signature: textual, category: 'text' },
  html: { mime: 'text/html', signature: textual, active: true, category: 'text' },
  htm: { mime: 'text/html', signature: textual, active: true, category: 'text' },
  css: { mime: 'text/css', signature: textual, active: true, category: 'text' },
  json: { mime: 'application/json', signature: textual, category: 'text' },
  xml: { mime: 'application/xml', signature: textual, active: true, category: 'text' },
  py: { mime: 'text/x-python', signature: textual, category: 'text' },
  java: { mime: 'text/x-java-source', signature: textual, category: 'text' },
  c: { mime: 'text/x-csrc', signature: textual, category: 'text' },
  cpp: { mime: 'text/x-c++src', signature: textual, category: 'text' },
};

let registry: Record<string, TypeInfo> | undefined;

/** Optional JSON policy file: { "types": { "ext": { "mime": "...", "warn": true } }, "remove": ["ext"] } */
function loadRegistry(): Record<string, TypeInfo> {
  const reg = { ...DEFAULTS };
  const p = config().FILE_POLICY_PATH;
  if (p) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [ext, v] of Object.entries<any>(j.types ?? {})) {
      reg[ext.toLowerCase().replace(/^\./, '')] = {
        mime: String(v.mime ?? 'application/octet-stream'),
        active: !!v.active,
        warn: !!v.warn,
        category: v.category,
        // custom entries are matched by ASCII magic string at offset 0 when provided
        signature: v.magic ? ascii(String(v.magic)) : undefined,
      };
    }
    for (const ext of j.remove ?? []) delete reg[String(ext).toLowerCase()];
  }
  return reg;
}
export function typeRegistry() {
  return (registry ??= loadRegistry());
}
export function resetPolicyCache() {
  registry = undefined;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*‎‏‪-‮⁦-⁩]/g;

export interface CleanName {
  name: string;
  extension: string;
}

/** Strips directories, control/bidi chars and reserved names. Throws on unusable names. */
export function sanitizeFilename(raw: unknown): CleanName {
  if (typeof raw !== 'string') throw badRequest('invalid_filename', 'Filename must be a string');
  if (raw.includes('\0')) throw badRequest('invalid_filename', 'Filename contains invalid characters');
  let n = raw.normalize('NFC');
  n = n.split(/[\\/]/).pop() ?? '';
  n = n.replace(BAD_CHARS, '_').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!n || n === '.' || n === '..') throw badRequest('invalid_filename', 'Filename is empty or invalid');
  if (RESERVED.test(n)) n = `_${n}`;
  if (Buffer.byteLength(n) > 255) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 ? n.slice(dot) : '';
    n = n.slice(0, 200) + ext.slice(0, 20);
  }
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(n);
  return { name: n, extension: m ? m[1].toLowerCase() : '' };
}

export function typeFor(ext: string): TypeInfo {
  return typeRegistry()[ext] ?? { mime: 'application/octet-stream' };
}

const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-binary']);

/**
 * Validates name + declared MIME. The declared MIME is advisory (browsers guess):
 * it is rejected only when its top-level category contradicts the extension's.
 */
export function validateUploadMetadata(rawName: unknown, declaredMime: unknown, blocked: string[]) {
  const { name, extension } = sanitizeFilename(rawName);
  if (extension && blocked.includes(extension)) {
    throw badRequest('unsupported_type', `Files of type .${extension} are not accepted`);
  }
  const declared = typeof declaredMime === 'string' ? declaredMime.toLowerCase().split(';')[0].trim() : '';
  if (declared && (declared.length > 127 || !/^[a-z0-9.+-]+\/[a-z0-9.+*_-]+$/.test(declared))) {
    throw badRequest('invalid_mime', 'Malformed MIME type');
  }
  const info = typeFor(extension);
  if (declared && !GENERIC.has(declared) && info.category && info.category !== 'text' && info.category !== 'other') {
    const top = declared.split('/')[0];
    if (['image', 'video', 'audio'].includes(top) && top !== info.category) {
      throw badRequest('mime_mismatch', `Declared type ${declared} does not match .${extension}`);
    }
  }
  return { name, extension, declared, mimeType: info.mime };
}

/** File-signature (magic number) check on the first bytes. Unknown/unsigned types pass. */
export function verifySignature(extension: string, head: Buffer): boolean {
  if (!config().VERIFY_SIGNATURES) return true;
  const sig = typeRegistry()[extension]?.signature;
  if (!sig) return true;
  if (head.length === 0) return true; // zero-byte files carry no signature
  return sig(head);
}

/** MIME type to send on download. Active content is never labelled as renderable. */
export function downloadMime(extension: string): string {
  const info = typeRegistry()[extension];
  if (!info || info.active) return 'application/octet-stream';
  return info.mime;
}

export const isRiskyExecutable = (extension: string) => !!typeRegistry()[extension]?.warn;
export const SIGNATURE_BYTES = 4096;
