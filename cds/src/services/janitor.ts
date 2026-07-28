import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { BranchEntry } from '../types.js';
import type { StateService } from './state.js';
import { computeImageRetentionPlan, type ImageRetentionPlan } from './image-retention.js';
import {
  computeOrphanWorktreePlan, normalizeWorktreePath, DEFAULT_ORPHAN_WORKTREE_MAX_REMOVALS,
  type DiskWorktreeDir, type OrphanWorktreePlan,
} from './orphan-worktree.js';
import { diskGuard, imageKeepGenerationsFor, imageMaxRemovalsFor, describeDiskTier, type DiskTier } from './disk-guard.js';
import { reclaimLock, isReclaimSkip } from './reclaim-lock.js';

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
  /**
   * 孤儿 worktree 对账（2026-07-27 宕机复盘 P2）。默认开（undefined === true）。
   *
   * TTL 清理只看得见台账里还有记录的分支；磁盘上「目录还在、台账里没有」的
   * worktree（删除半途失败 / 项目已删 / 创建时崩溃的残留）从来没人管——事故当天
   * 宿主 .cds-worktrees 已 45.5GB，而按 TTL 够格删的分支只有 3 个。
   */
  orphanWorktrees?: boolean;
  /** 单轮最多删几个孤儿 worktree 目录。 */
  orphanWorktreeMaxRemovalsPerSweep?: number;
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
 * 同 execDocker，但**同时**返回退出状态与已产出的 stdout。
 *
 * `docker inspect a b c` 里只要有一个 id 已经消失就整体非零退出，可它照样把找得到的
 * 那些打了出来。丢掉这份 stdout 会让调用方误以为「什么都没查到」——生产实测正是
 * 如此：容器在 ps 与 inspect 之间不断增删，挂载枚举恒定失败，孤儿回收永远停在
 * 「找到 66 个、一个不删」。
 */
function execDockerDetailed(
  args: string[], timeoutMs = 120_000,
): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), error: (stderr || (err as Error | null)?.message || '').trim() });
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
  /** 孤儿 worktree 对账结果（磁盘有目录、台账无分支）。null = 本次未执行。 */
  orphanWorktrees: {
    removed: string[];
    failed: Array<{ path: string; error: string }>;
    keptReasons: Record<string, string>;
    deferred: number;
  } | null;
  /** 孤儿 infra 容器对账(在 Docker 里但不在 CDS 台账上,2026-07-09)。
   *  只报不删——infra 容器是项目级共享,误删代价高;删除决策留给运维。
   *  null = 本次未执行(未注入扫描函数)。 */
  orphanInfraContainers: string[] | null;
  /** Any errors encountered (non-fatal). */
  errors: string[];
}

/** 孤儿 worktree 对账所需的磁盘读写（注入点：测试里换成假实现，不碰磁盘）。 */
export interface OrphanWorktreeFs {
  /**
   * 枚举 `<base>/<projectId>/<slug>` 两层下的全部目录。
   *
   * `knownProjectIds` 是**白名单**，不是提示：只有名字在其中的顶层目录才是项目桶，
   * 其余一律整个跳过（既不当桶往下枚举，也不当候选）。见实现里的注释。
   */
  listWorktreeDirs: (base: string, knownProjectIds: readonly string[]) => Promise<DiskWorktreeDir[]>;
  /** 当前被任何容器（含已停止）bind-mount 的宿主路径。查不到时返回 null。 */
  listMountedHostPaths: () => Promise<string[] | null>;
  /** 递归删除一个目录；成功返回 null，失败返回错误文本（不抛，单个失败不中断整轮）。 */
  removeDir: (dir: string) => Promise<string | null>;
}

