import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

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
  private readonly active = new Map<symbol, { paths: string[]; shared: boolean; uncertain: boolean;
    purpose: 'operation' | 'claim' | 'destruction' }>();
  private readonly claimOwner = new AsyncLocalStorage<symbol>();
  constructor(private readonly maxActive = 128) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 128) throw new Error('Invalid worktree activity capacity');
  }
  tryAcquire(paths: readonly string[], shared = false): {
    owner: symbol; extend(paths: readonly string[]): boolean; markDestructive(): boolean;
    markUncertain(): void; release(): void;
  } | null {
    return this.acquire(paths, shared, 'operation');
  }
  private acquire(paths: readonly string[], shared: boolean, purpose: 'operation' | 'claim', parent?: symbol) {
    if (this.active.size >= this.maxActive) return null;
    const id = Symbol('owned-worktree');
    const claim = parent && this.active.get(parent);
    const authorizedParent = claim?.purpose === 'claim' && !claim.uncertain ? parent : undefined;
    const extend = (more: readonly string[]): boolean => {
      const next = [...new Set([...(this.active.get(id)?.paths ?? []), ...more.map(normalized)])];
      if (next.length > 8 || next.some(p => Buffer.byteLength(p) > 8192)) return false;
      if ([...this.active].some(([owner, held]) => owner !== id && owner !== authorizedParent
        && (!shared || !held.shared || held.uncertain) && held.paths.some(a => next.some(b => related(a, b))))) return false;
      this.active.set(id, { paths: next, shared, uncertain: this.active.get(id)?.uncertain ?? false,
        purpose: this.active.get(id)?.purpose ?? purpose }); return true;
    };
    if (!extend(paths)) return null;
    return { owner: id, extend, markDestructive: () => {
      const held = this.active.get(id); if (!held || held.shared || held.uncertain || held.purpose === 'claim') return false;
      held.purpose = 'destruction'; return true;
    }, markUncertain: () => { const held = this.active.get(id); if (held) held.uncertain = true; },
      release: () => { this.active.delete(id); } };
  }
  /** 派发前仍允许台账认领并跳过；删除授权后不能让同路径认领成功。 */
  assertClaimable(paths: readonly string[]): void {
    const claims = paths.filter(p => !!p).map(normalized);
    if ([...this.active.values()].some(held => (held.purpose === 'destruction' || held.uncertain)
      && held.paths.some(a => claims.some(b => related(a, b))))) throw new WorktreeClaimHeldError();
  }
  /** 真实创建至同步/异步台账受理共用一份占用；子操作仍单独互斥，不放行兄弟创建。 */
  async withClaim<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    return this.execute(paths, operation, false, 'claim');
  }
  async run<T>(paths: readonly string[], operation: () => Promise<T>, shared = false): Promise<T> {
    return this.execute(paths, operation, shared, 'operation');
  }
  private async execute<T>(paths: readonly string[], operation: () => Promise<T>, shared: boolean,
    purpose: 'operation' | 'claim'): Promise<T> {
    const lease = this.acquire(paths, shared, purpose, purpose === 'operation' ? this.claimOwner.getStore() : undefined);
    if (!lease) throw new Error('工作目录正在创建或回收，请稍后重试。');
    let cleanupUnknown = false;
    try {
      const canonical = await Promise.all(paths.map(p => canonicalPath(normalized(p))));
      if (!lease.extend(canonical)) throw new Error('工作目录的实际归属正在处理中，请稍后重试。');
      return await (purpose === 'claim' ? this.claimOwner.run(lease.owner, operation) : operation());
    } catch (error) {
      // 独立执行器只有归属清理确认后才给普通失败；cleanup表示旧进程可能仍写目录。
      // 无清理回执不能释放给创建或回收。本批只保留当前进程中的围栏，不冒称重启恢复。
      cleanupUnknown = (error as { code?: string } | null)?.code === 'cleanup';
      if (cleanupUnknown) lease.markUncertain();
      throw error;
    } finally { if (!cleanupUnknown) lease.release(); }
  }
  getStats(): { active: number; paths: number } {
    return { active: this.active.size, paths: [...this.active.values()].reduce((n, held) => n + held.paths.length, 0) };
  }
}

export class WorktreeClaimHeldError extends Error {
  readonly code = 'worktree-held';
  constructor() { super('源码目录正在回收或清理尚未确认，请等待完成后重试。'); }
}

export const worktreePathActivity = new WorktreePathActivity();
