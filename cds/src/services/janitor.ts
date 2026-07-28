import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { BranchEntry } from '../types.js';
import type { StateService } from './state.js';
import { computeImageRetentionPlan, type ImageRetentionPlan } from './image-retention.js';
import { diskGuard, imageKeepGenerationsFor, imageMaxRemovalsFor, describeDiskTier, type DiskTier } from './disk-guard.js';

/**
 * JanitorService — Phase 2 of the CDS resilience plan.
 *
 * Long-lived CDS installations accumulate two kinds of junk:
 *   1. Abandoned git worktrees (branch deleted upstream, never cleaned locally)
 *   2. Stale docker layers (unused images eat disk)
 *
 * The janitor runs a periodic sweep that:
 *   - Identifies branches whose latest lifecycle timestamp is older than
 *     `worktreeTTLDays`
 *   - Skips any branch that is pinned (pinnedByUser / defaultBranch / isColorMarked)
 *   - Returns a report for the caller to act on (list → stop → delete)
 *   - Checks disk usage and emits a warning when > `diskWarnPercent`
 *
 * The actual worktree/container removal is delegated to callbacks, keeping
 * the janitor pure and testable. This mirrors the SchedulerService design
 * (cool/wake callbacks).
 *
 * See `doc/design.cds.resilience.md` Phase 2.
 */

export interface JanitorConfig {
  enabled: boolean;
  /** Delete worktrees/state for branches not accessed in this many days. */
  worktreeTTLDays: number;
  /** Emit disk warning when used% exceeds this threshold. 0-100. */
  diskWarnPercent: number;
  /** How often (in seconds) to run the sweep. */
  sweepIntervalSeconds: number;
  /**
   * Prune unused Docker build junk each sweep. Default on (undefined === true).
   * 只清理"绝对安全"的垃圾——悬空(untagged)镜像 + 构建缓存，**绝不**碰容器
   * (停止的分支容器用户可能要重启) 也不碰 volume(数据)。这是 CDS 跑过几百次
   * 构建后"构建越来越慢"的主因(悬空层 + 构建缓存无限堆积，吃满磁盘/IO)。
   */
  dockerPrune?: boolean;
  /**
   * 按 CDS 版本台账回收 per-SHA 部署镜像。默认开（undefined === true）。
   *
   * 2026-07-27 宕机复盘 P0：`dockerPrune` 只清悬空镜像，而 CDS 自产的部署镜像
   * 带 `sha-<40hex>` tag、永不悬空，于是每小时的清理对它们完全无效——宿主实测
   * 攒到 5099 个镜像 / 159GB。本开关启用的是「按台账保留最近 N 代 + 回收其余」的
   * 定向回收（安全边界见 image-retention.ts）。
   */
  imageRetention?: boolean;
  /** 每个 (分支, 服务) 保留几代部署镜像。磁盘越紧张实际值越低（见 disk-guard）。 */
  imageKeepGenerations?: number;
  /** 单轮最多删几个镜像，避免一次 sweep 长时间占住 docker 与磁盘 IO。 */
  imageMaxRemovalsPerSweep?: number;
}

/** 一次 Docker 垃圾清理的结果。 */
export interface DockerPruneResult {
  ran: boolean;
  /** docker 报告回收的空间(原文，如 "Total reclaimed space: 3.2GB")。 */
  reclaimed: string[];
  errors: string[];
}

/** Callback: 执行安全的 Docker 垃圾清理。可注入以便测试。 */
export type DockerPruneFn = () => Promise<DockerPruneResult>;

/**
 * 「按住不删」的哨兵前缀：removeImage 返回值带此前缀时，表示该镜像是被**正当理由**
 * 保留（当前唯一一种：仍有容器引用它），不是回收失败。调用方据此归类到 held 而非
 * failed——否则一个长期存在的停止容器就能让 failed 永远 ≥1，把这个指标变成常亮红灯。
 */
export const IMAGE_HELD_PREFIX = 'HELD:';

/** 镜像回收所需的 docker 读写（注入点：测试里换成假实现，不碰宿主）。 */
export interface ImageDockerFns {
  /** 宿主上全部镜像的 `repo:tag`。 */
  listImages: () => Promise<string[]>;
  /** 被任何容器（含已停止）引用的镜像。 */
  listInUseImages: () => Promise<string[]>;
  /** 删除一个镜像；成功返回 null，失败返回错误文本（不抛，单个失败不该中断整轮）。 */
  removeImage: (image: string) => Promise<string | null>;
}

