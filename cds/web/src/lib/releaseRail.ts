/**
 * 主干提交流水轴的**展示判定**（纯函数，可单测）。
 *
 * 后端 release-commit-rail 负责算「main 最近几个提交」「每个环境落在哪、落后几个」；
 * 这里只负责把那份数据翻译成屏幕上的东西：轴上哪个点该插旗、那句「落后 4 个提交」
 * 该怎么说。之所以放前端：文案判定与 releaseEta / releaseDora 同一个编译边界，
 * web 的 tsconfig 只 include web/src，没有 web → src 的 import 通道。
 *
 * 唯一要守住的规矩与后端一致：**算不出就说算不出，绝不退化成 0**。
 * behindCount === 0 的含义是「与主干齐平」，那是个很强的结论；
 * 把「本地仓库读不到」显示成齐平，比不显示更糟。
 */

export interface ReleaseCommitRailNode {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt: string;
}

export interface ReleaseCommitRail {
  branch: string;
  ref: string;
  nodes: ReleaseCommitRailNode[];
  refsAsOf?: string;
  unavailableReason?: string;
}

export interface ReleaseTargetCommitPosition {
  commitSha: string;
  behindCount: number | null;
  aheadCount: number | null;
  oldestUnreleasedAt?: string;
  inRail: boolean;
  reason?: string;
}

export type PositionTone = 'ok' | 'warn' | 'unknown';

export interface PositionDescription {
  text: string;
  tone: PositionTone;
}

export function sameCommit(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

export function describeCommitPosition(
  position: ReleaseTargetCommitPosition | undefined,
  branch: string,
): PositionDescription {
  const branchLabel = branch || '主干';
  if (!position || !position.commitSha) {
    return { text: '还没有发布过版本', tone: 'unknown' };
  }
  const { behindCount, aheadCount } = position;
  if (behindCount === null && aheadCount === null) {
    return { text: `无法与 ${branchLabel} 比较${position.reason ? `：${position.reason}` : ''}`, tone: 'unknown' };
  }
  const behind = behindCount ?? 0;
  const ahead = aheadCount ?? 0;
  if (behind > 0 && ahead > 0) {
    return { text: `与 ${branchLabel} 已分叉：落后 ${behind} 个、领先 ${ahead} 个提交`, tone: 'warn' };
  }
  if (behind > 0) return { text: `落后 ${branchLabel} ${behind} 个提交`, tone: 'warn' };
  if (ahead > 0) return { text: `领先 ${branchLabel} ${ahead} 个提交`, tone: 'warn' };
  return { text: `与 ${branchLabel} 齐平`, tone: 'ok' };
}

export function formatRelativeFromNow(value: string | undefined, nowMs: number): string {
  if (!value) return '';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const deltaMs = nowMs - ts;
  if (deltaMs < 0) return '刚刚';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月`;
  return `${Math.floor(months / 12)} 年`;
}

/** 「5 天前」这种带后缀的说法，列表里直接用。 */
export function formatAgo(value: string | undefined, nowMs: number): string {
  const relative = formatRelativeFromNow(value, nowMs);
  if (!relative) return '';
  return relative === '刚刚' ? relative : `${relative}前`;
}
