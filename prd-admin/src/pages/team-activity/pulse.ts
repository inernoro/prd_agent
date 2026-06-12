/**
 * 团队动态「脉搏」纯函数工具：
 * - 隐私脱敏（标题 / 姓名打码）
 * - 连续同类动作聚合折叠（治「同一个人刷屏 N 条相同动态」）
 * - 小时直方图 UTC → 本地时区旋转
 * 全部为纯函数，可被 vitest 直接断言。
 */
import type { TeamActivityItem } from '@/services/contracts/teamActivity';

// 中圆点比星号安静：脱敏后的标题应该「读得出被隐藏」而不是「像系统乱码」
const MASK = '···';

/** 标题脱敏：保留首（尾）字，中间打码。空串原样返回。 */
export function maskTitle(text: string): string {
  const chars = Array.from(text.trim());
  if (chars.length === 0) return '';
  if (chars.length === 1) return `${chars[0]}*`;
  if (chars.length <= 3) return `${chars[0]}${MASK}`;
  return `${chars[0]}${MASK}${chars[chars.length - 1]}`;
}

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
