/**
 * 全局构建并发闸（cross-branch build concurrency gate）。
 *
 * 病根（2026-06-22 用户反馈「构建效率太低 / 一个构建要 11 分钟」）：
 * CDS 不构建 docker 镜像，而是每次部署都在临时容器里跑 `pnpm install + 编译`
 * / `dotnet build`。这些是 CPU 密集的活，且**没有任何并发上限**——多个分支
 * 同时部署时，N 个构建一起把宿主 18 核吃满，彼此饿 CPU，每个反而更慢
 * （实测同一分支 isolated ~300s，撞上并发时 admin 构建膨胀到 845s）。
 *
 * 本闸把同时进行的构建数限制为 `CDS_MAX_CONCURRENT_BUILDS`（默认 3），其余
 * 排队。配合调用方把排队状态写进部署日志（见 branches.ts 部署循环），用户
 * 看到的是「排队中，前面还有 N 个」而不是一个看起来卡死的 spinner
 * （expectation-management.md：等待必须可感知，排队 ≠ 卡死）。
 *
 * 2026-07-16 队列堵死复盘（线上 active=3/queued=54，消化 ~12/小时）后的扩展：
 * - **等待可取消**：被 supersede/取消的部署此前会僵尸排队（占 FIFO 位置、
 *   醒来才抛错），队列数字被撑大、run 账本被 15s 排队心跳养成幽灵。现在
 *   `acquireBuildSlot` 支持 `signal`（排队中即时踢出）与 `isCancelled`
 *   （槽位转移时惰性跳过），僵尸最多驻留一个刷新周期。
 * - **持有者身份**：Waiter/holder 携带 branchId/profileId/runId，
 *   `buildGateStatus()` 透出 holders/waiters 明细，运维可以回答
 *   「这 3 个槽被谁占着」而不是只看到一个数字。
 * - **上限可动态供给**：`setMaxConcurrentBuildsProvider` 允许 CDS 系统设置
 *   在运行时调整上限（env 变量仍是最高优先级 override）；`pumpWaiters()`
 *   在上调后立即唤醒排队者（旧实现只在 release 时唤醒，上调不生效）。
 *
 * 语义要点：
 * - FIFO：先排队先得槽位，保证「前面还有 N 个」是真实位置、不会饿死。
 * - 槽位转移（slot transfer）：release 时若有等待者，直接把槽位交给它而**不**
 *   先 active--，避免「release 与被唤醒者的 active++ 之间插入一个快路径 acquire」
 *   导致瞬时超额（over-subscription）。active 只在快路径 acquire 与 pumpWaiters
 *   唤醒时 +1，只在 release 且无存活等待者时 -1。
 * - 纯内存、单进程：CDS 是单 Node 进程（见根 CLAUDE.md 单线程讨论），无需跨进程
 *   锁；check 与 active++ 之间没有 await，天然原子。
 */

const DEFAULT_MAX_CONCURRENT_BUILDS = 3;

/**
 * 运行时上限供给器（CDS 系统设置注入）。env 变量优先于它——env 是运维的
 * 最终 override 通道（改 .cds.env + 重启），供给器是免重启的日常调节通道。
 */
let maxProvider: (() => number | undefined) | null = null;

export function setMaxConcurrentBuildsProvider(fn: (() => number | undefined) | null): void {
  maxProvider = fn;
}

