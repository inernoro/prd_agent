import { execSync } from 'node:child_process';

/**
 * 磁盘分档刹车（2026-07-27 宕机复盘 P0）。
 *
 * 事故：根盘从 80% 一路涨到 100%，全程只有 janitor 每小时打一行 `console.warn`，
 * 没有任何一处会因为「快满了」而少做点什么——直到 CDS 自用 mongo 写不进
 * diagnostic.data 退出、master 反复启动失败、全站 502 三十五分钟。
 *
 * 本模块把「磁盘余量」变成**可判定的档位**，并让部署派发在最高档上真正踩刹车。
 * 判定是纯函数，便于把「多少算危险」这件事写成回归测试而不是散在日志里。
 *
 * 档位语义（阈值可配，默认取事故复盘建议值）：
 *   ok       < 75%   正常
 *   notice   >= 75%  提示：回收该主动一点（janitor 缩短镜像保留代数）
 *   reclaim  >= 85%  主动回收：本轮 sweep 立刻做深度回收
 *   freeze   >= 90%  冻结：拒绝新的构建/部署派发，优先把空间抢回来
 *
 * 冻结只挡「会写入大量数据的新任务」（构建/部署），不挡读操作、不挡停止/删除
 * 这类**释放**空间的操作——否则磁盘满的时候连自救都做不了。
 */

export type DiskTier = 'ok' | 'notice' | 'reclaim' | 'freeze';

export interface DiskTierThresholds {
  notice: number;
  reclaim: number;
  freeze: number;
}

export const DEFAULT_DISK_TIERS: DiskTierThresholds = { notice: 75, reclaim: 85, freeze: 90 };

/**
 * 把磁盘使用率归到档位。非法输入（NaN / 负数 / 读不到）一律返回 'ok'——
 * 探测失败不该把整个平台冻住（fail-open），真出问题有 janitor 的告警兜底。
 */
export function classifyDiskTier(
  usedPercent: number | null | undefined,
  thresholds: DiskTierThresholds = DEFAULT_DISK_TIERS,
): DiskTier {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) return 'ok';
  if (usedPercent >= thresholds.freeze) return 'freeze';
  if (usedPercent >= thresholds.reclaim) return 'reclaim';
  if (usedPercent >= thresholds.notice) return 'notice';
  return 'ok';
}

/** 该档位下是否应拒绝新的构建/部署派发。 */
export function shouldFreezeDeploys(tier: DiskTier): boolean {
  return tier === 'freeze';
}

/**
 * 该档位下镜像保留代数（每个服务保留最近几代镜像）。越紧张留得越少，
 * 但**永不为 0**：当前跑的那代由「在用镜像」单独护住，这里保证还留得下一次回滚。
 */
export function imageKeepGenerationsFor(tier: DiskTier, base = 5): number {
  switch (tier) {
    case 'freeze': return 1;
    case 'reclaim': return 2;
    case 'notice': return 3;
    default: return base;
  }
}

/**
 * 该档位下单轮最多回收几个镜像。
 *
 * 2026-07-27 生产实测：首轮 sweep 删 40 个、**积压 4598 个**——按固定 40/轮、
 * 每小时一轮要跑五天才能消化完存量，等于「在跑」但追不上。回收强度必须随磁盘
 * 压力放大：越紧张删得越猛。上限仍存在（单轮 rmi 是串行的，不能把一次 sweep
 * 拖成小时级，也不该长时间占住 docker daemon）。
 */
export function imageMaxRemovalsFor(tier: DiskTier, base = 40): number {
  switch (tier) {
    case 'freeze': return Math.max(base, 400);
    case 'reclaim': return Math.max(base, 200);
    case 'notice': return Math.max(base, 100);
    default: return base;
  }
}

/** 给用户看的一句话（冻结时会原样出现在部署被拒的响应里）。 */
export function describeDiskTier(tier: DiskTier, usedPercent: number | null): string {
  const pct = typeof usedPercent === 'number' ? `${Math.round(usedPercent)}%` : '未知';
  switch (tier) {
    case 'freeze':
      return `宿主磁盘已用 ${pct}，已冻结新的构建与部署派发以避免写满根盘（写满会导致 CDS 自身数据库退出、全站不可用）。请先回收空间：CDS 系统设置的清理入口，或联系管理员清理镜像与过期分支。停止/删除类操作不受影响。`;
    case 'reclaim':
      return `宿主磁盘已用 ${pct}，已进入主动回收档：本轮清理会缩短镜像保留代数。`;
    case 'notice':
      return `宿主磁盘已用 ${pct}，接近警戒线，回收强度已上调。`;
    default:
      return `宿主磁盘已用 ${pct}。`;
  }
}

/**
 * 进程内的磁盘档位持有者：janitor 每次 sweep 写入，部署派发读取。
 * 单例而非 DI，是因为读取方（部署路由、webhook 派发器）散布很广，
 * 且这是「只读一个瞬时事实」的场景，不值得为它穿一层依赖。
 */
type DiskUsageReading = { totalBytes: number; freeBytes: number };
/** 可返回单个挂载点，也可返回多个（如 worktree + docker 数据目录），取最紧张的一个。 */
export type DiskUsageProbe = () => DiskUsageReading | DiskUsageReading[] | null;

/** 读数被认为「新鲜」的时长；超过则在被问到时就地重测（见 blockReasonForDeploy）。 */
export const DISK_READING_TTL_MS = 60_000;

