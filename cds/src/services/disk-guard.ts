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
class DiskGuardState {
  private tier: DiskTier = 'ok';
  private usedPercent: number | null = null;
  private updatedAt: string | null = null;

  update(usedPercent: number | null, thresholds?: DiskTierThresholds): DiskTier {
    this.usedPercent = typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? usedPercent : null;
    this.tier = classifyDiskTier(this.usedPercent, thresholds);
    this.updatedAt = new Date().toISOString();
    return this.tier;
  }

  get(): { tier: DiskTier; usedPercent: number | null; updatedAt: string | null } {
    return { tier: this.tier, usedPercent: this.usedPercent, updatedAt: this.updatedAt };
  }

  /** 部署派发前调用；返回非 null 表示应当拒绝，值即给用户的理由。 */
  blockReasonForDeploy(): string | null {
    if (!shouldFreezeDeploys(this.tier)) return null;
    return describeDiskTier(this.tier, this.usedPercent);
  }

  /** 测试用：复位。 */
  reset(): void {
    this.tier = 'ok';
    this.usedPercent = null;
    this.updatedAt = null;
  }
}

export const diskGuard = new DiskGuardState();