/** 读取并发上限。每次读取（而非缓存）以便运行时调整即时生效。 */
export function maxConcurrentBuilds(): number {
  const raw = parseInt(process.env.CDS_MAX_CONCURRENT_BUILDS || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const provided = maxProvider?.();
  if (typeof provided === 'number' && Number.isFinite(provided) && provided > 0) {
    return Math.floor(provided);
  }
  return DEFAULT_MAX_CONCURRENT_BUILDS;
}

/** 槽位持有者/等待者身份，用于运维可观测（「这 3 个槽被谁占着」）。 */
export interface BuildGateHolder {
  branchId?: string;
  profileId?: string;
  runId?: string;
  operationId?: string;
  label?: string;
}

/** 排队等待被取消（signal abort / isCancelled 判真）时 acquire 的拒绝错误。 */
export class BuildSlotCancelledError extends Error {
  constructor(readonly reason: string) {
    super(`构建槽位等待已取消: ${reason}`);
    this.name = 'BuildSlotCancelledError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  holder?: BuildGateHolder;
  isCancelled?: () => boolean;
  /** 移除 abort listener（防泄漏），出队（无论 resolve/reject）时调用。 */
  cleanup?: () => void;
}

let active = 0;
const waiters: Waiter[] = [];
/** 活跃持有者明细（token → 身份 + 拿到槽的时刻）。 */
const holders = new Map<symbol, BuildGateHolder & { acquiredAt: string }>();

/** 已授予的构建槽位；务必在 finally 里 release()（可重复调用，幂等）。 */
export interface BuildSlot {
  release(): void;
}

export interface AcquireOptions {
  /**
   * 仅当调用方需要排队时触发一次，带当前排队位置信息。
   * @param info.ahead  在我前面、同样在等待的构建数（不含正在构建的）
   * @param info.active 当前正在构建的数量
   * @param info.max    并发上限
   */
  onQueued?(info: { ahead: number; active: number; max: number }): void;
  /** 等待结束、拿到槽位时触发（仅排过队的调用方会收到）。 */
  onStart?(info: { waitedMs: number }): void;
  /** 持有者身份（观测用，不参与调度决策）。 */
  holder?: BuildGateHolder;
  /** 排队中被 abort → 立即从队列摘除并以 BuildSlotCancelledError 拒绝。 */
  signal?: AbortSignal;
  /**
   * 惰性取消判定：槽位转移轮到它时若判真，跳过它（reject）把槽给下一个。
   * 用于「租约被 supersede 但没人主动 abort」的兜底，僵尸不再消费真实槽位。
   */
  isCancelled?: () => boolean;
}

/** 兼容旧名（历史调用方只用 onQueued/onStart）。 */
export type AcquireObserver = Pick<AcquireOptions, 'onQueued' | 'onStart'>;

function grantSlot(holder: BuildGateHolder | undefined): BuildSlot {
  const token = Symbol('build-slot');
  holders.set(token, { ...(holder || {}), acquiredAt: new Date().toISOString() });
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      holders.delete(token);
      // 槽位转移：跳过（并拒绝）已取消的等待者，交给第一个仍存活的。
      let next = waiters.shift();
      while (next) {
        next.cleanup?.();
        if (next.isCancelled?.()) {
          next.reject(new BuildSlotCancelledError('排队期间操作已被取消/取代'));
          next = waiters.shift();
          continue;
        }
        // 槽位直接转移给下一个等待者：不动 active（它继承当前这把槽位）。
        next.resolve();
        return;
      }
      active -= 1;
    },
  };
}

/**
 * 申请一个构建槽位。槽位充足立即返回；否则排队等待（FIFO）。
 * 调用方拿到 BuildSlot 后必须在 finally 中 release()。
 * 排队中被 signal abort 或转移时 isCancelled 判真 → 以 BuildSlotCancelledError 拒绝。
 */
export async function acquireBuildSlot(opts?: AcquireOptions): Promise<BuildSlot> {
  if (opts?.signal?.aborted) {
    throw new BuildSlotCancelledError('进入排队前已被取消');
  }
  if (opts?.isCancelled?.()) {
    throw new BuildSlotCancelledError('进入排队前操作已失效');
  }
  const max = maxConcurrentBuilds();
  if (active < max) {
    active += 1;
    return grantSlot(opts?.holder);
  }
  const enqueuedAt = Date.now();
  opts?.onQueued?.({ ahead: waiters.length, active, max });
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      enqueuedAt,
      holder: opts?.holder,
      isCancelled: opts?.isCancelled,
    };
    if (opts?.signal) {
      const signal = opts.signal;
      const onAbort = () => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new BuildSlotCancelledError('排队等待被中止'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
    }
    waiters.push(waiter);
  });
  // 被唤醒 = 槽位已转移给我（或 pumpWaiters 已 active++），不再重复 ++。
  opts?.onStart?.({ waitedMs: Date.now() - enqueuedAt });
  return grantSlot(opts?.holder);
}

/**
 * 上限上调后立即唤醒排队者。旧实现只在 release 时唤醒——上调上限后要等
 * 下一次 release 才生效。系统设置调高上限时调用本函数即时放行。
 * 与槽位转移不同，这里是**新增**槽位：每唤醒一个 active += 1。
 */
export function pumpWaiters(): number {
  const max = maxConcurrentBuilds();
  let woken = 0;
  while (active < max && waiters.length > 0) {
    const next = waiters.shift()!;
    next.cleanup?.();
    if (next.isCancelled?.()) {
      next.reject(new BuildSlotCancelledError('排队期间操作已被取消/取代'));
      continue;
    }
    active += 1;
    woken += 1;
    next.resolve();
  }
  return woken;
}

/** 当前闸门快照，供运维/日志/状态接口展示。holders/waiters 为身份明细。 */
export function buildGateStatus(): {
  active: number;
  queued: number;
  max: number;
  holders: Array<BuildGateHolder & { acquiredAt: string }>;
  waiters: Array<BuildGateHolder & { enqueuedAt: string }>;
} {
  return {
    active,
    queued: waiters.length,
    max: maxConcurrentBuilds(),
    holders: [...holders.values()],
    waiters: waiters.map((w) => ({ ...(w.holder || {}), enqueuedAt: new Date(w.enqueuedAt).toISOString() })),
  };
}

/** 仅供测试：重置内部状态（生产代码不应调用）。遗留等待者一律拒绝防泄漏。 */
export function __resetBuildGateForTest(): void {
  active = 0;
  for (const w of waiters) {
    w.cleanup?.();
    w.reject(new BuildSlotCancelledError('test reset'));
  }
  waiters.length = 0;
  holders.clear();
  maxProvider = null;
}