class DiskGuardState {
  private tier: DiskTier = 'ok';
  private usedPercent: number | null = null;
  private updatedAt: string | null = null;
  private updatedAtMs = 0;
  private probe: DiskUsageProbe | null = null;

  /**
   * 注册就地探测（Codex 第二十八轮 P1）。
   *
   * 只靠 janitor 每小时一次的 sweep 写档位有两个致命窗口：① 进程刚重启时档位是
   * 未初始化的 'ok'，而「刚因为磁盘满而重启」正是最危险的时刻；② janitor 的 TTL
   * 清理被关掉时根本没有周期 sweep。注册探测后，部署闸门在读数过期或缺失时会
   * 自己测一次——刹车不再依赖 janitor 的配置与节奏。
   */
  setProbe(probe: DiskUsageProbe | null): void {
    this.probe = probe;
  }

  /**
   * 就地重测并刷新档位；无探测器或探测失败时保持现状（fail-open）。
   *
   * 探测器可以返回**多个挂载点**（Codex 第二十九轮 P2）：worktree 与 docker 数据目录
   * 常常不在同一个文件系统上，而镜像层、容器可写层、state mongo 卷全都落在 docker
   * 那一侧——2026-07-27 事故里撑爆的正是 containerd（159GB）。只量 worktree 会在
   * docker 盘已经 95% 时报「一切正常」，闸门恰好在该拦的时候放行。取**最紧张的那个**。
   */
  refreshNow(thresholds?: DiskTierThresholds): DiskTier {
    if (!this.probe) return this.tier;
    try {
      const raw = this.probe();
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      let worst: number | null = null;
      for (const usage of list) {
        if (!usage || !usage.totalBytes) continue;
        const pct = Math.round(((usage.totalBytes - usage.freeBytes) / usage.totalBytes) * 100);
        if (worst === null || pct > worst) worst = pct;
      }
      if (worst === null) return this.tier;
      return this.update(worst, thresholds);
    } catch {
      return this.tier;
    }
  }

  /**
   * 有探测器就按探测器（多挂载点取最紧张者）刷新，没有才用调用方给的读数兜底。
   *
   * janitor 的 sweep 只量 worktree（它本来就是为 worktree TTL 设计的），若直接
   * `update(worktree%)` 会把探测器算出的「worst-of 多文件系统」结果**覆盖掉**
   * （Codex 第三十轮 P1）：docker 盘已经到冻结线、worktree 还很空时，每一轮 sweep
   * 都会把闸门重新打开，直到 60s TTL 过期才恢复；同一轮的镜像回收也会按低压档位
   * 执行，该抢救的时候反而回收得最少。
   */
  refreshOrUpdate(fallbackUsedPercent: number | null, thresholds?: DiskTierThresholds): DiskTier {
    if (this.probe) return this.refreshNow(thresholds);
    return this.update(fallbackUsedPercent, thresholds);
  }

  update(usedPercent: number | null, thresholds?: DiskTierThresholds): DiskTier {
    this.usedPercent = typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? usedPercent : null;
    this.tier = classifyDiskTier(this.usedPercent, thresholds);
    this.updatedAt = new Date().toISOString();
    this.updatedAtMs = Date.now();
    return this.tier;
  }

  get(): { tier: DiskTier; usedPercent: number | null; updatedAt: string | null } {
    return { tier: this.tier, usedPercent: this.usedPercent, updatedAt: this.updatedAt };
  }

  /**
   * 部署派发前调用；返回非 null 表示应当拒绝，值即给用户的理由。
   *
   * 读数缺失或超过 TTL 时**先就地重测**（Codex 第二十八轮 P1）：进程刚重启时
   * 档位还是初始的 'ok'，而那恰恰是「刚被磁盘满打死、正在恢复」的窗口；janitor
   * 被关掉时更是永远没有周期 sweep。刹车必须自带测量能力，不能依赖别人来喂。
   */
  blockReasonForDeploy(): string | null {
    if (this.probe && (this.updatedAtMs === 0 || Date.now() - this.updatedAtMs > DISK_READING_TTL_MS)) {
      this.refreshNow();
    }
    if (!shouldFreezeDeploys(this.tier)) return null;
    return describeDiskTier(this.tier, this.usedPercent);
  }

  /** 测试用：复位。 */
  reset(): void {
    this.tier = 'ok';
    this.usedPercent = null;
    this.updatedAt = null;
    this.updatedAtMs = 0;
    this.probe = null;
  }
}

/**
 * docker 数据目录（`docker info -f {{.DockerRootDir}}`），带进程内缓存。
 *
 * 该值一个进程生命周期内不会变，且 `docker info` 有可观开销，故只探一次；
 * 拿不到（docker 不可用 / 权限不足）时返回 null，调用方退回只量 worktree。
 * 常见默认 `/var/lib/docker`；containerd 存储通常与之同一文件系统。
 */
let cachedDockerRoot: string | null | undefined;
export function resolveDockerDataRoot(execSyncFn?: (cmd: string) => string): string | null {
  if (cachedDockerRoot !== undefined) return cachedDockerRoot;
  try {
    const run = execSyncFn ?? ((cmd: string) => execSync(cmd, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const out = String(run('docker info -f "{{.DockerRootDir}}"') || '').trim();
    cachedDockerRoot = out && out !== '<no value>' ? out : null;
  } catch {
    cachedDockerRoot = null;
  }
  return cachedDockerRoot;
}

/** 测试用：清掉 docker 数据目录缓存。 */
export function resetDockerDataRootCache(): void {
  cachedDockerRoot = undefined;
}

export const diskGuard = new DiskGuardState();