export const defaultImageDocker: ImageDockerFns = {
  listImages: async () => {
    const out = await execDocker(['images', '--format', '{{.Repository}}:{{.Tag}}'], 60_000);
    return out.startsWith('__ERR__') ? [] : out.split('\n').filter(Boolean);
  },
  listInUseImages: async () => {
    const out = await execDocker(['ps', '-a', '--format', '{{.Image}}'], 60_000);
    return out.startsWith('__ERR__') ? [] : out.split('\n').filter(Boolean);
  },
  removeImage: async (image) => {
    const out = await execDocker(['rmi', image], 60_000);
    if (!out.startsWith('__ERR__')) return null;
    const err = out.replace('__ERR__ ', '');
    // 「must be forced」= 该镜像 ID 还挂着别的 tag / 子引用（生产实测：每轮固定
    // 1 个 admin 镜像卡在这里，不处理就是永远失败下去的噪音）。只在**确认此刻
    // 没有任何容器引用它**之后才 -f 重试——不带这层确认直接 -f 会把停止容器
    // 依赖的镜像删掉，那个容器就再也起不来了。ps -a 的过滤是即时的，比 sweep
    // 开头那张快照更新，顺带收窄了「快照之后新起容器」的竞态窗口。
    if (!/must be forced/i.test(err)) return err;
    const refs = await execDocker(['ps', '-a', '--filter', `ancestor=${image}`, '-q'], 30_000);
    if (refs.startsWith('__ERR__') || refs.trim() !== '') {
      // 「有容器引用」是**正常的保留**，不是失败（2026-07-28 生产实测：每轮固定
      // 一个 admin 镜像因停止容器引用而卡住，于是 /api/janitor/state 里 failed
      // 恒为 1、errors 恒为 1——一个永远亮着的红灯，真出新故障时反而看不出来）。
      // 用哨兵前缀把它与真失败区分开，由调用方归到「按住不删」而非「删失败」。
      return `${IMAGE_HELD_PREFIX}${err}（有容器引用或引用检查失败，未强制删除）`;
    }
    const forced = await execDocker(['rmi', '-f', image], 60_000);
    return forced.startsWith('__ERR__') ? forced.replace('__ERR__ ', '') : null;
  },
};

function execDocker(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) resolve(`__ERR__ ${(stderr || err.message || '').trim()}`);
      else resolve((stdout || '').trim());
    });
  });
}

/**
 * 默认 Docker 清理实现：只回收"无主"垃圾。
 *  - `docker image prune -f`：悬空(untagged，多为旧 build 的中间层)镜像。
 *  - `docker builder prune -f --keep-storage 10GB`：BuildKit 构建缓存，保留近 10GB 加速下次构建。
 * 刻意**不**带 `-a`(会删有 tag 的基础镜像→下次构建重新 pull 反而更慢)、
 * **不** `container prune`(会删停止的分支容器)、**不** `--volumes`(数据)。
 */
export const defaultDockerPrune: DockerPruneFn = async () => {
  const result: DockerPruneResult = { ran: true, reclaimed: [], errors: [] };
  for (const [label, args] of [
    ['悬空镜像', ['image', 'prune', '-f']],
    ['构建缓存', ['builder', 'prune', '-f', '--keep-storage', '10GB']],
  ] as Array<[string, string[]]>) {
    const out = await execDocker(args);
    if (out.startsWith('__ERR__')) {
      result.errors.push(`${label}: ${out.replace('__ERR__ ', '')}`);
    } else {
      const reclaimedLine = out.split('\n').find((l) => /reclaimed/i.test(l)) || out.split('\n').pop() || '';
      result.reclaimed.push(`${label}: ${reclaimedLine.trim() || '无可回收'}`);
    }
  }
  return result;
};

