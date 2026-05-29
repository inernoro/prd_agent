// CDS 自更新 / 自检状态权威缓存
//
// 设计目标(参见 .claude/rules + 用户目标文档):
//   后端权威状态缓存 + 单一实时事件通道 + 前端只读状态机
//
// 浏览器不再驱动 git fetch / branch scan;浏览器只读取本缓存。
//
// 字段含义对齐目标文档:
//   currentBranch    当前 HEAD 所在分支(cached refs)
//   headSha          本地 HEAD short sha
//   webBuildSha      cds/web/dist/.build-sha
//   runningPid       process.pid
//   restartStatus    not_required | pending | completed | incomplete
//   activeSelfUpdate 当前正在跑的 self-update record(磁盘 .cds/active-update.json)
//   lastSelfUpdate   history[0]
//   remoteAheadCount 本地落后远端多少 commit(需要 git fetch 后才有)
//   remoteBranches   self-branches 端点要用的分支元数据列表(后台维护)
//   degraded         { degraded: true, reason, message } 或 null
//   lastRefreshAt    上次 refresh 完成时间
//   lastError        上次 refresh 失败的错误消息
//   lastKnownGood    上一次成功的 snapshot(用于 degraded 时回退展示)
//
// 关键不变量:
//   1. 进程内单例;CDS 单进程单实例,无锁安全
//   2. enqueueRefresh(trigger) 同时刻只允许一个 refresh job,重复入队
//      返回当前 jobId 与 status=running,不会启动第二个 job
//   3. refresh 成功后写 lastKnownGood + emit self.status + self.refresh.done
//   4. refresh 失败时保留 lastKnownGood + emit self.refresh.failed + self.status
//      (status payload 带 degraded={...})
//   5. 启动时不主动跑 refresh,等首个调用方 enqueueRefresh('startup') 或
//      首个 cds-events SSE 客户端连上时再跑(避免空载时白白 git fetch)

import { cdsEventsBus } from './cds-events-bus.js';

export type RefreshTrigger = 'manual' | 'webhook' | 'startup' | 'schedule' | 'stream-subscribe';

export interface SelfStatusSnapshot {
  /** 自检全景(原 computeSelfStatusPayload 输出,字段兼容) */
  currentBranch: string;
  headSha: string;
  headIso?: string;
  webBuildSha?: string;
  webBuildError?: string;
  runningPid: number;
  pidStartedAt: string | null;
  restartStatus: 'not_required' | 'pending' | 'completed' | 'incomplete';
  activeSelfUpdate: unknown;
  lastSelfUpdate: unknown;
  selfUpdateHistory: unknown[];
  remoteAheadCount: number;
  localAheadCount: number;
  remoteAheadSubjects: unknown[];
  remoteBranches: RemoteBranchEntry[];
  fetchOk: boolean;
  fetchError: string;
  bundleStale: boolean;
  bundleFreshness?: unknown;
  systemdUnitDrift?: unknown;
  daemonReadyAt?: string | null;
  /** 缓存元数据 */
  lastRefreshAt: string | null;
  lastRefreshDurationMs: number | null;
  lastRefreshTrigger: RefreshTrigger | null;
  lastError: string | null;
  /** 降级标志:任何 git/远端失败都置 true,具体 reason 见 degraded 字段 */
  degraded: {
    degraded: boolean;
    reason: string; // git_fetch_failed / ref_not_found / state_load_failed ...
    message: string;
  } | null;
  /** SSE / API 客户端识别 */
  cachedAt: string;
}

export interface RemoteBranchEntry {
  name: string;
  committerDate: string;
  commitHash: string;
  subject: string;
  cdsTouched: boolean;
}

