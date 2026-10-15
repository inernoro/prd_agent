/**
 * JsonStateBackingStore — the P3 Part 1 backing store that reads and
 * writes state.json from disk.
 *
 * 2026-07-09 性能改造：save() 不再每次同步 stringify + fsync 落盘。
 * state.ts 里有 70+ 处 this.save()（部署日志 append 风暴 / 调和器遍历），
 * 旧实现每次调用都在事件循环上同步写全量 state 两遍（主文件 + .bak），
 * state 越大阻塞越久。现对齐 mongo-split-store 的模式：
 *
 *   - save() 只记 dirty 引用；setImmediate 在本 tick 末把一连串 save
 *     合并成一次序列化（序列化即快照，之后 live state 被 mutate 也不影响
 *     写盘内容），异步串行落盘；慢IO期间普通save只合并脏引用。
 *   - 至多一个在途快照和一个显式flush待写快照，不累积全量字符串队列。
 *   - 写路径仍保持原子语义：独占临时文件 → fsync → rename。
 *   - .bak 轮转从「每次 save 写一份」改为 ≥60s 节流（每次 save 双倍磁盘
 *     写是旧实现的第二个放大器）。
 *   - 新增 flush()：把 pending 写强制落盘并等待完成，进程 shutdown 前调用
 *     （见 index.ts 的 shutdown()），语义与 mongo-split 的 flush 一致。
 *
 * "unique tmp path per write" 细节保留 —— 两个并发进程（tsx watch 重载 +
 * 心跳 save）不得共享 tmp 文件名，否则 rename 会 ENOENT。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CdsState } from '../../types.js';
import type { StateBackingStore } from './backing-store.js';
import { timeMainThreadSection } from '../../services/main-thread-diagnostics.js';

/** Keep the last N rolling backups. Old ones are pruned after each backup write. */
export const MAX_STATE_BACKUPS = 10;

/** .bak 快照的最小写入间隔（每次 save 都写一份完整副本是旧实现的双倍磁盘放大器）。 */
const BACKUP_MIN_INTERVAL_MS = 60_000;

/**
 * 活实例登记（2026-07-09）：save() 去抖异步化后，测试收尾 rmSync 临时目录时
 * 在途写会往正被删除的目录里落新文件 → ENOTEMPTY 抽风（CI 已三次撞上同族）。
 * WeakRef 登记全部活实例，vitest 全局 afterEach 统一 flushAllJsonStateStores()
 * 等在途写落地后再清目录——一处兜底覆盖所有套件。生产开销：仅一个 WeakRef 集合。
 */
const LIVE_STORES = new Set<WeakRef<JsonStateBackingStore>>();

/** 等待所有活实例的在途写落地（测试收尾兜底用；单实例失败不阻断其他实例）。 */
export async function flushAllJsonStateStores(): Promise<void> {
  for (const ref of [...LIVE_STORES]) {
    const store = ref.deref();
    if (!store) {
      LIVE_STORES.delete(ref);
      continue;
    }
    await store.flush().catch(() => {});
  }
}

/** 同进程、同规范化目标只由一个写链执行；跨进程不裁决快照新旧或合并状态。 */
const TARGET_WRITES = new Map<string, Promise<void>>();
function enqueueTargetWrite(filePath: string, write: () => Promise<void>): Promise<void> {
  const key = path.resolve(filePath);
  const pending = (TARGET_WRITES.get(key) || Promise.resolve()).catch(() => {}).then(write);
  TARGET_WRITES.set(key, pending);
  void pending.finally(() => { if (TARGET_WRITES.get(key) === pending) TARGET_WRITES.delete(key); }).catch(() => {});
  return pending;
}

/** 仅显式注入诊断观察者时计算快照摘要；生产默认不散列完整状态或暴露快照正文。 */
export interface JsonStateWriteEvent {
  storeId: string; writeId: string; filePath: string; tempPath: string; timestampMs: number;
  purpose: 'primary' | 'backup'; phase: 'opened' | 'synced' | 'committed' | 'failed';
  bytes: number; sha256: string; errorName?: string; errorCode?: string;
}

export class JsonStateBackingStore implements StateBackingStore {
  readonly kind = 'json' as const;

  /** 本 tick 内最新的 live state 引用；setImmediate 末合并写。 */
  private dirtyState: CdsState | null = null;
  private flushScheduled = false;
  private writeGeneration = 0;
  private dirtyGeneration = 0;
  private persistedGeneration = 0;
  private failedGeneration = 0;
  private lastWriteError: unknown;
  private writeInFlight = false;
  private inFlightGeneration = 0;
  private pendingSnapshot: { generation: number; serialized: string } | null = null;
  private flushWaiters: Array<{ generation: number; resolve: () => void; reject: (error: unknown) => void }> = [];
  /** 最近一次备份时间；备份失败不影响主文件边界。 */
  private lastBackupAtMs = 0;

  private readonly storeId = randomUUID();

