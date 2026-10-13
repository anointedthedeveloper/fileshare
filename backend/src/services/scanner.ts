import net from 'node:net';
import type { Readable } from 'node:stream';
import { config } from '../config.js';

export interface ScanResult {
  clean: boolean;
  signature?: string;
}
export interface Scanner {
  name: string;
  scan(stream: Readable): Promise<ScanResult>;
}

/** Default: scanning disabled. Swap in any implementation of `Scanner` via setScanner(). */
export const noopScanner: Scanner = {
  name: 'none',
  scan(stream) {
    return new Promise((resolve, reject) => {
      stream.on('end', () => resolve({ clean: true }));
      stream.on('error', reject);
      stream.resume();
    });
  },
};

/** clamd INSTREAM client. Raise `StreamMaxLength` in clamd.conf to >= 3G for large files. */
export class ClamAvScanner implements Scanner {
  name = 'clamav';
  constructor(private host: string, private port: number) {}

  scan(stream: Readable): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      let reply = '';
      sock.setTimeout(30 * 60_000, () => sock.destroy(new Error('clamd timeout')));
      sock.on('data', (d) => (reply += d.toString()));
      sock.on('error', reject);
      sock.on('close', () => {
        const r = reply.replace(/\0/g, '').trim();
        if (/OK$/.test(r)) return resolve({ clean: true });
        const m = /stream: (.+) FOUND$/.exec(r);
        if (m) return resolve({ clean: false, signature: m[1] });
        reject(new Error(`unexpected clamd reply: ${r || '(empty)'}`));
      });
      sock.write('zINSTREAM\0');
      stream.on('data', (chunk: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        if (!sock.write(Buffer.concat([len, chunk]))) {
          stream.pause();
          sock.once('drain', () => stream.resume());
        }
      });
      stream.on('end', () => sock.write(Buffer.alloc(4)));
      stream.on('error', (e) => sock.destroy(e));
    });
  }
}

let scanner: Scanner | undefined;
export function getScanner(): Scanner {
  if (!scanner) {
    const c = config();
    scanner = c.SCANNER === 'clamav' ? new ClamAvScanner(c.CLAMAV_HOST, c.CLAMAV_PORT) : noopScanner;
  }
  return scanner;
}
export function setScanner(s: Scanner | undefined) {
  scanner = s;
}