export interface RefreshJobState {
  jobId: string;
  trigger: RefreshTrigger;
  status: 'queued' | 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export type SelfStatusComputer = (opts: {
  /** true = 不发网络,只用 cached refs(快速 snapshot) */
  skipFetch: boolean;
}) => Promise<Omit<
  SelfStatusSnapshot,
  | 'lastRefreshAt'
  | 'lastRefreshDurationMs'
  | 'lastRefreshTrigger'
  | 'lastError'
  | 'degraded'
  | 'remoteBranches'
>>;

export type RemoteBranchScanner = () => Promise<RemoteBranchEntry[]>;

interface CacheOptions {
  /** 主体快照计算函数(由 branches.ts 注入,复用现有 computeSelfStatusPayload) */
  computeSnapshot: SelfStatusComputer;
  /** 远端分支扫描函数(由 branches.ts 注入,复用现有 self-branches 逻辑) */
  scanRemoteBranches: RemoteBranchScanner;
}

const EMPTY_SNAPSHOT: SelfStatusSnapshot = {
  currentBranch: '',
  headSha: '',
  headIso: '',
  webBuildSha: '',
  webBuildError: '',
  runningPid: process.pid,
  pidStartedAt: null,
  restartStatus: 'not_required',
  activeSelfUpdate: null,
  lastSelfUpdate: null,
  selfUpdateHistory: [],
  remoteAheadCount: 0,
  localAheadCount: 0,
  remoteAheadSubjects: [],
  remoteBranches: [],
  fetchOk: false,
  fetchError: '',
  bundleStale: false,
  lastRefreshAt: null,
  lastRefreshDurationMs: null,
  lastRefreshTrigger: null,
  lastError: null,
  degraded: null,
  cachedAt: new Date(0).toISOString(),
};

class SelfStatusCache {
  private snapshot: SelfStatusSnapshot = { ...EMPTY_SNAPSHOT };
  /** 上一次成功(无 degraded)的 snapshot — degraded 时不会被覆盖 */
  private lastKnownGood: SelfStatusSnapshot | null = null;
  private options: CacheOptions | null = null;

  /** 当前活跃 refresh job(null 表示没有在跑) */
  private activeJob: RefreshJobState | null = null;

  /**
   * Codex review(PR #684, P2):有 job 在跑时新来的 enqueueRefresh 被合并丢弃。
   * self-update 收尾路径 fire-and-forget 调 broadcastSelfStatus(),若它撞在一次
   * git-fetch refresh 进行中,那次"清除 active 标记"的最终状态变化就丢了 → 重启后
   * 浏览器卡在 updating(再没有 activeSelfUpdate=null 的 self.status 发出)。这里记
   * 一个 dirty 标志:运行中再被请求 → 标脏,当前 job 跑完后补跑一次,确保最终态不丢。
   */
  private pendingRefreshTrigger: RefreshTrigger | null = null;

  /** 给 ?probe=remote 用的轻量节流:同 trigger 在 5s 内不重复跑 */
  private lastRefreshAtByTrigger = new Map<RefreshTrigger, number>();

  init(options: CacheOptions): void {
    this.options = options;
    this.snapshot.pidStartedAt =
      (globalThis as unknown as { __CDS_PROCESS_STARTED_AT?: string }).__CDS_PROCESS_STARTED_AT || null;
  }

  isInitialized(): boolean {
    return this.options !== null;
  }

  /**
   * 测试用 — 重置 cache 到初始态(清空 snapshot / lastKnownGood / activeJob)。
   * 生产代码禁止调用。
   */
  _resetForTests(): void {
    this.snapshot = { ...EMPTY_SNAPSHOT };
    this.lastKnownGood = null;
    this.options = null;
    this.activeJob = null;
    this.pendingRefreshTrigger = null;
    this.lastRefreshAtByTrigger.clear();
  }

  /**
   * 测试用 — 直接灌入一个快照 + 标记 lastKnownGood。
   * 用于断言 cache → /api/self-branches 等端点的契约,无需跑真实 git 命令。
   */
  _primeForTests(partial: Partial<SelfStatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial, lastRefreshAt: new Date().toISOString() };
    if (!partial.degraded) {
      this.lastKnownGood = { ...this.snapshot };
    }
  }

  getSnapshot(): SelfStatusSnapshot {
    return this.snapshot;
  }

  getLastKnownGood(): SelfStatusSnapshot | null {
    return this.lastKnownGood;
  }

  getActiveJob(): RefreshJobState | null {
    return this.activeJob;
  }