  constructor(private readonly filePath: string, private readonly options: { onWrite?: (event: JsonStateWriteEvent) => void } = {}) {
    LIVE_STORES.add(new WeakRef(this));
  }

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
    // timestamp (see writeBackup() below).
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    if (!fs.existsSync(dir)) return null;

    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak.`) && !f.includes('.tmp.'))
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
    this.dirtyState = state;
    this.dirtyGeneration = ++this.writeGeneration;
    this.scheduleSnapshot();
  }

  private scheduleSnapshot(): void {
    if (this.flushScheduled || this.writeInFlight || !this.dirtyState) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      // A preceding critical flush may have started disk IO already.
      if (!this.writeInFlight) this.snapshotAndEnqueue();
    });
  }

  /** Freeze this barrier's state; never let another observer consume its error. */
  async flush(): Promise<void> {
    const target = this.writeGeneration;
    if (this.dirtyState) this.snapshotAndEnqueue();
    if (target <= this.persistedGeneration) return;
    if (target <= this.failedGeneration && this.lastWriteError) throw this.lastWriteError;
    await new Promise<void>((resolve, reject) => {
      this.flushWaiters.push({ generation: target, resolve, reject });
    });
  }

  private snapshotAndEnqueue(): void {
    const live = this.dirtyState;
    if (!live) return;
    const generation = this.dirtyGeneration;
    this.dirtyState = null;
    let serialized: string;
    try {
      serialized = timeMainThreadSection('state.persist.serialize.json-file', () => JSON.stringify(live, null, 2), (out) => out.length);
    } catch (error) {
      // Older valid frozen snapshots still own their independent barriers.
      const protectedThrough = Math.max(this.persistedGeneration, this.inFlightGeneration,
        this.pendingSnapshot?.generation || 0);
      this.failBarrier(generation, error, protectedThrough);
      return;
    }
    // One latest full snapshot covers all earlier unsaved generations.
    this.pendingSnapshot = { generation, serialized };
    this.drainWrites();
  }

  private failBarrier(generation: number, error: unknown, protectedThrough = 0): void {
    if (generation >= this.failedGeneration) {
      this.failedGeneration = generation;
      this.lastWriteError = error;
    }
    const waiting: typeof this.flushWaiters = [];
    for (const waiter of this.flushWaiters) {
      if (waiter.generation > protectedThrough && waiter.generation <= generation) waiter.reject(error);
      else waiting.push(waiter);
    }
    this.flushWaiters = waiting;
  }

  private drainWrites(): void {
    if (this.writeInFlight || !this.pendingSnapshot) return;
    this.writeInFlight = true;
    void (async () => {
      try {
        while (this.pendingSnapshot) {
          const snapshot = this.pendingSnapshot;
          this.pendingSnapshot = null;
          this.inFlightGeneration = snapshot.generation;
          try {
            await enqueueTargetWrite(this.filePath, () => this.writeToDisk(snapshot.serialized));
            this.persistedGeneration = snapshot.generation;
            if (snapshot.generation >= this.failedGeneration) this.lastWriteError = undefined;
            const waiting: typeof this.flushWaiters = [];
            for (const waiter of this.flushWaiters) {
              if (waiter.generation <= snapshot.generation) waiter.resolve();
              else waiting.push(waiter);
            }
            this.flushWaiters = waiting;
          } catch (error) {
            console.error(`[state] async state.json write failed: ${(error as Error).message}`);
            this.failBarrier(snapshot.generation, error);
          }
        }
      } finally {
        this.inFlightGeneration = 0;
        this.writeInFlight = false;
        this.scheduleSnapshot();
      }
    })();
  }

  private async writeToDisk(serialized: string): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    await this.atomicWrite(this.filePath, serialized, 'primary');

    // Rolling backup（≥60s 节流；best-effort，失败不影响主写）
    const now = Date.now();
    if (now - this.lastBackupAtMs >= BACKUP_MIN_INTERVAL_MS) {
      this.lastBackupAtMs = now;
      try {
        await this.writeBackup(serialized);
      } catch (err) {
        console.warn(`[state] backup rotation failed: ${(err as Error).message}`);
      }
    }
  }

  private async atomicWrite(target: string, serialized: string, purpose: 'primary' | 'backup'): Promise<void> {
    const writeId = randomUUID();
    const tmpPath = `${target}.tmp.${process.pid}.${writeId}`;
    const observed = this.options.onWrite ? { storeId: this.storeId, writeId, filePath: path.resolve(target), tempPath: path.resolve(tmpPath),
      timestampMs: Date.now(), purpose, bytes: Buffer.byteLength(serialized), sha256: createHash('sha256').update(serialized).digest('hex') } : undefined;
    const emit = (phase: JsonStateWriteEvent['phase'], error?: unknown) => {
      if (!observed) return;
      try { this.options.onWrite?.({ ...observed, phase, ...(error ? { errorName: (error as Error).name, errorCode: (error as NodeJS.ErrnoException).code } : {}) }); }
      catch { /* 诊断观察者不能改变关键状态确认结果 */ }
    };
    let handle: fs.promises.FileHandle | undefined;
    let opened = false, committed = false;
    try {
      // wx不截断任何其他写入器文件；即使随机标识碰撞也明确失败，不删除未拥有的文件。
      handle = await fs.promises.open(tmpPath, 'wx', 0o600); opened = true; emit('opened');
      await handle.writeFile(serialized); await handle.sync(); emit('synced');
      await handle.close(); handle = undefined;
      await fs.promises.rename(tmpPath, target); committed = true; emit('committed');
    } catch (error) { emit('failed', error); throw error; }
    finally {
      if (handle) await handle.close().catch(() => {});
      if (opened && !committed) await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * Write a .bak.<timestamp> snapshot and prune old backups.
   * We use the already-serialized string to avoid double serialization.
   */
  private async writeBackup(serialized: string): Promise<void> {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `${base}.bak.${stamp}`);
    await this.atomicWrite(backupPath, serialized, 'backup');

    // Prune: keep MAX_STATE_BACKUPS newest, delete the rest
    const backups = (await fs.promises.readdir(dir))
      .filter((f) => f.startsWith(`${base}.bak.`) && !f.includes('.tmp.'))
      .sort() // ISO timestamps sort chronologically
      .reverse();
    for (let i = MAX_STATE_BACKUPS; i < backups.length; i++) {
      try {
        await fs.promises.unlink(path.join(dir, backups[i]));
      } catch {
        // ignore individual deletion failures
      }
    }
  }
}
