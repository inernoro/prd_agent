import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from '../workspace/primitives.js';
import type { WorkspacePackageFile } from '../workspace/transfer.js';

const retentionMs = 24 * 60 * 60 * 1000;
const capacity = 512 * 1024 * 1024;
const maxFilmBytes = 60 * 1024 * 1024;
const digestBytes = 32;
const filmName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.film$/;

// In an interrupted FFmpeg run a header can already exist. Require complete
// top-level boxes, video data and a movie index before exposing a recovery file.
export function hasCompletedMovie(bytes: Buffer): boolean {
  if (bytes.length < 32 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false;
  let hasIndex = false;
  let hasMedia = false;
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 8) return false;
    const marker = bytes.toString('ascii', offset + 4, offset + 8);
    const shortSize = bytes.readUInt32BE(offset);
    const headerSize = shortSize === 1 ? 16 : 8;
    if (bytes.length - offset < headerSize) return false;
    const size = shortSize === 1 ? Number(bytes.readBigUInt64BE(offset + 8))
      : shortSize === 0 ? bytes.length - offset : shortSize;
    if (size < headerSize || size > bytes.length - offset) return false;
    hasIndex ||= marker === 'moov' && size > headerSize;
    hasMedia ||= marker === 'mdat' && size > headerSize;
    offset += size;
  }
  return hasIndex && hasMedia;
}

export class FilmRecoveryStore {
  constructor(readonly directory: string) {}

  retain(runId: string, film: WorkspacePackageFile): boolean {
    const target = this.file(runId);
    if (!target || film.size > maxFilmBytes) return false;
    const bytes = Buffer.from(film.contentBase64, 'base64');
    if (!hasCompletedMovie(bytes) || bytes.length !== film.size || sha256(bytes) !== film.sha256) return false;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const entries = fs.readdirSync(this.directory, { withFileTypes: true })
      .filter(item => item.isFile() && filmName.test(item.name))
      .map(item => {
        const file = path.join(this.directory, item.name);
        return { file, stat: fs.statSync(file) };
      })
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    let used = entries.reduce((total, item) => total + item.stat.size, bytes.length + digestBytes);
    for (const { file, stat } of entries) {
      if (file === target) {
        used -= stat.size;
      } else if (Date.now() - stat.mtimeMs >= retentionMs || used > capacity) {
        fs.rmSync(file, { force: true });
        used -= stat.size;
      }
    }
    const pending = target + '.pending';
    try {
      const fd = fs.openSync(pending, 'w', 0o600);
      try {
        fs.writeFileSync(fd, Buffer.from(film.sha256, 'hex'));
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(pending, target);
    } finally {
      fs.rmSync(pending, { force: true });
    }
    return true;
  }

  read(runId: string): Buffer | undefined {
    const target = this.file(runId);
    if (!target) return undefined;
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > maxFilmBytes + digestBytes || Date.now() - stat.mtimeMs >= retentionMs) return undefined;
    const stored = fs.readFileSync(target);
    const bytes = stored.subarray(digestBytes);
    return hasCompletedMovie(bytes) && sha256(bytes) === stored.toString('hex', 0, digestBytes) ? bytes : undefined;
  }

  private file(runId: string): string | undefined {
    const name = runId + '.film';
    return filmName.test(name) ? path.join(this.directory, name) : undefined;
  }
}
