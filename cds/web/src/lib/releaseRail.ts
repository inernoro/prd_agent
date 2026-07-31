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

/** 轴上的一面旗：某个环境停在这个提交。 */
export interface RailMarker {
  targetId: string;
  /** 中文环境标签，如「生产」。后端 environments[].label 给的就是它。 */
  label: string;
  environment: string;
  commitSha: string;
}

export interface RailNodeView extends ReleaseCommitRailNode {
  markers: RailMarker[];
}

export type PositionTone = 'ok' | 'warn' | 'unknown';

export interface PositionDescription {
  text: string;
  tone: PositionTone;
}

/** 整条轴是否该渲染。不可用时隐藏整块，不留一个空壳骨架。 */
export function railIsVisible(rail?: ReleaseCommitRail | null): rail is ReleaseCommitRail {
  return Boolean(rail && !rail.unavailableReason && Array.isArray(rail.nodes) && rail.nodes.length > 0);
}

/** 短 sha 与全 sha 混用是常态（后端给全的，run 里可能是短的），前缀比对即可。 */
export function sameCommit(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * 给每个轴节点挂上停在它上面的环境旗。
 * 不在轴上的环境不会凭空生出一个节点——它由左栏那一行如实说明「不在最近这几个提交里」。
 */
export function buildRailNodeViews(
  rail: ReleaseCommitRail,
  markers: ReadonlyArray<RailMarker>,
): RailNodeView[] {
  return rail.nodes.map((node) => ({
    ...node,
    markers: markers.filter((marker) => sameCommit(node.sha, marker.commitSha)),
  }));
}

/** 有旗但没落在轴上的环境（跑着一个太老或已分叉的版本）。 */
export function markersOffRail(
  rail: ReleaseCommitRail,
  markers: ReadonlyArray<RailMarker>,
): RailMarker[] {
  return markers.filter((marker) => !rail.nodes.some((node) => sameCommit(node.sha, marker.commitSha)));
}

/**
 * 「落后 main 4 个提交」这句话。
 * 分叉时 behind / ahead 同时非零是合法状态，必须两个都说，不能只报一个。
 */
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

/** 「最早未上线提交距今 18 小时」。没有这个字段就整句不出现。 */
export function describeOldestUnreleased(
  position: ReleaseTargetCommitPosition | undefined,
  nowMs: number,
): string {
  const at = position?.oldestUnreleasedAt;
  if (!at) return '';
  const relative = formatRelativeFromNow(at, nowMs);
  return relative ? `最早未上线提交距今 ${relative}` : '';
}

/**
 * 相对时间（中文，粗粒度）。取不到有效时间返回空串——
 * 让调用方决定「整句不显示」，而不是显示一个 "Invalid Date"。
 */
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