  /**
   * 任务化刷新入口。
   *
   * 行为:
   *   - 已有 job 在跑 → 直接返回当前 job(同 jobId,status=running)
   *   - 节流命中(同 trigger 距上次 < dedupeWindowMs) → 返回最近一次 done job 摘要
   *     注:节流仅对 webhook / schedule 触发生效,manual 永远穿透
   *   - 启动新 job → 立即返回 queued state,异步执行
   */
  enqueueRefresh(trigger: RefreshTrigger, opts: { dedupeWindowMs?: number } = {}): RefreshJobState {
    if (!this.options) {
      // 未 init:返回一个 failed job,不抛错
      return {
        jobId: '',
        trigger,
        status: 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: 'self-status cache not initialized',
      };
    }

    if (this.activeJob && (this.activeJob.status === 'queued' || this.activeJob.status === 'running')) {
      // 运行中再被请求 → 标脏,当前 job 收尾时补跑一次(见 runRefreshJob 末尾)。
      // 否则 self-update 收尾的最终状态变化会被静默丢弃,浏览器卡 updating。
      this.pendingRefreshTrigger = trigger;
      return { ...this.activeJob };
    }

    const dedupeWindowMs = opts.dedupeWindowMs ?? (trigger === 'webhook' || trigger === 'schedule' ? 5_000 : 0);
    if (dedupeWindowMs > 0) {
      const last = this.lastRefreshAtByTrigger.get(trigger);
      if (last && Date.now() - last < dedupeWindowMs && this.activeJob && this.activeJob.status === 'done') {
        return { ...this.activeJob };
      }
    }

    const jobId = `refresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    const job: RefreshJobState = {
      jobId,
      trigger,
      status: 'running',
      startedAt,
      finishedAt: null,
      durationMs: null,
      error: null,
    };
    this.activeJob = job;
    this.lastRefreshAtByTrigger.set(trigger, Date.now());

    cdsEventsBus.publish('self.refresh.started', { trigger, jobId }, { jobId });

    // 异步跑,不阻塞调用方
    void this.runRefreshJob(job).catch((err) => {
      // 兜底:理论上 runRefreshJob 内部已 catch
      // eslint-disable-next-line no-console
      console.warn('[self-status-cache] runRefreshJob unexpected throw:', (err as Error).message);
    });

    return { ...job };
  }

  /**
   * 同步用调用方触发的轻量 snapshot 计算(skipFetch=true),不入 job,
   * 不 publish 事件 — 主要用于 /api/self-status 顶层 handler 这种"只读"场景。
   * 若已有缓存且 < staleMs,直接返回缓存。
   *
   * 注意:首次调用时若 cache 为空(EMPTY_SNAPSHOT),会同步跑一次轻量 compute
   * 来填充,这样首次访问页面也能拿到真实数据。
   */
  async readSnapshotWithFallback(opts: { maxAgeMs?: number } = {}): Promise<SelfStatusSnapshot> {
    if (!this.options) return this.snapshot;
    const maxAgeMs = opts.maxAgeMs ?? 30_000;
    const lastRefreshMs = this.snapshot.lastRefreshAt ? Date.parse(this.snapshot.lastRefreshAt) : 0;
    if (lastRefreshMs && Date.now() - lastRefreshMs < maxAgeMs) {
      return this.snapshot;
    }
    // 跑一次轻量 compute(skipFetch=true),不触发网络,只读 cached refs。
    // 不入 activeJob,纯就地刷新本地快照。
    try {
      const partial = await this.options.computeSnapshot({ skipFetch: true });
      this.applyPartial(partial, { trigger: 'startup', durationMs: 0, error: null, includeBranches: false });
    } catch (err) {
      this.snapshot = {
        ...this.snapshot,
        degraded: {
          degraded: true,
          reason: 'snapshot_compute_failed',
          message: (err as Error).message.slice(0, 500),
        },
        lastError: (err as Error).message.slice(0, 500),
      };
    }
    return this.snapshot;
  }

  // ── 内部 ─────────────────────────────────────────────────────────

  private async runRefreshJob(job: RefreshJobState): Promise<void> {
    if (!this.options) {
      job.status = 'failed';
      job.error = 'cache not initialized';
      job.finishedAt = new Date().toISOString();
      job.durationMs = 0;
      this.activeJob = job;
      cdsEventsBus.publish('self.refresh.failed', { trigger: job.trigger, jobId: job.jobId, error: job.error }, { jobId: job.jobId });
      return;
    }

    const startMs = Date.now();
    try {
      // 1) 主快照(可能跑 git fetch)
      const partial = await this.options.computeSnapshot({ skipFetch: false });
      // 2) 远端分支扫描(可独立失败,但本快照不视为失败)
      let remoteBranches: RemoteBranchEntry[] = this.snapshot.remoteBranches;
      try {
        remoteBranches = await this.options.scanRemoteBranches();
      } catch (err) {
        // 远端分支扫描失败 → 保留旧的 remoteBranches,仅在 degraded 里登记
        // 不把整个 refresh 标记失败,因为 partial 本身可能成功
        // eslint-disable-next-line no-console
        console.warn('[self-status-cache] remote branch scan failed:', (err as Error).message);
      }
      const durationMs = Date.now() - startMs;
      this.applyPartial(partial, { trigger: job.trigger, durationMs, error: null, includeBranches: true, remoteBranches });

      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.durationMs = durationMs;
      this.activeJob = job;
      cdsEventsBus.publish('self.refresh.done', { trigger: job.trigger, jobId: job.jobId, durationMs }, { jobId: job.jobId });
      // 状态变化也广播一次
      cdsEventsBus.publish('self.status', this.snapshot);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const msg = (err as Error).message.slice(0, 500);
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.durationMs = durationMs;
      job.error = msg;
      this.activeJob = job;

      // 失败时不覆盖 lastKnownGood,只把 degraded + lastError 写进 snapshot
      this.snapshot = {
        ...this.snapshot,
        lastError: msg,
        lastRefreshAt: new Date().toISOString(),
        lastRefreshDurationMs: durationMs,
        lastRefreshTrigger: job.trigger,
        degraded: {
          degraded: true,
          reason: 'refresh_failed',
          message: msg,
        },
        cachedAt: new Date().toISOString(),
      };
      cdsEventsBus.publish('self.refresh.failed', { trigger: job.trigger, jobId: job.jobId, error: msg, durationMs }, { jobId: job.jobId });
      cdsEventsBus.publish('self.status', this.snapshot);
    }

    // Codex review(PR #684, P2):本 job 跑的过程中若有 enqueueRefresh 被合并丢弃
    // (pendingRefreshTrigger 被标脏),这里补跑一次,确保期间发生的最终状态变化
    // (如 self-update 收尾清 activeSelfUpdate)不被吞掉。此时 activeJob 已是 done/
    // failed,enqueueRefresh 不会再命中"运行中"合并分支,能正常起新 job。
    if (this.pendingRefreshTrigger) {
      const pending = this.pendingRefreshTrigger;
      this.pendingRefreshTrigger = null;
      this.enqueueRefresh(pending);
    }
  }

  /** 用 partial(computeSelfStatusPayload 输出)覆写当前 snapshot,并维护 lastKnownGood */
  private applyPartial(
    partial: Omit<
      SelfStatusSnapshot,
      | 'lastRefreshAt'
      | 'lastRefreshDurationMs'
      | 'lastRefreshTrigger'
      | 'lastError'
      | 'degraded'
      | 'remoteBranches'
    >,
    meta: {
      trigger: RefreshTrigger;
      durationMs: number;
      error: string | null;
      includeBranches: boolean;
      remoteBranches?: RemoteBranchEntry[];
    },
  ): void {
    // partial 本身可能内部带 fetchOk=false + fetchError(computeSelfStatusPayload
    // 的语义),这里把它映射成 degraded(只在 fetch 错误时才视为 degraded;
    // skipFetch=true 的快照不算 degraded,因为是约定不发网络)
    let degraded: SelfStatusSnapshot['degraded'] = null;
    if (!partial.fetchOk && partial.fetchError && !partial.fetchError.startsWith('skipped')) {
      degraded = {
        degraded: true,
        reason: 'git_fetch_failed',
        message: partial.fetchError.slice(0, 500),
      };
    }

    const next: SelfStatusSnapshot = {
      ...this.snapshot,
      ...partial,
      remoteBranches: meta.includeBranches
        ? (meta.remoteBranches ?? this.snapshot.remoteBranches)
        : this.snapshot.remoteBranches,
      lastRefreshAt: new Date().toISOString(),
      lastRefreshDurationMs: meta.durationMs,
      lastRefreshTrigger: meta.trigger,
      lastError: meta.error,
      degraded,
      cachedAt: new Date().toISOString(),
    };
    this.snapshot = next;
    if (!degraded) {
      // 全部正常 → 写 lastKnownGood
      this.lastKnownGood = { ...next };
    }
  }
}

export const selfStatusCache = new SelfStatusCache();
