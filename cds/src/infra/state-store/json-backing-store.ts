/**
 * JsonStateBackingStore — the P3 Part 1 backing store that reads and
 * writes state.json from disk. This is a direct extraction of the
 * load/save logic that used to live inside StateService.
 *
 * It preserves the exact atomic write + rolling backup + recovery
 * semantics of the pre-P3 StateService so the refactor is 100%
 * behavior-preserving for existing deployments:
 *
 *   - Write path: state.json.tmp.<pid>.<ts> → fsync → rename
 *   - Backup rotation: state.json.bak.<ISO> (keep last MAX_STATE_BACKUPS)
 *   - Recovery on load: scan .bak.* files newest-first, return first
 *     parseable snapshot
 *
 * The "unique tmp path per write" detail matters for correctness —
 * two concurrent saves (e.g. `tsx watch` reloading while a heartbeat
 * save fires) must not race on a shared tmp file name, otherwise one
 * process's rename can fail with ENOENT. This was observed in B's CDS
 * after a hot reload and is the reason tmp files carry pid + timestamp.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CdsState } from '../../types.js';
import type { StateBackingStore } from './backing-store.js';

/** Keep the last N rolling backups. Old ones are pruned after each save. */
export const MAX_STATE_BACKUPS = 10;

export class JsonStateBackingStore implements StateBackingStore {
  readonly kind = 'json' as const;

  constructor(private readonly filePath: string) {}

  load(): CdsState | null {
    // Happy path: read the primary state file.
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(raw) as CdsState;
      } catch (err) {
        console.error(
          `[state] primary state.json unreadable: ${(err as Error).message}`,
        );
        console.error('[state] attempting to recover from rolling backups...');
      }
    }

    // Recovery path: scan .bak.* files, newest first. We trust ISO
    // timestamp sort order because the backup filenames embed the
    // timestamp (see save() below).
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    if (!fs.existsSync(dir)) return null;

    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak.`))
      .sort()
      .reverse();

    for (const bak of backups) {
      try {
        const raw = fs.readFileSync(path.join(dir, bak), 'utf-8');
        const parsed = JSON.parse(raw) as CdsState;
        console.warn(`[state] RECOVERED state from backup ${bak}`);
        return parsed;
      } catch {
        // try next backup
      }
    }

    return null;
  }

  save(state: CdsState): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const serialized = JSON.stringify(state, null, 2);

    // Unique tmp path per write — see class docstring for why this
    // matters. Two concurrent saves must not share a tmp filename.
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;

    // Atomic write: tmp → fsync → rename
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);

    // Rolling backup (best-effort; failures don't fail the save)
    try {
      this.rollBackups(serialized);
    } catch (err) {
      console.warn(`[state] backup rotation failed: ${(err as Error).message}`);
    }
  }

  /**
   * Write a .bak.<timestamp> snapshot and prune old backups.
   * We use the already-serialized string to avoid double serialization.
   */
  private rollBackups(serialized: string): void {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `${base}.bak.${stamp}`);
    fs.writeFileSync(backupPath, serialized);

    // Prune: keep MAX_STATE_BACKUPS newest, delete the rest
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak.`))
      .sort() // ISO timestamps sort chronologically
      .reverse();
    for (let i = MAX_STATE_BACKUPS; i < backups.length; i++) {
      try {
        fs.unlinkSync(path.join(dir, backups[i]));
      } catch {
        // ignore individual deletion failures
      }
    }
  }
}
