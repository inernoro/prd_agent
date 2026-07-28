/**
 * release-target-lock — 发布目标的**进程级**互斥标记。
 *
 * 为什么需要它，而不是继续靠 assertTargetFree：
 *
 * 发布与发布之间本来就互斥 —— 判据是 run 台账（`getReleaseRuns` 里的非终态 run），
 * 台账在 stateService 里，**跨 ReleaseService 实例可见**，所以哪怕两个实例也拦得住。
 *
 * 产物回收没有这个性质：它不建 run、不留任何台账痕迹。于是
 *   1. `assertTargetFree` 对它只是一次**时间点**检查 —— 检查通过之后、
 *      `git worktree remove` / `prune` / `rm -rf` 真正执行的那几十秒里，
 *      一次新的发布完全可以启动；
 *   2. 更糟的是 server.ts 里巡检器与 releases 路由**各 new 了一个 ReleaseService**，
 *      两张 `inFlight` 表互不可见（debt #6 已记），所以连「上一次执行体还没退出」
 *      这一半都跨不过去。
 * 结果是 janitor 的回收能撞上正在跑的发布：`worktree prune` 与 `worktree add`
 * 抢同一个 git 仓库，把一次本该成功的生产发布搞失败（Codex P2）。
 *
 * 这里的标记是**模块级单例**，因此与实例数无关。刻意做成「拿不到就失败」而不是排队：
 * 回收是周期性的，等下一轮就行；发布则应该立刻告诉用户「正在回收，稍候再发」，
 * 而不是排一个几十秒后才动的队（照 concurrency-gate-discipline 的纪律）。
 */

/** 持有超过它即视为泄漏，下一次请求直接抢走。没有这条，一次漏放锁就永久卡死该目标。 */
export const RELEASE_TARGET_LOCK_STALE_MS = 30 * 60_000;

export type ReleaseTargetLockKind = '产物回收';

interface LockEntry {
  kind: ReleaseTargetLockKind;
  since: number;
}

const held = new Map<string, LockEntry>();

/** 便于测试注入时钟；生产恒为 Date.now。 */
let clock: () => number = () => Date.now();

export function setReleaseTargetLockClockForTest(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

export function resetReleaseTargetLocksForTest(): void {
  held.clear();
}

/** 当前持有者；空闲或已过期返回 null。过期条目顺手清掉，避免 Map 无界增长。 */
export function peekReleaseTargetLock(targetId: string): LockEntry | null {
  const entry = held.get(targetId);
  if (!entry) return null;
  if (clock() - entry.since >= RELEASE_TARGET_LOCK_STALE_MS) {
    held.delete(targetId);
    return null;
  }
  return entry;
}

/**
 * 尝试占用。成功返回释放函数，失败返回 null。
 * 释放函数幂等，且只释放**自己**那一次占用（被抢走之后再调不会误放别人的锁）。
 */
export function acquireReleaseTargetLock(
  targetId: string,
  kind: ReleaseTargetLockKind,
): (() => void) | null {
  if (!targetId) return null;
  if (peekReleaseTargetLock(targetId)) return null;
  const entry: LockEntry = { kind, since: clock() };
  held.set(targetId, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 身份校验：过期被别人抢走之后，这个 release 不许把别人的锁清掉。
    if (held.get(targetId) === entry) held.delete(targetId);
  };
}
