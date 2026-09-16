/**
 * 「今天要」到底指哪一刻 —— DuePicker 与 dueParse 共用一份，避免两处各写各的。
 *
 * 这本日历是**团队日历（东八区）**，不是浏览器所在时区的日历。后端判逾期、
 * 归当天用的是 `ActiveTaskConclusion.TeamDate`（同样东八区），两边必须翻同一本：
 * 上一版按浏览器本地日历算，人在美西点一下「今天」，落到后端就成了团队的明天。
 *
 * 表示法只有两种，不许混：
 * - **坐标 Date**：它的 *UTC* 年月日就是团队本地的年月日，时分秒为零。日期加减、
 *   比较、画月历一律用它，全程走 `getUTC*`，不碰 `getFullYear`/`getDate` 这些本地读数。
 * - **真实瞬间**：只有 `endOfDay` 把坐标换算成它，也只有它能 `toISOString()` 发给后端。
 */

/** 团队日历相对 UTC 的偏移，与后端 `ActiveTaskConclusion.TeamUtcOffset` 同一个值 */
export const TEAM_UTC_OFFSET_MINUTES = 8 * 60;
const OFFSET_MS = TEAM_UTC_OFFSET_MINUTES * 60_000;

/** 某个真实瞬间落在团队日历的哪一天 → 坐标 Date。不传就是「团队日历的今天」 */
export function teamDay(instant: Date = new Date()): Date {
  const shifted = new Date(instant.getTime() + OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** 按团队日历的年月日直接造一个坐标（month 从 0 起，day 给 0 即上个月最后一天） */
export function teamDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/** 坐标 Date 加减天数 */
export function addDays(coord: Date, days: number): Date {
  const x = new Date(coord.getTime());
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

/** 坐标 Date 的星期几（0 = 周日） */
export function weekdayOf(coord: Date): number { return coord.getUTCDay(); }
/** 坐标 Date 的年 */
export function yearOf(coord: Date): number { return coord.getUTCFullYear(); }
/** 坐标 Date 的月（从 0 起） */
export function monthOf(coord: Date): number { return coord.getUTCMonth(); }
/** 坐标 Date 的日 */
export function dayOf(coord: Date): number { return coord.getUTCDate(); }

/**
 * 坐标 Date → 真实瞬间：团队日历当天 18:00（「今天要」指今天下班前，不是此刻）。
 * 但如果那一刻已经过去，落上去等于当场生成一个过去的时间、任务刚建出来就被判逾期 ——
 * 这种情况退到当天 23:59。
 */
export function endOfDay(coord: Date, now: Date = new Date()): Date {
  const at = (h: number, mi: number) => new Date(
    Date.UTC(coord.getUTCFullYear(), coord.getUTCMonth(), coord.getUTCDate(), h, mi) - OFFSET_MS,
  );
  const six = at(18, 0);
  if (six.getTime() <= now.getTime() && isSameDay(coord, teamDay(now))) return at(23, 59);
  return six;
}

/** 两个坐标 Date 是不是团队日历的同一天 */
export function isSameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

/** 坐标 Date → yyyy-MM-dd（团队日历） */
export function dayKey(coord: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${coord.getUTCFullYear()}-${p(coord.getUTCMonth() + 1)}-${p(coord.getUTCDate())}`;
}
