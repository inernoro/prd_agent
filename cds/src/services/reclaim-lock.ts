/**
 * 全局回收互斥（2026-07-27 宕机复盘 P2）。
 *
 * 事故当天人工恢复磁盘时，一执行 `docker prune` 就撞上
 * `a prune operation is already running`——janitor 的周期回收正在跑。docker daemon
 * 对 prune 只有一把全局锁，谁先拿到谁跑，后到的直接报错，恰好在最需要清盘的时刻
 * 添乱。CDS 自己也有多条回收路径（janitor 周期、启动首轮、未来的手工触发端点），
 * 它们之间同样只靠「同一个 sweep promise」这一层脆弱的去重。
 *
 * 这里给 CDS 侧的回收动作一把**进程内**的互斥锁，纪律照 concurrency-gate-discipline：
 * **拿不到就跳过本轮，不排队堆积**——回收是周期性的，等下一轮就行；排队只会把
 * 好几轮的回收压在一起，在磁盘已经紧张的时候制造更大的 IO 尖峰。
 *
 * 能力边界（必须说清）：这把锁管不到**宿主上的人**。人工敲 `docker prune` 仍然会与
 * CDS 撞车，那要靠运维手册里的安全命令（带 `label!=cds.protected=true` 过滤）和
 * 关键容器的保护标记来兜，不是一把进程内的锁能解决的。
 */

export interface ReclaimLockState {
  /** 当前持有者标识；null = 空闲。 */
  holder: string | null;
  /** 持有开始时间（毫秒）。 */
  since: number | null;
}

export interface ReclaimSkip {
  skipped: true;
  /** 跳过时正持有锁的那一方，写进日志便于回答「被谁挡了」。 */
  heldBy: string;
  heldForMs: number;
}

/**
 * 持有超过这个时长即视为泄漏（进程内不可能有正常回收跑这么久），
 * 下一次请求直接抢走。没有这条，一次漏放锁就能让回收**永久**停摆。
 */
export const RECLAIM_LOCK_STALE_MS = 30 * 60_000;

export class ReclaimLock {
  private holder: string | null = null;
  private since: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  getState(): ReclaimLockState {
    return { holder: this.holder, since: this.since };
  }

  /**
   * 跑一段回收动作；拿不到锁就跳过（返回 ReclaimSkip），不等待、不排队。
   * 无论成功还是抛错都会释放锁——漏放一次就等于永久停摆，这里不留侥幸。
   */
  async run<T>(holder: string, fn: () => Promise<T>): Promise<T | ReclaimSkip> {
    const nowMs = this.now();
    if (this.holder !== null) {
      const heldForMs = nowMs - (this.since ?? nowMs);
      if (heldForMs < RECLAIM_LOCK_STALE_MS) {
        return { skipped: true, heldBy: this.holder, heldForMs };
      }
      // 超时视为泄漏，记一笔并抢走：回收停摆比并发回收危险得多
      console.warn(
        `[reclaim-lock] 强制接管：持有者 ${this.holder} 已占用 ${Math.round(heldForMs / 60_000)} 分钟（疑似泄漏）`,
      );
    }
    this.holder = holder;
    this.since = nowMs;
    try {
      return await fn();
    } finally {
      this.holder = null;
      this.since = null;
    }
  }
}

/** 判定一次 run 的返回值是不是「被跳过」。 */
export function isReclaimSkip(v: unknown): v is ReclaimSkip {
  return !!v && typeof v === 'object' && (v as ReclaimSkip).skipped === true;
}

/** 进程内共享的回收锁：所有 CDS 侧回收路径都走它。 */
export const reclaimLock = new ReclaimLock();
