/**
 * ISO 8601 周序（周一为一周之始，含本年第一个周四的那一周记为第 1 周）。
 *
 * 首页工位的日期条、以及任何要展示「第 N 周」的地方都读这一份，
 * 避免各写一套导致同一天在两个页面显示不同周数。
 */
export function isoWeekNumber(date: Date): number {
  // 只取年月日，避免时区/夏令时把日期挪到隔天
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // 先挪到本周周四：ISO 用「周四归属的年份」界定这一周属于哪一年
  const dayIdx = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayIdx + 3);

  // 该年 1 月 4 日必定落在第 1 周，同样挪到它那一周的周四作基准
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayIdx = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayIdx + 3);

  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}