export const defaultOrphanWorktreeFs: OrphanWorktreeFs = {
  listWorktreeDirs: async (base, knownProjectIds) => {
    const out: DiskWorktreeDir[] = [];
    // 项目桶白名单（Codex PR #1275 二轮 P1）。此前是「顶层每个目录都当项目桶」，
    // 在**从扁平布局迁移过来的存量部署**上会酿成删活代码：
    // FU-04 的 migrateFlatLayoutIfNeeded 采用符号链接而非移动——原来的
    // `<base>/<slug>` 真实 worktree **原地保留**，只在 `<base>/default/<slug>`
    // 建一条指向它的符号链接，台账 worktreePath 改指嵌套路径。于是顶层同时存在
    // 「default 这种真项目桶」和「一堆遗留的真 worktree 目录」。把后者当桶枚举，
    // 吐出来的候选就是 `cds/` `prd-api/` `doc/` 这些**活代码树的源码子目录**：
    // 它们不等于任何台账路径（台账指向嵌套的符号链接路径），挂载检查又是「后代」
    // 语义（容器挂的是 worktree 根，不是这些子目录），两小时年龄线更是随便就过——
    // 三道护栏一道都拦不住，直接递归删掉在跑的工作树。
    // 白名单让这条路根本走不到：遗留 worktree 名字不在项目 id 里，整个跳过。
    const allowed = new Set(knownProjectIds.map((s) => (s || '').trim()).filter(Boolean));
    if (allowed.size === 0) return out; // 拿不到项目清单就不对账，宁可不清也不误删
    let projects: fs.Dirent[];
    try {
      projects = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return out; // base 不存在 = 没什么可对账的
    }
    for (const proj of projects) {
      // isDirectory() 走 lstat 语义：顶层若是符号链接一律不认（只认真实项目桶）
      if (!proj.isDirectory()) continue;
      if (!allowed.has(proj.name)) continue;
      const projDir = path.posix.join(base, proj.name);
      let slugs: fs.Dirent[];
      try {
        slugs = fs.readdirSync(projDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const slug of slugs) {
        if (!slug.isDirectory()) continue;
        const full = path.posix.join(projDir, slug.name);
        try {
          out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          // stat 失败 → 给一个「刚刚」的时间戳，纯函数据此判为过新并跳过
          out.push({ path: full, mtimeMs: Number.NaN });
        }
      }
    }
    return out;
  },
  listMountedHostPaths: async () => {
    // 必须走 docker inspect，不能走 docker ps（2026-07-28 生产实测定位）：
    // `docker ps --format` 里的 .Mounts 是**逗号分隔的字符串**，对它 `{{range}}`
    // 会让 Go 模板报错 → 整条命令非零退出 → 这里返回 null → 对账降级成只报不删。
    // 生产第一轮就是这样：找到 66 个孤儿目录、一个都没敢删（护栏起作用了，
    // 但功能等于没生效）。inspect 的 .Mounts 才是真正的数组。
    const ids = await execDocker(['ps', '-aq'], 60_000);
    if (ids.startsWith('__ERR__')) return null;
    const idList = ids.split('\n').map((l) => l.trim()).filter(Boolean);
    if (idList.length === 0) return [];
    const paths: string[] = [];
    // 分批，避免容器多时超出单条命令的参数长度上限
    for (let i = 0; i < idList.length; i += 100) {
      const batch = idList.slice(i, i + 100);
      const r = await execDockerDetailed(
        // 用 {{println}} 而不是 {{"\\n"}}：后者在 TS 单引号串里 \\n 会被转义成**真正的
        // 换行**塞进 Go 模板的引号内，模板解析直接失败（unterminated quoted string），
        // docker 非零退出且**无任何输出** —— 生产上挂载枚举一直返回 null 的真凶。
        // println 不需要引号，从根上避开这一类转义坑。
        ['inspect', '--format', '{{range .Mounts}}{{println .Source}}{{end}}', ...batch], 60_000,
      );
      // 非零退出**不代表查不到**：只要有一个 id 在 ps 与 inspect 之间消失，docker 就
      // 整体非零，但找得到的那些照样打了出来。而消失的容器本就不可能挂着任何目录，
      // 忽略它完全安全。真正危险的是「一条都没查到却当成没人挂载」——那种情况下
      // stdout 为空，下面按失败处理返回 null，调用方整轮只报不删。
      //（生产实测：容器持续增删，此前恒定走 null 分支，孤儿回收一直停在 0/66。）
      if (!r.ok && !r.stdout) return null;
      for (const line of r.stdout.split('\n')) {
        const t = line.trim();
        if (t) paths.push(t);
      }
    }
    return paths;
  },
  removeDir: async (dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  },
};

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
    /** 孤儿 worktree 对账摘要。null = 本次未执行。 */
    orphanWorktrees: { removed: number; failed: number; deferred: number } | null;
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
    /** 孤儿 worktree 对账所需的磁盘读写（可注入以便测试，不真的碰磁盘）。 */
    private readonly orphanWorktreeFs: OrphanWorktreeFs = defaultOrphanWorktreeFs,
  ) {}

  /**
   * 孤儿 worktree 对账：磁盘上的 `<base>/<项目>/<分支>` 目录 vs 台账里分支声明的
   * worktreePath，差集即孤儿（判定与护栏见 orphan-worktree.ts）。
   */
  private async runOrphanWorktreeReconcile(): Promise<NonNullable<JanitorSweepReport['orphanWorktrees']>> {
    // 只在**已知项目桶**下枚举：顶层的遗留扁平 worktree 不是桶，不许往里走（见
    // defaultOrphanWorktreeFs.listWorktreeDirs 注释里的迁移布局说明）。
    //
    // 「已知」= 在册项目 + 已删项目的墓碑（Codex PR #1275 三轮 P2）。删项目会 cascade
    // 掉项目与分支记录却**不删磁盘目录**，若只认在册项目，被删项目那个桶从此再也进不去，
    // 里面已经无人认领的 worktree 永久占盘 —— 而它们恰恰是最该回收的。
    const liveProjectIds = this.stateService.getProjects().map((p) => p.id).filter(Boolean);
    const tombstones = this.stateService.getDeletedProjectWorktreeBuckets();
    const knownProjectIds = [...new Set([...liveProjectIds, ...tombstones.map((t) => t.projectId)])];
    const diskDirs = await this.orphanWorktreeFs.listWorktreeDirs(this.worktreeBase, knownProjectIds);
    const claimedPaths = this.stateService.getAllBranches()
      .map((b) => b.worktreePath)
      .filter((p): p is string => !!p);
    const mountedPaths = await this.orphanWorktreeFs.listMountedHostPaths();
    // 查不到挂载占用 = 本轮不删（只报不删）：删一个还被容器挂着的目录，那个容器
    // 当场瞎掉，代价远大于晚一轮回收。
    const maxRemovals = mountedPaths === null
      ? 0
      : (this.config.orphanWorktreeMaxRemovalsPerSweep ?? DEFAULT_ORPHAN_WORKTREE_MAX_REMOVALS);
    const plan: OrphanWorktreePlan = computeOrphanWorktreePlan({
      diskDirs,
      claimedPaths,
      mountedPaths: mountedPaths ?? [],
      nowMs: this.clock.now(),
      maxRemovals,
    });
    const removed: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const dir of plan.remove) {
      const err = await this.orphanWorktreeFs.removeDir(dir);
      if (err) failed.push({ path: dir, error: err }); else removed.push(dir);
    }
    // 已删项目的桶清空了就摘墓碑：桶里一个 worktree 都不剩，就没必要再让对账进去。
    // 判据用「本轮枚举到的目录」而不是另跑一次 readdir —— 少一次磁盘往返，也避免
    // 两次读之间的竞态。删失败的目录仍算「还在」，墓碑留到下一轮继续。
    if (tombstones.length) {
      const stillThere = new Set<string>();
      const removedSet = new Set(removed);
      for (const d of diskDirs) {
        if (removedSet.has(normalizeWorktreePath(d.path))) continue;
        const rel = normalizeWorktreePath(d.path).slice(normalizeWorktreePath(this.worktreeBase).length + 1);
        const bucket = rel.split('/')[0];
        if (bucket) stillThere.add(bucket);
      }
      for (const t of tombstones) {
        if (!stillThere.has(t.projectId)) {
          this.stateService.removeDeletedProjectWorktreeBucket(t.projectId);
        }
      }
    }
    return { removed, failed, keptReasons: plan.keptReasons, deferred: plan.deferred };
  }

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
          orphanWorktrees: report.orphanWorktrees
            ? {
              removed: report.orphanWorktrees.removed.length,
              failed: report.orphanWorktrees.failed.length,
              deferred: report.orphanWorktrees.deferred,
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
      orphanWorktrees: null,
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

    // 1.4 回收互斥（2026-07-27 复盘 P2）：下面三步（悬空清理 / per-SHA 镜像回收 /
    //     孤儿 worktree）都是真实的磁盘与 docker daemon 动作。CDS 侧任何路径同一时刻
    //     只允许一个在跑；拿不到锁就**跳过本轮**，不排队堆积——回收是周期性的，
    //     等下一轮就行，排队只会把几轮压在一起，在磁盘最紧张时制造更大的 IO 尖峰。
    //     注意这把锁管不到宿主上的人：人工 docker prune 仍会撞车，那要靠运维手册的
    //     安全命令 + cds.protected 标记来兜。
    const reclaimed = await reclaimLock.run('janitor.sweep', async () => {
      await this.runReclaimSteps(report);
      return true;
    });
    if (isReclaimSkip(reclaimed)) {
      report.errors.push(
        `回收被跳过：${reclaimed.heldBy} 正在回收（已持有 ${Math.round(reclaimed.heldForMs / 1000)}s），本轮跳过不排队`,
      );
      console.warn(`[janitor] 回收被跳过：${reclaimed.heldBy} 正在回收，本轮跳过`);
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

  /** 回收三件套（悬空清理 / per-SHA 镜像回收 / 孤儿 worktree），由回收锁串起来。 */
  private async runReclaimSteps(report: JanitorSweepReport): Promise<void> {
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

    // 1.65 孤儿 worktree 对账（2026-07-27 宕机复盘 P2）。
    //      与 TTL 清理互补：TTL 只看得见台账里还有记录的分支，磁盘上「目录还在、
    //      台账里没有」的 worktree 从来没人管——事故当天 45.5GB 就攒在这里。
    //      与 enabled 解耦（同 dockerPrune）：那个开关管的是「删台账里的过期分支」，
    //      而孤儿目录已经不属于任何分支，删它不涉及用户的分支资产。
    if (this.config.orphanWorktrees !== false) {
      try {
        report.orphanWorktrees = await this.runOrphanWorktreeReconcile();
        const o = report.orphanWorktrees;
        if (o.removed.length || o.deferred || o.failed.length) {
          console.log(
            `[janitor] 孤儿 worktree 对账：删除 ${o.removed.length} 个`
            + (o.deferred ? `，本轮上限截断 ${o.deferred} 个待下轮` : '')
            + (o.failed.length ? `，失败 ${o.failed.length} 个` : ''),
          );
        }
        for (const f of o.failed) report.errors.push(`orphan worktree rm ${f.path}: ${f.error}`);
      } catch (err) {
        report.errors.push(`orphan worktree reconcile: ${(err as Error).message}`);
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