/** Report returned by a single sweep pass. */
export interface JanitorSweepReport {
  timestamp: string;
  /** Branches removed by this pass. */
  removedBranches: string[];
  /** Branches that would have been removed but were pinned. */
  skippedPinned: string[];
  /** Branches owned by remote executors. Coordinator cleanup must proxy these. */
  skippedRemote: string[];
  /** Disk usage at sweep time. null = stat failed. */
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  /** true when disk usage exceeded diskWarnPercent. */
  diskWarning: boolean;
  /** 磁盘档位（2026-07-27 复盘 P0）：ok/notice/reclaim/freeze。freeze 档会拒绝新的构建部署派发。 */
  diskTier: DiskTier;
  /** Docker 垃圾清理结果(悬空镜像 + 构建缓存)。null = 本次未执行。 */
  dockerPrune: DockerPruneResult | null;
  /** per-SHA 部署镜像定向回收结果。null = 本次未执行。 */
  imageRetention: {
    removed: string[];
    failed: Array<{ image: string; error: string }>;
    /** 有正当理由未删（仍被容器引用）。与 failed 分开，避免常亮红灯淹没真故障。 */
    held: Array<{ image: string; reason: string }>;
    /** 满足条件但被单轮上限截断的数量——如实报出，避免「跑过了」被误读成「清干净了」。 */
    deferred: number;
    keepGenerations: number;
  } | null;
  /** 孤儿 infra 容器对账(在 Docker 里但不在 CDS 台账上,2026-07-09)。
   *  只报不删——infra 容器是项目级共享,误删代价高;删除决策留给运维。
   *  null = 本次未执行(未注入扫描函数)。 */
  orphanInfraContainers: string[] | null;
  /** Any errors encountered (non-fatal). */
  errors: string[];
}

/** Callback: 返回孤儿 infra 容器名列表(在 Docker 但不在 state 台账)。 */
export type OrphanInfraScanFn = () => Promise<string[]>;

export interface JanitorSnapshot {
  enabled: boolean;
  config: JanitorConfig;
  dryRun: { wouldRemove: string[]; wouldSkip: string[] };
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  /**
   * 最近一次 sweep 的结果摘要（2026-07-27 复盘）。此前回收结果只打进 console，
   * 外部无从确认「镜像回收到底有没有在跑、回收了多少、还欠多少」——这正是
   * 交付时需要拿出来的证据。null = 本进程尚未跑过 sweep。
   */
  lastSweep: {
    at: string;
    diskTier: DiskTier;
    removedBranches: number;
    imageRetention: {
      removed: number;
      failed: number;
      /** 有正当理由未删的数量（仍被容器引用）——正常值，不是故障。 */
      held: number;
      /** 失败原因样本（最多 3 条）：只报数字等于「知道有问题但不知道是什么问题」。 */
      failureSamples?: string[];
      /** 按住不删的原因样本（最多 3 条）。 */
      heldSamples?: string[];
      deferred: number;
      keepGenerations: number;
    } | null;
    dockerPrune: string[] | null;
    errors: number;
  } | null;
}

/** Callback: remove a branch's worktree + docker state. */
export type RemoveBranchFn = (slug: string) => Promise<void>;

/** Callback: return disk usage info for `path`. Null = unavailable. */
export type DiskUsageFn = (targetPath: string) => { totalBytes: number; freeBytes: number } | null;

/** Isolate process.now() so tests can inject a deterministic clock. */
export interface JanitorClock {
  now(): number;
}

export const systemJanitorClock: JanitorClock = { now: () => Date.now() };

/**
 * Default disk usage implementation using `fs.statfsSync` (Node 18.15+).
 * Returns null on older Node or filesystem errors so the sweep still runs.
 */
export function defaultDiskUsage(targetPath: string): { totalBytes: number; freeBytes: number } | null {
  try {
    // statfsSync is available in Node 18.15+ / 20+.
    // We check for its presence at runtime since the types may vary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statfs = (fs as any).statfsSync;
    if (typeof statfs !== 'function') return null;
    const stat = statfs(targetPath);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return { totalBytes, freeBytes };
  } catch {
    return null;
  }
}

/**
 * Determine whether a branch is protected from janitor cleanup.
 * Mirrors SchedulerService.isPinned but is independent (janitor may run
 * without the scheduler being enabled).
 */
export function isBranchProtected(branch: BranchEntry, defaultBranchId: string | null, configPinned: string[] = []): boolean {
  if (branch.pinnedByUser) return true;
  if (branch.isColorMarked) return true;
  if (defaultBranchId === branch.id) return true;
  if (configPinned.includes(branch.id)) return true;
  return false;
}

