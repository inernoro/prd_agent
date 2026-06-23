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
 * 语义要点：
 * - FIFO：先排队先得槽位，保证「前面还有 N 个」是真实位置、不会饿死。
 * - 槽位转移（slot transfer）：release 时若有等待者，直接把槽位交给它而**不**
 *   先 active--，避免「release 与被唤醒者的 active++ 之间插入一个快路径 acquire」
 *   导致瞬时超额（over-subscription）。active 只在快路径 acquire 时 +1，只在
 *   release 且无等待者时 -1。
 * - 纯内存、单进程：CDS 是单 Node 进程（见根 CLAUDE.md 单线程讨论），无需跨进程
 *   锁；check 与 active++ 之间没有 await，天然原子。
 */

const DEFAULT_MAX_CONCURRENT_BUILDS = 3;

/** 读取并发上限。每次读取（而非缓存）以便运行时改环境变量即时生效。 */
export function maxConcurrentBuilds(): number {
  const raw = parseInt(process.env.CDS_MAX_CONCURRENT_BUILDS || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_CONCURRENT_BUILDS;
}

interface Waiter {
  resolve: () => void;
  enqueuedAt: number;
}

let active = 0;
const waiters: Waiter[] = [];

/** 已授予的构建槽位；务必在 finally 里 release()（可重复调用，幂等）。 */
export interface BuildSlot {
  release(): void;
}

export interface AcquireObserver {
  /**
   * 仅当调用方需要排队时触发一次，带当前排队位置信息。
   * @param info.ahead  在我前面、同样在等待的构建数（不含正在构建的）
   * @param info.active 当前正在构建的数量
   * @param info.max    并发上限
   */
  onQueued?(info: { ahead: number; active: number; max: number }): void;
  /** 等待结束、拿到槽位时触发（仅排过队的调用方会收到）。 */
  onStart?(info: { waitedMs: number }): void;
}

function makeSlot(): BuildSlot {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) {
        // 槽位直接转移给下一个等待者：不动 active（它继承当前这把槽位）。
        next.resolve();
      } else {
        active -= 1;
      }
    },
  };
}

/**
 * 申请一个构建槽位。槽位充足立即返回；否则排队等待（FIFO）。
 * 调用方拿到 BuildSlot 后必须在 finally 中 release()。
 */
export async function acquireBuildSlot(obs?: AcquireObserver): Promise<BuildSlot> {
  const max = maxConcurrentBuilds();
  if (active < max) {
    active += 1;
    return makeSlot();
  }
  const enqueuedAt = Date.now();
  obs?.onQueued?.({ ahead: waiters.length, active, max });
  await new Promise<void>((resolve) => {
    waiters.push({ resolve, enqueuedAt });
  });
  // 被唤醒 = 槽位已转移给我，active 保持不变（不再 ++）。
  obs?.onStart?.({ waitedMs: Date.now() - enqueuedAt });
  return makeSlot();
}

/** 当前闸门快照，供运维/日志/状态接口展示。 */
export function buildGateStatus(): { active: number; queued: number; max: number } {
  return { active, queued: waiters.length, max: maxConcurrentBuilds() };
}

/** 仅供测试：重置内部状态（生产代码不应调用）。 */
export function __resetBuildGateForTest(): void {
  active = 0;
  waiters.length = 0;
}
