import fs from 'node:fs/promises';
import path from 'node:path';

export interface WorktreeDirectoryIdentity {
  entryPath: string;
  entry: { dev: string; ino: string; ctimeNs: string; mtimeNs: string; link?: string };
  target?: { path: string; dev: string; ino: string; ctimeNs: string; mtimeNs: string };
}

/** 读取路径对象及链接目标；读期间换对象或占用未知均不提供可删除身份。 */
export async function readWorktreeDirectoryIdentity(dir: string, followTarget = true): Promise<WorktreeDirectoryIdentity | null> {
  try {
    const entry = await fs.lstat(dir, { bigint: true });
    const link = entry.isSymbolicLink() ? await fs.readlink(dir) : undefined;
    let target: WorktreeDirectoryIdentity['target'];
    if (entry.isSymbolicLink() && followTarget) {
      try {
        const real = await fs.realpath(dir), stat = await fs.lstat(real, { bigint: true });
        target = { path: real, dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(stat.ctimeNs), mtimeNs: String(stat.mtimeNs) };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    }
    const entryPath = path.join(await fs.realpath(path.dirname(dir)), path.basename(dir));
    const after = await fs.lstat(dir, { bigint: true });
    if (entry.dev !== after.dev || entry.ino !== after.ino || entry.ctimeNs !== after.ctimeNs || entry.mtimeNs !== after.mtimeNs) return null;
    return { entryPath, entry: { dev: String(entry.dev), ino: String(entry.ino), ctimeNs: String(entry.ctimeNs),
      mtimeNs: String(entry.mtimeNs), ...(link === undefined ? {} : { link }) }, ...(target ? { target } : {}) };
  } catch { return null; }
}

export function sameWorktreeDirectoryIdentity(a: WorktreeDirectoryIdentity, b: WorktreeDirectoryIdentity,
  entryOnly = false): boolean {
  return JSON.stringify(entryOnly ? a.entry : a) === JSON.stringify(entryOnly ? b.entry : b);
}

const normalized = (p: string) => path.resolve(p);
const related = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);

async function canonicalPath(p: string): Promise<string> {
  let current = p; const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current); if (parent === current) throw error;
      missing.push(path.basename(current)); current = parent;
    }
  }
}

/** 同一控制进程全部WorktreeService实例共用；不冒称跨进程或外部手工写入互斥。 */
export class WorktreePathActivity {
  private readonly active = new Map<symbol, string[]>();
  constructor(private readonly maxActive = 128) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 128) throw new Error('Invalid worktree activity capacity');
  }
  tryAcquire(paths: readonly string[]): { extend(paths: readonly string[]): boolean; release(): void } | null {
    if (this.active.size >= this.maxActive) return null;
    const id = Symbol('owned-worktree');
    const extend = (more: readonly string[]): boolean => {
      const next = [...new Set([...(this.active.get(id) ?? []), ...more.map(normalized)])];
      if (next.length > 8 || next.some(p => Buffer.byteLength(p) > 8192)) return false;
      if ([...this.active].some(([owner, held]) => owner !== id && held.some(a => next.some(b => related(a, b))))) return false;
      this.active.set(id, next); return true;
    };
    if (!extend(paths)) return null;
    return { extend, release: () => { this.active.delete(id); } };
  }
  async run<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const lease = this.tryAcquire(paths);
    if (!lease) throw new Error('工作目录正在创建或回收，请稍后重试。');
    let cleanupUnknown = false;
    try {
      const canonical = await Promise.all(paths.map(p => canonicalPath(normalized(p))));
      if (!lease.extend(canonical)) throw new Error('工作目录的实际归属正在处理中，请稍后重试。');
      return await operation();
    } catch (error) {
      // 独立执行器只有归属清理确认后才给普通失败；cleanup表示旧进程可能仍写目录。
      // 无清理回执不能释放给创建或回收。本批只保留当前进程中的围栏，不冒称重启恢复。
      cleanupUnknown = (error as { code?: string } | null)?.code === 'cleanup';
      throw error;
    } finally { if (!cleanupUnknown) lease.release(); }
  }
  getStats(): { active: number; paths: number } {
    return { active: this.active.size, paths: [...this.active.values()].reduce((n, p) => n + p.length, 0) };
  }
}

export const worktreePathActivity = new WorktreePathActivity();