function branchExpiryAnchorMs(branch: BranchEntry): number {
  const candidates = [
    branch.lastAccessedAt,
    branch.lastStoppedAt,
    branch.lastReadyAt,
    branch.lastDeployAt,
    branch.createdAt,
  ];
  let latest = 0;
  for (const value of candidates) {
    if (!value) continue;
    const ts = Date.parse(value);
    if (Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return latest;
}

export class JanitorService {
  private sweepHandle: NodeJS.Timeout | null = null;
  /** 启动后的首轮 sweep（延后 30s 避开开机高峰），与周期调度分开管理。 */
  private firstSweepHandle: NodeJS.Timeout | null = null;
  private lastSweepSummary: JanitorSnapshot['lastSweep'] = null;
  /** 进行中的 sweep：并发调用合并到同一次，不叠加。 */
  private sweepInFlight: Promise<JanitorSweepReport> | null = null;
  private removeFn: RemoveBranchFn | null = null;
  private orphanInfraScan: OrphanInfraScanFn | null = null;

  constructor(
    private readonly stateService: StateService,
    private readonly config: JanitorConfig,
    private readonly worktreeBase: string,
    private readonly clock: JanitorClock = systemJanitorClock,
    private readonly diskUsage: DiskUsageFn = defaultDiskUsage,
    private readonly dockerPrune: DockerPruneFn = defaultDockerPrune,
    /** 镜像回收所需的 docker 读写（可注入以便测试，不真的碰宿主）。 */
    private readonly imageDocker: ImageDockerFns = defaultImageDocker,
  ) {}

  /**
   * per-SHA 部署镜像定向回收：台账（保留最近 N 代）+ 宿主镜像 + 在用镜像
   * → 纯函数算出可删集合 → 逐个 rmi。保留代数随磁盘档位收紧。
   */
  private async runImageRetention(tier: DiskTier): Promise<NonNullable<JanitorSweepReport['imageRetention']>> {
    const keepGenerations = imageKeepGenerationsFor(tier, this.config.imageKeepGenerations ?? 5);
    const [hostImages, inUseImages] = await Promise.all([
      this.imageDocker.listImages(),
      this.imageDocker.listInUseImages(),
    ]);
    const ledger = this.stateService.getDeploymentVersions()
      .flatMap((v) => Object.values(v.profiles || {})
        .filter((p) => !!p.artifactImage)
        .map((p) => ({
          image: p.artifactImage,
          branchId: v.branchId,
          profileId: p.profileId,
          createdAt: v.createdAt,
        })));
    const plan: ImageRetentionPlan = computeImageRetentionPlan({
      ledger, hostImages, inUseImages, keepGenerations,
      maxRemovals: imageMaxRemovalsFor(tier, this.config.imageMaxRemovalsPerSweep ?? 40),
    });
    const removed: string[] = [];
    const failed: Array<{ image: string; error: string }> = [];
    const held: Array<{ image: string; reason: string }> = [];
    for (const image of plan.remove) {
      // 串行：一次 sweep 不许把 docker 与磁盘 IO 打满（并发 prune 撞车正是
      // 2026-07-27 人工恢复时踩到的坑：a prune operation is already running）。
      const err = await this.imageDocker.removeImage(image);
      if (!err) { removed.push(image); continue; }
      // held = 有正当理由没删（当前唯一一种：仍有容器引用），不计入失败
      if (err.startsWith(IMAGE_HELD_PREFIX)) {
        held.push({ image, reason: err.slice(IMAGE_HELD_PREFIX.length) });
      } else {
        failed.push({ image, error: err });
      }
    }
    return { removed, failed, held, deferred: plan.deferred, keepGenerations };
  }

  setRemoveFn(fn: RemoveBranchFn): void {
    this.removeFn = fn;
  }

  /** 注入孤儿 infra 对账扫描（index.ts 组装 containerService + state 台账 + 告警落点）。 */
  setOrphanInfraScan(fn: OrphanInfraScanFn): void {
    this.orphanInfraScan = fn;
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  setEnabled(enabled: boolean): void {
    if (this.config.enabled === enabled) return;
    this.config.enabled = enabled;
    // 只切换「是否允许删过期分支」，不停调度——磁盘检查/镜像回收等非破坏性
    // 动作与该开关解耦（同 start() 的说明）。
    if (enabled) {
      this.start();
      console.log('[janitor] enabled at runtime（破坏性分支清理已开启）');
    } else {
      console.log('[janitor] disabled at runtime（仅停用破坏性分支清理，回收类动作继续）');
    }
  }

  setWorktreeTTLDays(days: number): void {
    if (this.config.worktreeTTLDays === days) return;
    this.config.worktreeTTLDays = days;
    console.log(`[janitor] worktreeTTLDays set to ${days} at runtime`);
  }

  /** Start periodic sweeps. Safe to call multiple times. No-op when disabled. */
  start(): void {
    if (this.sweepHandle) return;
    // 调度不再受 `enabled` 门禁（2026-07-27 宕机复盘）：`enabled` 的语义一直是
    // 「是否允许**破坏性**地删过期分支」，sweep() 内部已按它单独 gate。但此前
    // start() 在 disabled 时直接 return，连带把磁盘检查、悬空镜像清理、per-SHA
    // 镜像回收、孤儿对账这些非破坏性动作一起停掉——dockerPrune 注释里写的
    //「与 enabled 解耦，默认就清」根本没有兑现过。
    const intervalMs = Math.max(60_000, (this.config.sweepIntervalSeconds || 3600) * 1000);
    this.sweepHandle = setInterval(() => {
      this.sweep().catch((err) => {
        console.error('[janitor] sweep error:', (err as Error).message);
      });
    }, intervalMs);
    if (typeof this.sweepHandle.unref === 'function') {
      this.sweepHandle.unref();
    }
    // 启动后先跑一次（延后 30s 避开开机高峰）：此前要整整等一个 interval，
    // 而 CDS 每次自更新都会重启——「刚因为磁盘满被打死、正在恢复」的那一小时
    // 恰恰一次回收都不做。首轮失败只记录，不影响周期调度。
    this.firstSweepHandle = setTimeout(() => {
      this.firstSweepHandle = null;
      this.sweep().catch((err) => {
        console.error('[janitor] initial sweep error:', (err as Error).message);
      });
    }, 30_000);
    if (typeof this.firstSweepHandle.unref === 'function') {
      this.firstSweepHandle.unref();
    }
    console.log(`[janitor] started (enabled=${this.isEnabled()}, TTL=${this.config.worktreeTTLDays}d, diskWarn=${this.config.diskWarnPercent}%, interval=${this.config.sweepIntervalSeconds}s)`);
  }

  stop(): void {
    if (this.firstSweepHandle) {
      clearTimeout(this.firstSweepHandle);
      this.firstSweepHandle = null;
    }
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  /**
   * Run one sweep pass. Returns a full report, even when disabled
   * (enables manual / on-demand invocation via admin API).
   */
  /**
   * 对外的 sweep 入口：**去重 + 摘要记录**的外壳。
   *
   * - 去重（Codex 第三十轮 P2）：周期定时器、启动首轮、手工触发端点三条路都会
   *   调这里，而一轮在磁盘压力下可能做多达 400 次串行 rmi（每次 60s 超时），
   *   完全可能长过一个 interval。并发跑会算出同一份删除清单、互相抢 docker
   *   daemon，恰好在最需要它稳的恢复期制造失败。在跑就**合并**到同一次，
   *   不叠加（与 concurrency-gate-discipline「重试要合并不要叠加」同纪律）。
   * - 摘要记录（Codex 第三十轮 P2）：此前写在 runSweep 末尾，而 runSweep 在
   *   「TTL 清理被关掉」时会提前 return——回收明明跑了，/api/janitor/state 却
   *   永远是 lastSweep:null，正好废掉这份用来举证「回收是否在工作」的证据。
   *   放到外壳里，两条 return 路径都记得到。
   */
  async sweep(): Promise<JanitorSweepReport> {
    if (this.sweepInFlight) return this.sweepInFlight;
    const run = (async () => {
      try {
        const report = await this.runSweep();
        this.lastSweepSummary = {
          at: report.timestamp,
          diskTier: report.diskTier,
          removedBranches: report.removedBranches.length,
          imageRetention: report.imageRetention
            ? {
              removed: report.imageRetention.removed.length,
              failed: report.imageRetention.failed.length,
              held: report.imageRetention.held.length,
              ...(report.imageRetention.failed.length > 0
                ? { failureSamples: report.imageRetention.failed.slice(0, 3).map((f) => `${f.image}: ${f.error.slice(0, 160)}`) }
                : {}),
              ...(report.imageRetention.held.length > 0
                ? { heldSamples: report.imageRetention.held.slice(0, 3).map((h) => `${h.image}: ${h.reason.slice(0, 160)}`) }
                : {}),
              deferred: report.imageRetention.deferred,
              keepGenerations: report.imageRetention.keepGenerations,
            }
            : null,
          dockerPrune: report.dockerPrune?.reclaimed ?? null,
          errors: report.errors.length,
        };
        return report;
      } finally {
        this.sweepInFlight = null;
      }
    })();
    this.sweepInFlight = run;
    return run;
  }

  private async runSweep(): Promise<JanitorSweepReport> {
    const report: JanitorSweepReport = {
      timestamp: new Date(this.clock.now()).toISOString(),
      removedBranches: [],
      skippedPinned: [],
      skippedRemote: [],
      disk: null,
      diskWarning: false,
      diskTier: 'ok',
      dockerPrune: null,
      imageRetention: null,
      orphanInfraContainers: null,
      errors: [],
    };

    // 1. Disk usage check (always, even when TTL cleanup disabled — cheap)
    let usedPercentForTier: number | null = null;
    try {
      const usage = this.diskUsage(this.worktreeBase);
      if (usage) {
        const usedBytes = usage.totalBytes - usage.freeBytes;
        const usedPercent = Math.round((usedBytes / usage.totalBytes) * 100);
        usedPercentForTier = usedPercent;
        report.disk = { ...usage, usedPercent };
        if (usedPercent >= this.config.diskWarnPercent) {
          report.diskWarning = true;
          console.warn(`[janitor] DISK ${usedPercent}% used at ${this.worktreeBase} (threshold ${this.config.diskWarnPercent}%)`);
        }
      }
    } catch (err) {
      report.errors.push(`disk check: ${(err as Error).message}`);
    }
    // 1.1 磁盘分档刹车（2026-07-27 宕机复盘 P0）：此前只有一句 console.warn，
    //     磁盘从 80% 涨到 100% 全程没有任何一处会因此少做点什么。现在把档位写进
    //     进程内 diskGuard——freeze 档（默认 90%）部署派发会被直接拒绝，回收强度
    //     也随档位上调（镜像保留代数收紧）。
    // 有注册探测器时按它刷新（worst-of worktree + docker 数据目录），没有才用
    // 上面的 worktree 读数兜底——直接 update(worktree%) 会覆盖掉多文件系统结果
    //（Codex 第三十轮 P1）。
    report.diskTier = diskGuard.refreshOrUpdate(usedPercentForTier);
    if (report.diskTier !== 'ok') {
      console.warn(`[janitor] ${describeDiskTier(report.diskTier, usedPercentForTier)}`);
    }

    // 1.5 Docker 垃圾清理(默认开，非破坏性——只清悬空镜像 + 构建缓存)。
    //     与 enabled(控制破坏性分支删除) 解耦：哪怕用户没开 TTL 清理，悬空层/构建
    //     缓存的堆积也是"构建越来越慢"的主因，故默认就清。config.dockerPrune=false 可关。
    if (this.config.dockerPrune !== false) {
      try {
        report.dockerPrune = await this.dockerPrune();
        const summary = report.dockerPrune.reclaimed.join(' · ');
        if (summary) console.log(`[janitor] docker prune: ${summary}`);
        for (const e of report.dockerPrune.errors) report.errors.push(`docker prune ${e}`);
      } catch (err) {
        report.errors.push(`docker prune: ${(err as Error).message}`);
      }
    }

    // 1.6 per-SHA 部署镜像定向回收（2026-07-27 宕机复盘 P0）。
    //     1.5 的 image prune 只清悬空镜像，而 CDS 自产的部署镜像永远带 tag——
    //     每小时跑一次也一个都清不掉，宿主实测攒到 5099 个 / 159GB。这里按
    //     「台账最近 N 代 + 在用镜像」双保险回收其余（安全边界见 image-retention.ts）。
    if (this.config.imageRetention !== false) {
      try {
        report.imageRetention = await this.runImageRetention(report.diskTier);
        const r = report.imageRetention;
        if (r.removed.length || r.deferred) {
          console.log(
            `[janitor] 部署镜像回收：删除 ${r.removed.length} 个（保留 ${r.keepGenerations} 代）`
            + (r.deferred ? `，本轮上限截断 ${r.deferred} 个待下轮` : '')
            + (r.held.length ? `，${r.held.length} 个被容器引用暂不删` : '')
            + (r.failed.length ? `，失败 ${r.failed.length} 个` : ''),
          );
        }
        // held 不进 errors：它是正常保留，进了 errors 就等于 errors 恒 >=1
        for (const f of r.failed) report.errors.push(`image rmi ${f.image}: ${f.error}`);
      } catch (err) {
        report.errors.push(`image retention: ${(err as Error).message}`);
      }
    }

    // 1.7 孤儿 infra 容器对账(2026-07-09,debt.cds.performance 根因 #2 降级实施):
    //     不在 CDS 台账上的 infra 容器(历史遗留/手工启动)会长期吃 CPU/内存且无人知晓。
    //     只报不删——把启动时的一次性 warn 周期化,让运维每次 sweep 都能看到。
    if (this.orphanInfraScan) {
      try {
        report.orphanInfraContainers = await this.orphanInfraScan();
        if (report.orphanInfraContainers.length > 0) {
          console.warn(`[janitor] orphan infra containers (not in CDS state): ${report.orphanInfraContainers.join(', ')}`);
        }
      } catch (err) {
        report.errors.push(`orphan infra scan: ${(err as Error).message}`);
      }
    }

    // 2. Worktree TTL cleanup (only when enabled — destructive)
    if (!this.isEnabled()) return report;

    const now = this.clock.now();
    const ttlMs = this.config.worktreeTTLDays * 24 * 60 * 60 * 1000;
    const branches = this.stateService.getAllBranches();

    for (const branch of branches) {
      // per-project default：项目级值优先，未设回落到旧 state.defaultBranch
      const branchDefault = this.stateService.getDefaultBranchFor(branch.projectId);
      const protectedReason = isBranchProtected(branch, branchDefault, []);
      if (protectedReason) {
        // We still track pinned stale branches so the operator can see them.
        if (branch.lastAccessedAt && (now - Date.parse(branch.lastAccessedAt)) > ttlMs) {
          report.skippedPinned.push(branch.id);
        }
        continue;
      }

      const anchorMs = branchExpiryAnchorMs(branch);
      if (anchorMs <= 0) continue;

      const idleMs = now - anchorMs;
      if (idleMs <= ttlMs) continue;
      if (branch.executorId) {
        report.skippedRemote.push(branch.id);
        continue;
      }

      // Found a stale branch. Delegate removal to the caller.
      try {
        if (this.removeFn) {
          await this.removeFn(branch.id);
        }
        report.removedBranches.push(branch.id);
        console.log(`[janitor] removed stale branch "${branch.id}" (idle ${Math.round(idleMs / (24*60*60*1000))}d)`);
      } catch (err) {
        report.errors.push(`remove ${branch.id}: ${(err as Error).message}`);
      }
    }

    return report;
  }

  /**
   * Dry run: returns the set of branches the next sweep would affect,
   * without performing any mutation.
   */
  dryRun(): { wouldRemove: string[]; wouldSkip: string[] } {
    const wouldRemove: string[] = [];
    const wouldSkip: string[] = [];
    const now = this.clock.now();
    const ttlMs = this.config.worktreeTTLDays * 24 * 60 * 60 * 1000;

    for (const branch of this.stateService.getAllBranches()) {
      const anchorMs = branchExpiryAnchorMs(branch);
      if (anchorMs <= 0) continue;
      const idleMs = now - anchorMs;
      if (idleMs <= ttlMs) continue;

      const branchDefault = this.stateService.getDefaultBranchFor(branch.projectId);
      if (branch.executorId || isBranchProtected(branch, branchDefault, [])) {
        wouldSkip.push(branch.id);
      } else {
        wouldRemove.push(branch.id);
      }
    }
    // Reference `path` so the import is kept — it will be used by future
    // extensions (e.g. per-project worktree root globbing).
    void path;
    return { wouldRemove, wouldSkip };
  }

  getSnapshot(): JanitorSnapshot {
    let disk: JanitorSnapshot['disk'] = null;
    const usage = this.diskUsage(this.worktreeBase);
    if (usage) {
      const usedBytes = usage.totalBytes - usage.freeBytes;
      disk = {
        ...usage,
        usedPercent: Math.round((usedBytes / usage.totalBytes) * 100),
      };
    }
    return {
      enabled: this.isEnabled(),
      config: this.config,
      dryRun: this.dryRun(),
      disk,
      lastSweep: this.lastSweepSummary,
    };
  }
}
