/**
 * 团队动态「脉搏」纯函数工具：
 * - 姓名脱敏（业界惯例：对象标题全文显示，隐私保护只作用于「人」）
 * - 连续同类动作聚合折叠（治「同一个人刷屏 N 条相同动态」，对标 GitHub "pushed 5 commits"）
 * - 小时直方图 UTC → 本地时区旋转
 * - 平滑面积曲线 SVG path（Catmull-Rom 转 Bezier，活跃时段图用）
 * 全部为纯函数，可被 vitest 直接断言。
 */
import type { TeamActivityItem } from '@/services/contracts/teamActivity';

/** 姓名脱敏：保留首字 + 两位掩码（周泽腾 → 周**）。 */
export function maskName(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return '';
  return `${chars[0]}**`;
}

export type AggregatedActivity = {
  /** 渲染 key，取首条 id */
  id: string;
  /** 代表条目（最新一条，列表按时间倒序） */
  head: TeamActivityItem;
  /** 折叠条数 */
  count: number;
  /** 去重后的目标标题（最多保留 3 个，超出由 count 体现） */
  titles: string[];
};

/**
 * 把按时间倒序排列的动态流中「连续的 同人 + 同模块 + 同动作」折叠为一条。
 * 仅折叠相邻条目，跨越其他人的动作不合并（保持时间线语义）。
 */
export function aggregateConsecutive(items: TeamActivityItem[]): AggregatedActivity[] {
  const out: AggregatedActivity[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    const sameRun =
      last &&
      last.head.actorId === item.actorId &&
      last.head.module === item.module &&
      last.head.action === item.action;
    if (sameRun) {
      last.count += 1;
      const title = item.targetTitle?.trim();
      if (title && !last.titles.includes(title) && last.titles.length < 3) {
        last.titles.push(title);
      }
      continue;
    }
    const title = item.targetTitle?.trim();
    out.push({ id: item.id, head: item, count: 1, titles: title ? [title] : [] });
  }
  return out;
}

/**
 * 把 UTC 小时直方图旋转到本地时区（整小时时区精确，半小时时区取整近似）。
 * @param hourlyUtc 长度 24 的 UTC 小时计数
 * @param tzOffsetMinutes 东向偏移分钟数（UTC+8 = 480）。缺省取浏览器时区。
 */
export function rotateHourlyToLocal(hourlyUtc: number[], tzOffsetMinutes?: number): number[] {
  const offset = tzOffsetMinutes ?? -new Date().getTimezoneOffset();
  const offsetHours = Math.round(offset / 60);
  const out = new Array<number>(24).fill(0);
  for (let local = 0; local < 24; local++) {
    const utc = ((local - offsetHours) % 24 + 24) % 24;
    out[local] = hourlyUtc[utc] ?? 0;
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 把一组数值变成平滑面积曲线的 SVG path（Catmull-Rom 转 Bezier）。
 * 返回 line（描边用）与 area（渐变填充用，闭合到底边）。
 * 控制点 y 做 clamp，避免尖峰数据的插值过冲越出画布。
 */
export function smoothAreaPath(
  values: number[],
  width: number,
  height: number,
  pad = 2
): { line: string; area: string } {
  const n = values.length;
  if (n === 0) return { line: '', area: '' };
  const max = Math.max(1, ...values);
  const usable = height - pad * 2;
  const yOf = (v: number) => round2(height - pad - (v / max) * usable);
  const xOf = (i: number) => round2(n === 1 ? width / 2 : (i * width) / (n - 1));
  const clampY = (y: number) => Math.min(height, Math.max(0, round2(y)));

  const pts = values.map((v, i) => [xOf(i), yOf(v)] as const);
  let line = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const c1x = round2(p1[0] + (p2[0] - p0[0]) / 6);
    const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = round2(p2[0] - (p3[0] - p1[0]) / 6);
    const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
    line += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  const area = `${line} L ${round2(width)},${height} L ${pts[0][0]},${height} Z`;
  return { line, area };
}
