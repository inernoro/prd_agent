import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROBE_MARKER_HEADER, probeRequestHeaders } from './probe-marker.js';

export const ACTIVITY_MAX_AGE_MS = 15_000;
const MAX_ROWS = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
interface ActivityRow { branchId: string; probeHash: string; at: number; active: number }
interface ActivitySnapshot { version: 1; at: number; overflow: boolean; rows: ActivityRow[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** 私有本机快照只含分支、时间、计数与探测令牌摘要，不含 URL、Cookie 或业务数据。 */
export class ForwarderActivityWriter {
  private rows = new Map<string, ActivityRow>();
  private overflowed = false;
  private writing = false;
  constructor(private readonly file: string, private readonly now = Date.now) {}

  begin(branchId: string | undefined, headers: Record<string, unknown>, url: string): () => void {
    if (!branchId || branchId.length > 512 || /^\/(?:_cds|__forwarder)(?:\/|$|\?)/.test(url)) return () => {};
    const raw = headers[PROBE_MARKER_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    const probeHash = typeof token === 'string' && token ? hash(token) : '';
    const key = `${branchId}\0${probeHash}`;
    let row = this.rows.get(key);
    if (!row) {
      this.prune();
      if (this.rows.size >= MAX_ROWS) {
        // 丢失任何访问后都不能自动恢复“完整”标记，否则遗漏时间会再次污染 LRU。
        this.overflowed = true;
        return () => {};
      }
      row = { branchId, probeHash, at: this.now(), active: 0 };
      this.rows.set(key, row);
    }
    row.at = this.now(); row.active += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true; row!.active -= 1; row!.at = this.now();
    };
  }

  private prune(): void {
    for (const [key, row] of this.rows) if (!row.active && this.now() - row.at > 86400_000) this.rows.delete(key);
  }

  async flush(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      this.prune();
      const snapshot: ActivitySnapshot = { version: 1, at: this.now(), overflow: this.overflowed, rows: [...this.rows.values()] };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
      await fs.rename(temp, this.file);
    } finally { this.writing = false; await fs.unlink(temp).catch(() => {}); }
  }
}

/** 不把读取时间当访问时间；旧快照不得持续刷新 LRU，缺证据时停止自动降温。 */
export class ForwarderActivityReader {
  private snapshot: ActivitySnapshot | null = null;
  private reading = false;
  private readonly trustedProbeHash = hash(probeRequestHeaders()[PROBE_MARKER_HEADER]);
  constructor(private readonly file: string, private readonly now = Date.now) {}

  async refresh(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      if ((await fs.stat(this.file)).size > MAX_BYTES) throw new Error('activity snapshot too large');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8')) as ActivitySnapshot;
      if (value.version !== 1 || !Number.isFinite(value.at) || value.at > this.now()
        || typeof value.overflow !== 'boolean' || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS
        || value.rows.some(row => !row || typeof row.branchId !== 'string' || !row.branchId || row.branchId.length > 512
          || typeof row.probeHash !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(row.probeHash)
          || !Number.isFinite(row.at) || row.at > value.at || row.at < 0
          || !Number.isSafeInteger(row.active) || row.active < 0)) throw new Error('invalid activity snapshot');
      this.snapshot = value;
    } catch { this.snapshot = null; }
    finally { this.reading = false; }
  }

  isFresh(): boolean {
    return Boolean(this.snapshot && !this.snapshot.overflow && this.now() >= this.snapshot.at
      && this.now() - this.snapshot.at <= ACTIVITY_MAX_AGE_MS);
  }

  activity(branchId: string): { at: number; active: boolean } | null {
    if (!this.isFresh()) return null;
    const rows = this.snapshot!.rows.filter(row => row.branchId === branchId && row.probeHash !== this.trustedProbeHash);
    return { at: Math.max(0, ...rows.map(row => row.at)), active: rows.some(row => row.active > 0) };
  }
}
